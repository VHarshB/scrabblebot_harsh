import { letterValue, lengthMultiplier } from "./letters.js";
export const LETTER_VALUE = Object.fromEntries(
  [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => [c, letterValue(c)]),
);
export function reward(word: string): number {
  const [n, d] = lengthMultiplier(word.length);
  return Math.floor(
    ([...word].reduce((s, c) => s + LETTER_VALUE[c], 0) * Number(n)) /
      Number(d),
  );
}
type Entry = { word: string; counts: [string, number][]; reward: number };
type Trie = { children: Map<string, Trie>; entries: Entry[] };
export class WordEngine {
  private root: Trie = { children: new Map(), entries: [] };
  entries: Entry[];
  private cache = new Map<string, Entry[]>();
  constructor(dictionary: string[]) {
    this.entries = [...new Set(dictionary)]
      .filter((w) => /^[A-Z]{2,}$/.test(w))
      .map((word) => {
        const m = new Map<string, number>();
        for (const c of word) m.set(c, (m.get(c) ?? 0) + 1);
        return { word, counts: [...m], reward: reward(word) };
      })
      .sort((a, b) => b.reward - a.reward || a.word.localeCompare(b.word));
    for (const e of this.entries) {
      let node = this.root;
      for (const c of [...e.word].sort()) {
        let child = node.children.get(c);
        if (!child) {
          child = { children: new Map(), entries: [] };
          node.children.set(c, child);
        }
        node = child;
      }
      node.entries.push(e);
    }
  }
  playable(rack: Map<string, number>): Entry[] {
    const key = [...rack]
      .filter(([, n]) => n > 0)
      .sort()
      .map(([c, n]) => c + n)
      .join("");
    const old = this.cache.get(key);
    if (old) return old;
    const n = [...rack.values()].reduce((a, b) => a + b, 0);
    const result: Entry[] = [];
    const remaining = new Map(rack);
    const visit = (node: Trie) => {
      result.push(...node.entries);
      for (const [c, child] of node.children) {
        const k = remaining.get(c) ?? 0;
        if (k > 0) {
          remaining.set(c, k - 1);
          visit(child);
          remaining.set(c, k);
        }
      }
    };
    visit(this.root);
    result.sort((a, b) => b.reward - a.reward || a.word.localeCompare(b.word));
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(key, result);
    return result;
  }
  partition(rack: Map<string, number>): { score: number; word: string | null } {
    const memo = new Map<string, { score: number; word: string | null }>();
    let visits = 0;
    const solve = (
      r: Map<string, number>,
    ): { score: number; word: string | null } => {
      const key = [...r]
        .sort()
        .map(([c, n]) => c + n)
        .join("");
      const old = memo.get(key);
      if (old) return old;
      let best = { score: 0, word: null as string | null };
      if (++visits > 2000) return best;
      for (const e of this.playable(r)) {
        const next = new Map(r);
        for (const [c, n] of e.counts) next.set(c, next.get(c)! - n);
        const score = e.reward + solve(next).score;
        if (score > best.score) best = { score, word: e.word };
      }
      memo.set(key, best);
      return best;
    };
    return solve(rack);
  }
}
const engines = new WeakMap<string[], WordEngine>();
export function engine(dictionary: string[]): WordEngine {
  let e = engines.get(dictionary);
  if (!e) {
    e = new WordEngine(dictionary);
    engines.set(dictionary, e);
  }
  return e;
}
export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  dictionary?: string[];
  remaining?: number;
  auctionType?: string;
  clearingPrice?: number;
  bidScale?: number;
}
export function decideBid(c: BidContext): number {
  if (
    !Number.isFinite(c.myBalance) ||
    c.myBalance <= 0 ||
    !LETTER_VALUE[c.letter]
  )
    return 0;
  const have = c.myRack.get(c.letter) ?? 0;
  const tiles = [...c.myRack.values()].reduce((a, b) => a + b, 0);
  let utility = LETTER_VALUE[c.letter] * 1.5 + 3 - have * 2;
  const vowels = [..."AEIOU"].reduce((n, l) => n + (c.myRack.get(l) ?? 0), 0);
  if ("AEIOU".includes(c.letter)) utility += vowels < tiles / 3 ? 4 : -2;
  if (c.letter === "Q" && !c.myRack.get("U")) utility *= 0.25;
  if (c.letter === "U" && c.myRack.get("Q")) utility += 12;
  if (c.dictionary) {
    const e = engine(c.dictionary);
    const before = e.playable(c.myRack)[0]?.reward ?? 0;
    const next = new Map(c.myRack);
    next.set(c.letter, have + 1);
    const after = e.playable(next)[0]?.reward ?? 0;
    utility += Math.max(0, after - before) * 0.65;
  }
  const remaining = c.remaining ?? 68;
  const reserve = remaining > 10 ? Math.min(20, remaining / 3) : 0;
  let bid = utility * (c.bidScale ?? 1.8);
  if (c.clearingPrice && utility > 5)
    bid = Math.min(bid * 1.15, Math.max(bid, c.clearingPrice + 1));
  if (c.auctionType === "FirstPrice") bid *= 0.65;
  if (remaining < 8)
    bid = Math.max(bid, c.myBalance / Math.max(1, remaining + 1));
  return Math.max(
    0,
    Math.min(
      Math.floor(c.myBalance),
      Math.floor(Math.min(bid, Math.max(1, c.myBalance - reserve))),
    ),
  );
}
export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[];
  remaining?: number;
  myBalance?: number;
}
export function chooseWord(c: WordContext): string | null {
  const e = engine(c.dictionary);
  const best = e.playable(c.myRack)[0];
  if (!best) return null;
  if ((c.remaining ?? 0) <= 5) return e.partition(c.myRack).word;
  const tiles = [...c.myRack.values()].reduce((a, b) => a + b, 0);
  return best.word.length >= 7 || (c.myBalance ?? 100) < 18 || tiles >= 11
    ? best.word
    : null;
}
