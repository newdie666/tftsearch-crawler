import type { Client } from "@libsql/client";
import { getDb } from "./db";
import { extractPatch } from "./extractPatch";
import { patchAt, loadPatchVersions } from "./lib/livePatch";
import { platformFromMatchId } from "./lib/matchPlatform";
import { RiotClient, RiotApiError, createLimiterPool, accountRegionForPlatform, regionForPlatform, type Platform } from "./lib/riotClient";
import { packMatch } from "./lib/matchPayload";
import { CrawlBudget, BudgetExceeded } from "./budget";

export type LeagueTier = "challenger" | "grandmaster" | "master";
const TIERS: LeagueTier[] = ["challenger", "grandmaster", "master"];
export function parseTiers(value?: string | null): LeagueTier[] {
  const selected = (value ?? "").split(",").map(v => v.trim().toLowerCase());
  const tiers = TIERS.filter(t => selected.includes(t));
  return tiers.length ? tiers : ["challenger"];
}
export interface RunCrawlOptions {
  apiKey: string;
  platform: Platform;
  tiers: LeagueTier[];
  queue?: string;
  /** Target successfully inserted matches, not candidate IDs. */
  limit: number;
  matchesPerPlayer?: number;
  budgetMs?: number;
  maxRequests?: number;
  maxCandidates?: number;
  maxPlayers?: number;
  dailyBudget?: { remaining: number };
  limiterPool?: ReturnType<typeof createLimiterPool>;
  onLog?: (message: string) => void;
  ensureSchema?: boolean;
}
type CrawlClient = Pick<RiotClient, "getLeague" | "getMatchIdsByPuuid" | "getMatch" | "getAccountByPuuid">;
export interface CrawlDependencies {
  db?: Client;
  client?: CrawlClient;
  loadPatches?: typeof loadPatchVersions;
  orderPlayers?: <T>(items: readonly T[]) => T[];
}
function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function fatal(error: unknown) {
  return error instanceof BudgetExceeded || (error instanceof RiotApiError && [401, 403].includes(error.status));
}

