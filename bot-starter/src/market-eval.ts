import { AdaptiveMarket } from "./adaptive-market.js";
import { readFileSync, writeFileSync } from "node:fs";
import * as old from "./rollout-v2-strategy.js";
import * as next from "./strategy.js";
import { DEFAULT_BAG } from "./letters.js";
const dictionary = readFileSync(
  new URL("../../spacetimedb/wordlist.txt", import.meta.url),
  "utf8",
)
  .trim()
  .toUpperCase()
  .split(/\r?\n/);
const N = Number(process.env.EVAL_MATCHES ?? 20);
const configurations: {
  name: string;
  legacy?: boolean;
  scale: number;
  weight: number;
  horizon?: number;
  partitionPreference?: boolean;
  endgameAggression?: boolean;
  samples?: number;
  marketMultiplier?: number;
}[] = [
  { name: "v2", legacy: true, scale: 1.8, weight: 0.5 },
  {
    name: "liquidity-fix",
    scale: 1.8,
    weight: 0.5,
    horizon: 6,
    endgameAggression: true,
  },
  {
    name: "market-08",
    scale: 1.8,
    weight: 0.5,
    horizon: 6,
    endgameAggression: true,
    marketMultiplier: 0.8,
  },
  {
    name: "market-10",
    scale: 1.8,
    weight: 0.5,
    horizon: 6,
    endgameAggression: true,
    marketMultiplier: 1,
  },
  {
    name: "market-12",
    scale: 1.8,
    weight: 0.5,
    horizon: 6,
    endgameAggression: true,
    marketMultiplier: 1.2,
  },
];
function game(
  seed: number,
  config: (typeof configurations)[number],
  field: string,
) {
  const market = new AdaptiveMarket();
  let state = seed;
  const random = () =>
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  const bag = DEFAULT_BAG.flatMap(([c, n]) => Array<string>(n).fill(c));
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  const bots = Array.from({ length: 6 }, () => ({
    rack: new Map<string, number>(),
    score: 0,
    balance: 100,
  }));
  const seat = seed % 6;
  for (const b of bots)
    for (let k = 0; k < 5; k++) {
      const c = bag.pop()!;
      b.rack.set(c, (b.rack.get(c) ?? 0) + 1);
    }
  const prices: number[] = [];
  const cash = (i: number, remaining: number) => {
    const b = bots[i];
    for (let k = 0; k < 20; k++) {
      const context = {
        myRack: b.rack,
        dictionary,
        remaining,
        myBalance: b.balance,
        partitionPreference: i === seat ? config.partitionPreference : false,
      };
      const legacy = i === seat ? config.legacy : field === "legacy";
      const word = (legacy ? old.chooseWord : next.chooseWord)(context);
      if (!word) break;
      for (const c of word) b.rack.set(c, b.rack.get(c)! - 1);
      b.score += next.reward(word);
      b.balance += next.reward(word);
    }
  };
  while (bag.length) {
    const letter = bag.pop()!;
    for (let i = 0; i < 6; i++) cash(i, bag.length);
    const bids = bots
      .map((b, i) => {
        const context = {
          letter,
          myRack: b.rack,
          myBalance: b.balance,
          dictionary,
          remaining: bag.length,
          clearingPrice:
            prices.reduce((s, n) => s + n, 0) / (prices.length || 1),
        };
        let bid: number;
        if (i === seat)
          bid = config.legacy
            ? old.decideBid({ ...context, bidScale: config.scale })
            : next.decideBid({
                ...context,
                bidScale: config.scale,
                lookaheadWeight: config.weight,
                horizon: config.horizon,
                endgameAggression: config.endgameAggression ?? false,
                samples: config.samples,
                marketTarget: config.marketMultiplier
                  ? market.target(letter) * config.marketMultiplier
                  : 0,
              });
        else if (field === "targeted")
          bid = next.decideBid({
            ...context,
            bidScale: 1.8,
            lookaheadWeight: 1,
          });
        else
          bid = Math.min(
            b.balance,
            old.decideBid({ ...context, bidScale: 1.8 }) +
              (field === "premium" ? 6 : 0),
          );
        return { i, amount: bid, tie: random() };
      })
      .filter((b) => b.amount > 0)
      .sort((a, b) => b.amount - a.amount || a.tie - b.tie);
    if (bids[0]) {
      const b = bots[bids[0].i];
      const paid = bids[1]?.amount ?? 1;
      b.balance -= paid;
      market.observe(letter, paid);
      prices.push(paid);
      if (prices.length > 20) prices.shift();
      b.rack.set(letter, (b.rack.get(letter) ?? 0) + 1);
      if (bag.length) cash(bids[0].i, bag.length);
    }
  }
  const me = bots[seat];
  return {
    score: me.score,
    win: me.score === Math.max(...bots.map((b) => b.score)) ? 1 : 0,
    place: 1 + bots.filter((b) => b.score > me.score).length,
    balance: me.balance,
    leftover: [...me.rack.values()].reduce((s, n) => s + n, 0),
  };
}
const results = [];
const firstSeed = Number(process.env.EVAL_SEED ?? 40000);
const start = performance.now();
for (const field of ["legacy", "premium"]) {
  let base: number[] = [];
  for (const config of configurations) {
    const rows = Array.from({ length: N }, (_, i) =>
      game(firstSeed + i, config, field),
    );
    if (config.legacy) base = rows.map((r) => r.score);
    const average = (k: keyof (typeof rows)[number]) =>
      rows.reduce((s, r) => s + r[k], 0) / N;
    const differences = rows.map((r, i) => r.score - base[i]);
    const delta = differences.reduce((s, n) => s + n, 0) / N;
    const margin =
      1.96 *
      Math.sqrt(
        differences.reduce((s, n) => s + (n - delta) ** 2, 0) / (N - 1) / N,
      );
    const result = {
      field,
      ...config,
      matches: N,
      score: average("score"),
      winRate: average("win"),
      placement: average("place"),
      balance: average("balance"),
      leftover: average("leftover"),
      pairedScoreDelta: delta,
      confidence95: [delta - margin, delta + margin],
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
writeFileSync(
  new URL("../market-evaluation.json", import.meta.url),
  JSON.stringify(
    {
      seeds: [firstSeed, firstSeed + N - 1],
      runtimeMs: performance.now() - start,
      results,
      limitations:
        "Offline approximation; rotates candidate seat; premium opponents add six to old bids; targeted opponents use two-letter lookahead; all Vickrey; no network delays; ties counted as wins.",
    },
    null,
    2,
  ),
);
