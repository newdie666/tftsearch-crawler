import { runCrawl, parseTiers } from "./runCrawl";
import { getDb, closeDb } from "./db";
import type { Platform } from "./lib/riotClient";
import { createLimiterPool } from "./lib/riotClient";
import { readLimits } from "./config";
async function main() {
  const apiKey = process.env.RIOT_API_KEY;
  if (!apiKey) throw new Error("RIOT_API_KEY required");
  const platforms = [...new Set((process.env.CRAWL_PLATFORMS ?? "vn2,kr,na1,euw1").split(",").map(x => x.trim()))];
  if (platforms.some(x => !["vn2","kr","na1","euw1"].includes(x))) throw new Error("Unsupported platform");
  const { dailyLimit, ...limits } = readLimits(process.env);
  const db = await getDb();
  await db.execute("SELECT match_id, packed, patch, game_patch FROM matches LIMIT 0");
  await db.execute("SELECT puuid, game_name, tag_line, platform, updated_at FROM known_players LIMIT 0");
  await db.execute("SELECT patch, set_number, label, released_at FROM patch_versions LIMIT 0");
  await db.execute("SELECT platform, patch, cutover_at FROM patch_cutovers LIMIT 0");
  // One count per serialized job. Includes other collectors' inserts conservatively.
  // No table/schema change is needed; midnight during a run can only stop it early.
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86_400_000);
  const count = await db.execute({ sql: "SELECT COUNT(*) AS n FROM matches WHERE fetched_at >= ? AND fetched_at < ?",
    args: [start.toISOString(), end.toISOString()] });
  const dailyBudget = { remaining: Math.max(0, dailyLimit - Number(count.rows[0].n)) };
  const limiterPool = createLimiterPool();
  console.log(JSON.stringify({ dailyLimit, dailyRemaining: dailyBudget.remaining, ...limits }));
  let failed = false;
  for (const platform of platforms) {
    try {
      const result = await runCrawl({ apiKey, platform: platform as Platform, tiers: parseTiers(process.env.CRAWL_TIERS ?? "challenger,grandmaster"), ...limits, dailyBudget, limiterPool });
      console.log(JSON.stringify(result));
      if (result.fetched === 0 && (result.failedRequests > 0 || result.rateLimited > 0 || result.serverErrors > 0)) failed = true;
    } catch { failed = true; console.error("Crawl failed for " + platform + "; inspect credentials, schema and API availability."); }
  }
  if (failed) process.exitCode = 1;
}
main().catch(() => { console.error("Crawler preflight failed; verify secrets and existing ETL schema."); process.exitCode = 1; }).finally(closeDb);
