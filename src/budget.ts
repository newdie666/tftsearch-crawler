export type BudgetStop = "time_budget" | "request_budget";

export class BudgetExceeded extends Error {
  constructor(public readonly reason: BudgetStop) { super(reason); }
}

/** One budget covers every HTTP attempt, limiter wait and retry for a platform. */
export class CrawlBudget {
  readonly startedAt: number;
  readonly deadline: number;
  attempts = 0;
  rateLimited = 0;
  serverErrors = 0;
  constructor(readonly durationMs: number, readonly maxAttempts: number, private readonly now = Date.now) {
    this.startedAt = now();
    this.deadline = this.startedAt + durationMs;
  }
  check() {
    if (this.now() >= this.deadline) throw new BudgetExceeded("time_budget");
  }
  checkRequest() {
    this.check();
    if (this.attempts >= this.maxAttempts) throw new BudgetExceeded("request_budget");
  }
  takeAttempt() { this.checkRequest(); this.attempts++; }
  remainingMs() { return Math.max(0, this.deadline - this.now()); }
  async sleep(ms: number) {
    this.checkRequest();
    if (ms >= this.remainingMs()) throw new BudgetExceeded("time_budget");
    await new Promise(resolve => setTimeout(resolve, ms));
    this.checkRequest();
  }
}
