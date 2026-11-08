import { readFileSync, writeFileSync } from "node:fs";
import {
  chooseWord,
  decideBid,
  engine,
  LETTER_VALUE,
  reward,
} from "./strategy.js";
import { DEFAULT_BAG } from "./letters.js";
const dictionary = readFileSync(
  new URL("../../spacetimedb/wordlist.txt", import.meta.url),
  "utf8",
)
  .trim()
  .toUpperCase()
  .split(/\r?\n/);
const e = engine(dictionary);
const count = Number(process.env.SIM_MATCHES ?? 30);
const start = performance.now();
function game(seed: number, scale: number, self: boolean) {
  const prices: number[] = [];
  let state = seed;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const bag = DEFAULT_BAG.flatMap(([c, n]) => Array<string>(n).fill(c));
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  const bots = Array.from({ length: 6 }, () => ({
    rack: new Map<string, number>(),
    balance: 100,
    score: 0,
  }));
  for (const b of bots)
    for (let i = 0; i < 5; i++) {
      const c = bag.pop()!;
      b.rack.set(c, (b.rack.get(c) ?? 0) + 1);
    }
  const cash = (i: number, remaining: number) => {
    const b = bots[i];
    for (let k = 0; k < 20; k++) {
      const w =
        i === 0 || self
          ? chooseWord({
              myRack: b.rack,
              dictionary,
              remaining,
              myBalance: b.balance,
            })
          : e
              .playable(b.rack)
              .slice()
              .sort((a, b) => b.word.length - a.word.length)[0]?.word;
      if (!w) break;
      for (const c of w) b.rack.set(c, b.rack.get(c)! - 1);
      b.balance += reward(w);
      b.score += reward(w);
    }
  };
  while (bag.length) {
    const c = bag.pop()!;
    for (let i = 0; i < 6; i++) cash(i, bag.length);
    const bids = bots
      .map((b, i) => ({
        i,
        tie: random(),
        amount:
          i === 0 || self
            ? decideBid({
                letter: c,
                myBalance: b.balance,
                myRack: b.rack,
                dictionary,
                remaining: bag.length,
                bidScale: i === 0 ? scale : 1.8,
                clearingPrice:
                  prices.reduce((s, p) => s + p, 0) / (prices.length || 1),
              })
            : Math.max(
                0,
                Math.min(
                  b.balance,
                  i === 1
                    ? LETTER_VALUE[c] + (b.rack.get(c) ? 0 : 2)
                    : LETTER_VALUE[c] +
                        (i === 2
                          ? -1
                          : i === 3
                            ? "AEIOU".includes(c)
                              ? 4
                              : 2
                            : 0) +
                        Math.floor(random() * 5) -
                        2,
                ),
              ),
      }))
      .filter((x) => x.amount > 0)
      .sort((a, b) => b.amount - a.amount || a.tie - b.tie);
    if (bids[0]) {
      const b = bots[bids[0].i];
      b.balance -= bids[1]?.amount ?? 1;
      prices.push(bids[1]?.amount ?? 1);
      if (prices.length > 20) prices.shift();
      b.rack.set(c, (b.rack.get(c) ?? 0) + 1);
      if (bag.length) cash(bids[0].i, bag.length);
    }
  }
  const me = bots[0];
  return {
    score: me.score,
    place: 1 + bots.filter((b) => b.score > me.score).length,
    win: me.score === Math.max(...bots.map((b) => b.score)) ? 1 : 0,
    left: [...me.rack.values()].reduce((a, b) => a + b, 0),
    balance: me.balance,
  };
}
const results = [];
const samples = new Map<string, number[]>();
for (const self of [false, true])
  for (const scale of [1.2, 1.8, 2.4]) {
    const rows = Array.from({ length: count }, (_, i) =>
      game(1000 + i, scale, self),
    );
    const avg = (k: keyof (typeof rows)[number]) =>
      rows.reduce((s, r) => s + r[k], 0) / count;
    samples.set(
      `${self}:${scale}`,
      rows.map((r) => r.score),
    );
    results.push({
      field: self ? "self" : "mixed",
      scale,
      matches: count,
      winRate: avg("win"),
      score: avg("score"),
      placement: avg("place"),
      leftover: avg("left"),
      balance: avg("balance"),
    });
    console.log(results.at(-1));
  }
const paired = [false, true].flatMap((self) =>
  [1.2, 2.4].map((scale) => {
    const base = samples.get(`${self}:1.8`)!;
    const differences = samples
      .get(`${self}:${scale}`)!
      .map((s, i) => s - base[i]);
    const mean = differences.reduce((s, n) => s + n, 0) / count;
    const variance =
      differences.reduce((s, n) => s + (n - mean) ** 2, 0) / (count - 1);
    const margin = 1.96 * Math.sqrt(variance / count);
    return {
      field: self ? "self" : "mixed",
      scale,
      baseline: 1.8,
      scoreDifference: mean,
      confidence95: [mean - margin, mean + margin],
    };
  }),
);
writeFileSync(
  new URL("../benchmark.json", import.meta.url),
  JSON.stringify(
    {
      seed: 1000,
      runtimeMs: performance.now() - start,
      results,
      paired,
      limitations:
        "No network latency; mixed opponents approximate official policies; private initial racks; final winning tile cannot be played; ties counted as wins.",
    },
    null,
    2,
  ),
);
