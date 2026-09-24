import { runCrawl, parseTiers } from "./runCrawl";
import { getDb, closeDb } from "./db";
import type { Platform } from "./lib/riotClient";
async function main() {
  const apiKey = process.env.RIOT_API_KEY;
  if (!apiKey) throw new Error("RIOT_API_KEY required");
  const platforms = (process.env.CRAWL_PLATFORMS ?? "vn2,kr,na1,euw1").split(",").map(x => x.trim());
  if (platforms.some(x => !["vn2","kr","na1","euw1"].includes(x))) throw new Error("Unsupported platform");
  const limit = Number(process.env.CRAWL_LIMIT ?? "40");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("CRAWL_LIMIT must be 1..100");
  const db = await getDb();
  await db.execute("SELECT match_id, packed, patch, game_patch FROM matches LIMIT 0");
  await db.execute("SELECT puuid, game_name, tag_line, platform, updated_at FROM known_players LIMIT 0");
  await db.execute("SELECT patch, set_number, label, released_at FROM patch_versions LIMIT 0");
  await db.execute("SELECT platform, patch, cutover_at FROM patch_cutovers LIMIT 0");
  let failed = false;
  for (const platform of platforms) {
    try {
      const result = await runCrawl({ apiKey, platform: platform as Platform, tiers: parseTiers(process.env.CRAWL_TIERS ?? "challenger,grandmaster"), limit, ensureSchema: false, onLog: () => {} });
      console.log(JSON.stringify(result));
    } catch { failed = true; console.error("Crawl failed for " + platform + "; inspect credentials, schema and API availability."); }
  }
  if (failed) process.exitCode = 1;
}
main().catch(() => { console.error("Crawler preflight failed; verify secrets and existing ETL schema."); process.exitCode = 1; }).finally(closeDb);
