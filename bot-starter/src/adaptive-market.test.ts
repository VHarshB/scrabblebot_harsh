import { test } from "node:test";
import assert from "node:assert/strict";
import { AdaptiveMarket } from "./adaptive-market.js";
test("market targets use observed public prices and reject junk", () => {
  const m = new AdaptiveMarket();
  assert.equal(m.target("A"), 0);
  for (const p of [8, 10, 12]) m.observe("A", p);
  m.observe("A", NaN);
  m.observe("?", 100);
  assert.equal(m.target("A"), 11);
});
test("match learning is idempotent and bounded", () => {
  const m = new AdaptiveMarket();
  for (let i = 0; i < 50; i++) {
    const result = {
      matchId: String(i),
      score: 30,
      balance: 60,
      placement: 6,
      players: 6,
    };
    assert.equal(m.complete(result), true);
    assert.equal(m.complete(result), false);
  }
  assert.equal(m.state.scale, 1.25);
  assert.equal(m.state.matches.length, 30);
});

test("replayed auction observations do not change market estimates", () => {
  const m = new AdaptiveMarket();
  m.observe("A", 10, "12");
  m.observe("A", 30, "12");
  assert.deepEqual(m.state.prices.A, [10]);
});