/** This collector never migrates schema or triggers website regeneration. */
export async function runCrawl(opts: RunCrawlOptions, deps: CrawlDependencies = {}) {
  const { platform, tiers, queue = "RANKED_TFT", limit, matchesPerPlayer = 5 } = opts;
  const budget = new CrawlBudget(opts.budgetMs ?? 180_000, opts.maxRequests ?? 150);
  const client = deps.client ?? new RiotClient(opts.apiKey, undefined, budget, opts.limiterPool);
  const db = deps.db ?? await getDb();
  const region = regionForPlatform(platform);
  const daily = opts.dailyBudget ?? { remaining: Number.MAX_SAFE_INTEGER };
  const maxCandidates = opts.maxCandidates ?? 300, maxPlayers = opts.maxPlayers ?? 60;
  const seen = new Set<string>();
  let playersFound = 0, scannedPlayers = 0, fetched = 0, skippedExisting = 0;
  let failedRequests = 0, namesResolved = 0, stopReason = "players_exhausted";
  const queueCounts: Record<string, number> = {};
  let oldestGameDatetime: number | null = null, newestGameDatetime: number | null = null;
  const result = () => ({ platform, region, playersFound, scannedPlayers, candidateMatchIds: seen.size,
    fetched, skippedExisting, failedRequests, namesResolved, stopReason,
    queueCounts, oldestGameDatetime, newestGameDatetime,
    attempts: budget.attempts, rateLimited: budget.rateLimited, serverErrors: budget.serverErrors,
    elapsedMs: Date.now() - budget.startedAt });
  if (daily.remaining <= 0) { stopReason = "daily_limit"; return result(); }
  try {
    const byPuuid = new Map<string, Awaited<ReturnType<CrawlClient["getLeague"]>>["entries"][number]>();
    for (const tier of tiers) {
      budget.check();
      for (const entry of (await client.getLeague(platform, tier, queue)).entries) byPuuid.set(entry.puuid, entry);
    }
    const entries = [...byPuuid.values()];
    playersFound = entries.length;
    // Patch discovery/backfill belongs to ETL; only read the existing windows here.
    const windows = await (deps.loadPatches ?? loadPatchVersions)(db);
    const players = (deps.orderPlayers ?? shuffle)(entries);
    outer: for (const entry of players) {
      budget.check();
      if (fetched >= limit) { stopReason = "target_reached"; break; }
      if (daily.remaining <= 0) { stopReason = "daily_limit"; break; }
      if (seen.size >= maxCandidates) { stopReason = "candidate_limit"; break; }
      if (scannedPlayers >= maxPlayers) { stopReason = "player_limit"; break; }
      scannedPlayers++;
      let ids: string[];
      try { ids = await client.getMatchIdsByPuuid(region, entry.puuid, matchesPerPlayer); }
      catch (error) { if (fatal(error)) throw error; failedRequests++; continue; }
      const batch: string[] = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        if (seen.size >= maxCandidates) break;
        seen.add(id); batch.push(id);
      }
      if (!batch.length) continue;
      budget.check();
      const existing = await db.execute({
        sql: `SELECT match_id FROM matches WHERE match_id IN (${batch.map(() => "?").join(",")})`, args: batch,
      });
      const existingIds = new Set(existing.rows.map(r => String(r.match_id)));
      skippedExisting += existingIds.size;
      for (const matchId of batch) {
        if (existingIds.has(matchId)) continue;
        budget.check();
        if (fetched >= limit) { stopReason = "target_reached"; break outer; }
        if (daily.remaining <= 0) { stopReason = "daily_limit"; break outer; }
        let match: { info?: { queue_id?: number; game_version?: string; game_datetime?: number; tft_set_number?: number } };
        try { match = await client.getMatch(region, matchId) as typeof match; }
        catch (error) { if (fatal(error)) throw error; failedRequests++; continue; }
        budget.check();
        const info = match.info ?? {};
        const inserted = await db.execute({
          sql: `INSERT OR IGNORE INTO matches (match_id, region, queue_id, game_version, game_datetime, raw_json, packed, fetched_at, patch, game_patch)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [matchId, region, info.queue_id ?? null, info.game_version ?? null, info.game_datetime ?? null,
            "", packMatch(match), new Date().toISOString(), extractPatch(info.game_version ?? null, info.tft_set_number ?? null),
            patchAt(windows, info.game_datetime ?? null, platformFromMatchId(matchId))],
        });
        if (inserted.rowsAffected > 0) {
          fetched++; daily.remaining--;
          const queueKey = String(info.queue_id ?? "unknown");
          queueCounts[queueKey] = (queueCounts[queueKey] ?? 0) + 1;
          if (typeof info.game_datetime === "number" && Number.isFinite(info.game_datetime)) {
            oldestGameDatetime = Math.min(oldestGameDatetime ?? info.game_datetime, info.game_datetime);
            newestGameDatetime = Math.max(newestGameDatetime ?? info.game_datetime, info.game_datetime);
          }
        } else skippedExisting++;
      }
    }
    if (daily.remaining <= 0) stopReason = "daily_limit";
    else if (fetched >= limit) stopReason = "target_reached";
    else if (seen.size >= maxCandidates) stopReason = "candidate_limit";
    else if (scannedPlayers >= maxPlayers && scannedPlayers < players.length) stopReason = "player_limit";
    // Optional name lookup uses only the remaining budget, after match collection.
    if (fetched > 0 && daily.remaining > 0 && budget.remainingMs() > 1000) {
      try {
        budget.check();
        const top = [...entries].sort((a, b) => b.leaguePoints - a.leaguePoints).slice(0, 150);
        if (top.length) {
          const known = await db.execute({ sql: `SELECT puuid FROM known_players WHERE puuid IN (${top.map(() => "?").join(",")})`, args: top.map(e => e.puuid) });
          const have = new Set(known.rows.map(r => String(r.puuid)));
          for (const entry of top.filter(e => !have.has(e.puuid)).slice(0, 20)) {
            budget.check();
            try {
              const account = await client.getAccountByPuuid(accountRegionForPlatform(platform), entry.puuid);
              budget.check();
              if (!account.gameName || !account.tagLine) continue;
              await db.execute({ sql: `INSERT INTO known_players (puuid, game_name, tag_line, platform, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(puuid) DO UPDATE SET game_name=excluded.game_name, tag_line=excluded.tag_line, updated_at=excluded.updated_at`,
                args: [account.puuid, account.gameName, account.tagLine, platform, new Date().toISOString()] });
              namesResolved++;
            } catch (error) { if (fatal(error)) throw error; failedRequests++; }
          }
        }
      } catch (error) { if (!(error instanceof BudgetExceeded)) throw error; }
    }
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    stopReason = error.reason;
  }
  const summary = result();
  opts.onLog?.(JSON.stringify(summary));
  return summary;
}
export type RunCrawlResult = Awaited<ReturnType<typeof runCrawl>>;
