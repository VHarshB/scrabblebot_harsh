import { test } from "node:test";
import assert from "node:assert/strict";
import { mayBid, reconnectDelay, tournamentId } from "./lifecycle.js";
test("expired, closed and duplicate auctions are skipped", () => {
  const seen = new Set(["m:1"]);
  assert.equal(mayBid(seen, "m:1", "Open", 2000000n, 1000), false);
  assert.equal(mayBid(seen, "m:2", "Closed", 2000000n, 1000), false);
  assert.equal(mayBid(seen, "m:2", "Open", 1000000n, 1000), false);
  assert.equal(mayBid(seen, "m:2", "Open", 2000000n, 1000), true);
});
test("disconnect retry is bounded", () => {
  assert.deepEqual(
    [0, 1, 9, 1000].map(reconnectDelay),
    [1000, 2000, 30000, 30000],
  );
});
test("tournament IDs cannot silently truncate", () => {
  assert.equal(tournamentId(undefined), undefined);
  assert.equal(tournamentId("123"), 123n);
  for (const s of ["0", "-1", "1.2", "abc"])
    assert.throws(() => tournamentId(s));
});
