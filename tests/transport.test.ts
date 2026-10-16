import assert from "node:assert/strict";
import { test } from "node:test";
import { CrawlBudget, BudgetExceeded } from "../src/budget";
import { RiotClient, createLimiterPool } from "../src/lib/riotClient";

test("request quota counts attempts before starting another HTTP request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json([]); };
  try {
    const client = new RiotClient("offline", undefined, new CrawlBudget(1000, 1));
    await client.getMatchIdsByPuuid("sea", "fake");
    await assert.rejects(client.getMatchIdsByPuuid("sea", "fake"), BudgetExceeded);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test("the last allowed response can still be processed without allowing another attempt", () => {
  const budget = new CrawlBudget(1000, 1);
  budget.takeAttempt();
  assert.doesNotThrow(() => budget.check());
  assert.throws(() => budget.takeAttempt(), BudgetExceeded);
});
test("long Retry-After does not exceed remaining time or issue a retry", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("", { status: 429, headers: { "Retry-After": "3600" } }); };
  try {
    const budget = new CrawlBudget(1000, 150);
    await assert.rejects(new RiotClient("offline", undefined, budget).getMatch("sea", "fake"), BudgetExceeded);
    assert.equal(calls, 1);
    assert.equal(budget.rateLimited, 1);
  } finally { globalThis.fetch = original; }
});
test("hung HTTP requests are aborted at the shared deadline", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const start = Date.now();
    await assert.rejects(new RiotClient("offline", undefined, new CrawlBudget(40, 150)).getMatch("sea", "fake"));
    assert.ok(Date.now() - start < 1000);
  } finally { clearInterval(keepAlive); globalThis.fetch = original; }
});
test("shared host limiter survives the next platform client", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json([]); };
  try {
    const pool = createLimiterPool();
    await new RiotClient("offline", { perSecond: 1 }, new CrawlBudget(1000, 150), pool).getMatch("asia", "fake");
    const next = new RiotClient("offline", { perSecond: 1 }, new CrawlBudget(40, 150), pool);
    await assert.rejects(next.getMatch("asia", "fake"), BudgetExceeded);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test("retries after server errors consume the same request allowance", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("", { status: 503 }); };
  try {
    const budget = new CrawlBudget(5000, 1);
    await assert.rejects(new RiotClient("offline", undefined, budget).getMatch("sea", "fake"), BudgetExceeded);
    assert.equal(calls, 1);
    assert.equal(budget.serverErrors, 1);
  } finally { globalThis.fetch = original; }
});
