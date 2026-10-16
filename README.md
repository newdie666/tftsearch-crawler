# TFT crawler
Standalone scheduled Riot TFT collector. Website and ETL source are not included.

## Activate
1. Create a new repository and upload ONLY the contents of this directory as its root. Do not upload the parent repository, its history, .env files or database files.
2. Add repository Actions secrets: RIOT_API_KEY, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN.
3. Run Crawl TFT manually, verify each platform summary and new matches in Turso.
4. Keep all old cron-job.org jobs stopped. Leave ETL in the private repository enabled.

Schedule: hourly at minute 23 UTC, four regions sequentially, matching the live repository schedule. Scheduled Actions may be delayed or dropped; hourly configuration does not guarantee 24 runs/day. Public repository schedules can be disabled after inactivity; monitor Actions. Free standard-runner pricing is not a guarantee of unlimited service; review GitHub Actions terms for your intended workload.

Uses the existing Turso schema managed by the private ETL. Never migrates schema. Preserves packed match format, patch mapping, deduplication, and name backfill. Patch windows are read from the existing tables; private ETL owns discovery and backfill. No production HTTP warming or revalidation is performed here. Public logs contain aggregate counts only, with no account identifiers or credential-bearing URLs.

## Collection limits

| Setting | Default / hard maximum |
| --- | --- |
| `CRAWL_LIMIT` | 100 successfully inserted matches per platform/run |
| `CRAWL_BUDGET_MS` | 180000 ms per platform; HTTP waits and retries share this deadline |
| `CRAWL_MAX_REQUESTS` | 150 Riot HTTP attempts per platform, including retries/name lookup |
| `CRAWL_MAX_CANDIDATES` | 300 distinct candidate IDs per platform |
| `CRAWL_MAX_PLAYERS` | 60 players examined per platform |
| `CRAWL_DAILY_LIMIT` | 3000 new matches per UTC day across all platforms |

All settings can be reduced, but values above these maxima or malformed values fail preflight. Existing matches are checked in batches; duplicate candidates cause the collector to examine more players until a ceiling is reached. Only successful inserts count toward the target. Name lookup runs last and shares the remaining budget. HTTP requests time out after at most 15 seconds; individual DB HTTP calls also have a 15-second timeout. A DB operation already in flight can finish beyond the collection deadline. The workflow has a 20-minute safety timeout.

The daily allowance is initialized from `matches.fetched_at` once per job and shared across platforms, including partial progress before an error. Keep workflow concurrency at one and old collectors stopped: independent writers are not atomically coordinated by this cap. A run crossing midnight may stop conservatively until the next run recalculates the allowance.

Each platform summary includes `fetched`, `skippedExisting`, `scannedPlayers`, `candidateMatchIds`, `failedRequests`, `attempts`, `rateLimited`, `serverErrors`, `elapsedMs`, `stopReason`, `queueCounts`, `oldestGameDatetime` and `newestGameDatetime` (epoch milliseconds for inserted matches). Empty runs with no errors can be normal; authentication failures or empty runs with request failures fail the workflow. A partial run can succeed and expose its failed-request count for investigation. Production credentials are never loaded by the test suite.

## Offline validation and rollout

Run `npm ci`, `npm run check` and `npm test` in this directory. Tests use injected fake clients and mock HTTP, never real Riot/Turso services. Merely publishing this directory to the private website repository does not update the separate live crawler repository. To update that repository, copy only this directory's contents as its root, including tests and workflow, review the diff, and then push when authorized. Do not copy the parent repository/history, `.env` or database files.

After rollout, inspect naturally scheduled runs before requesting any manual crawl: compare actual runs/day, new matches/platform/run, duplicate share, stop reasons, 429s, and Turso read/write usage. Do not claim the daily cap is guaranteed production. If scheduled runs remain sparse, investigate a separately authorized external scheduler rather than adding production HTTP warming.

Rollback to the previous crawler commit; do not delete valid matches already collected. ETL frequency remains three times daily. The legacy collector in `scripts/crawler` is not deployed by this standalone workflow; its Vercel-era behavior is intentionally not raised to the standalone budget. Secrets remain in Actions settings, never source.
