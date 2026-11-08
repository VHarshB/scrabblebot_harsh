import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { chooseWord, decideBid, engine, reward } from "./strategy.js";
export const rack = (s: string) => {
  const r = new Map<string, number>();
  for (const c of s) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};
test("exact integer scoring", () => {
  assert.equal(reward("QUIZ"), 33);
  assert.equal(reward("CAT"), 5);
});
test("empty, repeats and invalid words", () => {
  const dictionary = ["TACT", "CAT", "AT", "BAD!"];
  assert.equal(chooseWord({ myRack: rack(""), dictionary }), null);
  assert.equal(chooseWord({ myRack: rack("CAT"), dictionary }), "CAT");
  assert.equal(chooseWord({ myRack: rack("TACT"), dictionary }), "TACT");
  assert.equal(chooseWord({ myRack: rack("CX"), dictionary }), null);
});
test("partition beats largest single reward", () => {
  assert.equal(
    engine(["QUIZ", "AT", "QI", "ZA"]).partition(rack("QUIZAT")).score,
    35,
  );
});
test("hold and liquidity", () => {
  const c = { myRack: rack("CAT"), dictionary: ["CAT"], remaining: 30 };
  assert.equal(chooseWord(c), null);
  assert.equal(chooseWord({ ...c, myBalance: 0 }), "CAT");
});
test("bounded bids including zero and Q without U", () => {
  for (const myBalance of [0, 1, 10, 100])
    for (const letter of ["Q", "U", "A"]) {
      const b = decideBid({ letter, myBalance, myRack: rack("QQQ") });
      assert.ok(Number.isInteger(b) && b >= 0 && b <= myBalance);
    }
  assert.equal(decideBid({ letter: "?", myBalance: 100, myRack: rack("") }), 0);
});
test("warm dictionary search below deadline", () => {
  const d = readFileSync(
    new URL("../../spacetimedb/wordlist.txt", import.meta.url),
    "utf8",
  )
    .trim()
    .toUpperCase()
    .split(/\r?\n/);
  const e = engine(d);
  const start = performance.now();
  for (let i = 0; i < 26; i++)
    e.playable(rack("BCDFGHJKLMNPQRSTVWXZ" + String.fromCharCode(65 + i)));
  assert.ok((performance.now() - start) / 26 < 100);
});

test("rollout valuation is deterministic and respects the auction budget", () => {
  const dictionary = ["CATER", "CATERED", "CART", "RATE", "RATED", "TREAD"];
  const e = engine(dictionary);
  const r = rack("CART");
  assert.equal(e.marginalValue(r, "E", 40), e.marginalValue(r, "E", 40));
  for (const myBalance of [0, 1, 12, 100]) {
    const b = decideBid({ letter: "E", myBalance, myRack: r, dictionary });
    assert.ok(Number.isInteger(b) && b >= 0 && b <= myBalance);
  }
});
test("final auction cannot yield playable letters", () => {
  assert.equal(
    decideBid({
      letter: "T",
      myBalance: 100,
      myRack: rack("CA"),
      dictionary: ["CAT"],
      remaining: 0,
      endgameAggression: true,
    }),
    0,
  );
  assert.equal(
    decideBid({
      letter: "Z",
      myBalance: 100,
      myRack: rack("CA"),
      dictionary: ["CAT"],
      remaining: 1,
      endgameAggression: true,
    }),
    0,
  );
});
test("partition always returns a valid first word even when bounded", () => {
  const dictionary = ["AA", "AT", "CAT", "TACT", "ACT"];
  const r = rack("AAAATTACT");
  const result = engine(dictionary).partition(r);
  assert.ok(result.word && dictionary.includes(result.word));
  assert.ok(result.score >= 5);
});

test("rollout bidding stays below the one-second deadline on ordinary and large racks", () => {
  const dictionary = readFileSync(
    new URL("../../spacetimedb/wordlist.txt", import.meta.url),
    "utf8",
  )
    .trim()
    .split(/\r?\n/);
  engine(dictionary);
  let worst = 0;
  for (const letters of ["AEIRST", "BCCDGHJKLMNPQRSTVWXZ", "AAEEIINORST"])
    for (const letter of ["A", "E", "Q", "R", "S", "T"]) {
      const begin = performance.now();
      decideBid({
        letter,
        myRack: rack(letters),
        myBalance: 100,
        dictionary,
        remaining: 30,
      });
      worst = Math.max(worst, performance.now() - begin);
    }
  console.log(`Worst rollout decision: ${worst.toFixed(2)} ms`);
  assert.ok(worst < 250, `decision exceeded 250 ms: ${worst}`);
});
