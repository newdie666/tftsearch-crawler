type Settings = Record<string, string | undefined>;

export function integerSetting(env: Settings, name: string, fallback: number, max: number) {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function readLimits(env: Settings) {
  return {
    limit: integerSetting(env, "CRAWL_LIMIT", 100, 100),
    budgetMs: integerSetting(env, "CRAWL_BUDGET_MS", 180_000, 180_000),
    maxRequests: integerSetting(env, "CRAWL_MAX_REQUESTS", 150, 150),
    maxCandidates: integerSetting(env, "CRAWL_MAX_CANDIDATES", 300, 300),
    maxPlayers: integerSetting(env, "CRAWL_MAX_PLAYERS", 60, 60),
    dailyLimit: integerSetting(env, "CRAWL_DAILY_LIMIT", 3000, 3000),
  };
}
