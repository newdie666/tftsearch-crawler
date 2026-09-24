# TFT crawler
Standalone scheduled Riot TFT collector. Website and ETL source are not included.

## Activate
1. Create a new repository and upload ONLY the contents of this directory as its root. Do not upload the parent repository, its history, .env files or database files.
2. Add repository Actions secrets: RIOT_API_KEY, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN.
3. Run Crawl TFT manually, verify each platform summary and new matches in Turso.
4. Keep all old cron-job.org jobs stopped. Leave ETL in the private repository enabled.

Schedule: every two hours at minute 23 UTC, four regions sequentially. Scheduled Actions may be delayed. Public repository schedules can be disabled after inactivity; monitor Actions. Free standard-runner pricing is not a guarantee of unlimited service; review GitHub Actions terms for your intended workload.

Uses the existing Turso schema managed by the private ETL. Never migrates schema. Preserves packed match format, patch mapping, deduplication, and name backfill. Existing per-region 25-second crawl budget is retained. A successful run with zero new matches can be normal; persistent zeros need investigation. No production HTTP warming or revalidation is performed here. Public logs contain aggregate counts only.

Source sync: copied from scripts/crawler/runCrawl.ts and scripts/lib in the private project; keep fixes synchronized. Secrets remain in Actions settings, never source. Public Actions logs and artifacts must not contain raw data or credentials.
