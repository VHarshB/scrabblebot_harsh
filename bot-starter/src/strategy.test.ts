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
