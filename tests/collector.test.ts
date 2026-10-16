import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "@libsql/client";
import { runCrawl, type CrawlDependencies, type RunCrawlOptions } from "../src/runCrawl";
import { readLimits } from "../src/config";
import { RiotApiError } from "../src/lib/riotClient";

const options: RunCrawlOptions = { apiKey: "offline-test", platform: "vn2", tiers: ["challenger"], limit: 3 };
function fixture(histories: string[][], existing: string[] = [], races: string[] = []) {
  const stored = new Set(existing);
  const players = histories.map((_, i) => ({ puuid: String(i), leaguePoints: 1, wins: 1, losses: 1, rank: "I" }));
  let leagueCalls = 0, detailCalls = 0;
  const deps: CrawlDependencies = {
    orderPlayers: items => [...items], loadPatches: async () => [],
    db: { execute: async (query: { sql: string; args: string[] }) => {
      if (query.sql.startsWith("SELECT match_id")) return { rows: query.args.filter(id => stored.has(id)).map(match_id => ({ match_id })) };
      if (query.sql.startsWith("SELECT puuid")) return { rows: players.map(p => ({ puuid: p.puuid })) };
      assert.match(query.sql, /^INSERT OR IGNORE INTO matches/);
      const id = query.args[0];
      if (races.includes(id)) stored.add(id);
      const changed = !stored.has(id);
      stored.add(id);
      return { rowsAffected: changed ? 1 : 0, rows: [] };
    } } as unknown as Client,
    client: {
      getLeague: async () => { leagueCalls++; return { entries: players, leagueId: "test", tier: "CHALLENGER", name: "test", queue: "RANKED_TFT" }; },
      getMatchIdsByPuuid: async (_region, id) => histories[Number(id)],
      getMatch: async () => { detailCalls++; return { info: { queue_id: 1100, tft_set_number: 18, game_datetime: 1792070000000, participants: [] } }; },
      getAccountByPuuid: async () => { throw new Error("Unexpected optional lookup"); },
    },
  };
  return { deps, stored, calls: () => ({ leagueCalls, detailCalls }) };
}

test("refills after 90% duplicate candidates rather than stopping at the first batch", async () => {
  const old = Array.from({ length: 27 }, (_, i) => `old${i}`);
  const histories = [0, 1, 2].map(i => [...old.slice(i * 9, i * 9 + 9), `new${i}`]);
  const f = fixture(histories, old);
  const result = await runCrawl(options, f.deps);
  assert.equal(result.fetched, 3);
  assert.equal(result.skippedExisting, 27);
  assert.equal(result.scannedPlayers, 3);
  assert.equal(result.stopReason, "target_reached");
  assert.equal(f.calls().detailCalls, 3);
});
test("stops at the insertion target with no duplicates", async () => {
  const f = fixture([["a", "b", "c", "d", "e"]]);
  const result = await runCrawl(options, f.deps);
  assert.equal(result.fetched, 3);
  assert.deepEqual(result.queueCounts, { "1100": 3 });
  assert.equal(result.oldestGameDatetime, 1792070000000);
  assert.equal(result.newestGameDatetime, 1792070000000);
  assert.equal(f.calls().detailCalls, 3);
});
test("INSERT OR IGNORE races do not count toward successful inserts", async () => {
  const f = fixture([["race", "a"], ["b", "c"]], [], ["race"]);
  const result = await runCrawl(options, f.deps);
  assert.equal(result.fetched, 3);
  assert.equal(result.skippedExisting, 1);
  assert.equal(result.scannedPlayers, 2);
});
test("shared daily allowance stops this platform and prevents calls on the next", async () => {
  const dailyBudget = { remaining: 1 };
  const f = fixture([["a", "b"]]);
  assert.equal((await runCrawl({ ...options, dailyBudget }, f.deps)).fetched, 1);
  const calls = f.calls();
  const next = await runCrawl({ ...options, dailyBudget, platform: "kr" }, f.deps);
  assert.equal(next.stopReason, "daily_limit");
  assert.deepEqual(f.calls(), calls);
});
test("candidate and player ceilings bound repeated existing histories", async () => {
  const f = fixture([["a", "b"], ["c"]], ["a", "b", "c"]);
  assert.equal((await runCrawl({ ...options, maxCandidates: 2 }, f.deps)).stopReason, "candidate_limit");
  assert.equal((await runCrawl({ ...options, maxPlayers: 1 }, f.deps)).stopReason, "player_limit");
});
test("expired budget avoids external requests", async () => {
  const f = fixture([["a"]]);
  assert.equal((await runCrawl({ ...options, budgetMs: 0 }, f.deps)).stopReason, "time_budget");
  assert.equal(f.calls().leagueCalls, 0);
});
test("authentication failure is not swallowed as a successful empty run", async () => {
  const f = fixture([["a"]]);
  f.deps.client!.getMatch = async () => { throw new RiotApiError(403, "test"); };
  await assert.rejects(runCrawl(options, f.deps), /test/);
});
test("unsafe configuration is rejected before production clients are used", () => {
  assert.equal(readLimits({}).dailyLimit, 3000);
  for (const raw of ["", "NaN", "0", "-1", "101", "2.5"]) {
    assert.throws(() => readLimits({ CRAWL_LIMIT: raw }));
  }
  assert.throws(() => readLimits({ CRAWL_DAILY_LIMIT: "3001" }));
});
