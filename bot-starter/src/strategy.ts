import { letterValue, lengthMultiplier, DEFAULT_BAG } from "./letters.js";
const PRIOR_BAG = DEFAULT_BAG.flatMap(([c, n]) => Array<string>(n).fill(c));
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
  private rolloutCache = new Map<string, number>();
  marginalValue(
    rack: Map<string, number>,
    letter: string,
    remaining: number,
    samples = 6,
    horizon = 4,
  ): number {
    const signature = [...rack]
      .filter(([, n]) => n > 0)
      .sort()
      .map(([c, n]) => c + n)
      .join("");
    const tiles = [...rack.values()].reduce((s, n) => s + n, 0);
    const draws = Math.max(
      0,
      Math.min(horizon, Math.ceil(remaining / 7), 12 - tiles),
    );
    const key = `${signature}:${letter}:${draws}:${samples}`;
    const cached = this.rolloutCache.get(key);
    if (cached !== undefined) return cached;
    // Common random futures make the difference much less noisy. The seed
    // depends on the rack rather than the candidate letter or wall clock.
    let state = 2166136261;
    for (const c of signature)
      state = Math.imul(state ^ c.charCodeAt(0), 16777619) >>> 0;
    const random = () =>
      (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
    let total = 0;
    for (let sample = 0; sample < samples; sample++) {
      const future = new Map(rack);
      for (let i = 0; i < draws; i++) {
        const c = PRIOR_BAG[Math.floor(random() * PRIOR_BAG.length)];
        future.set(c, (future.get(c) ?? 0) + 1);
      }
      const before = this.playable(future)[0]?.reward ?? 0;
      future.set(letter, (future.get(letter) ?? 0) + 1);
      const after = this.playable(future)[0]?.reward ?? 0;
      total += Math.max(0, after - before);
    }
    const value = total / samples;
    if (this.rolloutCache.size > 5000) this.rolloutCache.clear();
    this.rolloutCache.set(key, value);
    return value;
  }
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
    const deadline = performance.now() + 25;
    const solve = (
      r: Map<string, number>,
    ): { score: number; word: string | null } => {
      const key = [...r]
        .sort()
        .map(([c, n]) => c + n)
        .join("");
      const old = memo.get(key);
      if (old) return old;
      const playable = this.playable(r);
      let best = {
        score: playable[0]?.reward ?? 0,
        word: playable[0]?.word ?? null,
      };
      if (++visits > 2000 || performance.now() > deadline) return best;
      for (const e of playable) {
        if (performance.now() > deadline) break;
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
  lookaheadWeight?: number;
  tempo?: number;
  samples?: number;
  horizon?: number;
  endgameAggression?: boolean;
  marketTarget?: number;
  adaptiveScale?: number;
  policy?:'rollout'|'balanced';
  balancedScale?:number;
}
export function decideBid(c: BidContext): number {
  if(c.policy==='balanced')return decideBalancedBid(c);
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
    if ((c.lookaheadWeight ?? 0.5) > 0) {
      const marginal = e.marginalValue(
        c.myRack,
        c.letter,
        c.remaining ?? 68,
        c.samples ?? 6,
        c.horizon ?? 6,
      );
      utility =
        utility * (1 - (c.lookaheadWeight ?? 0.5)) +
        Math.max(0, marginal + 1.5 - have * 0.5) * (c.lookaheadWeight ?? 0.5);
    }
  }
  const remaining = c.remaining ?? 68;
  if ((c.endgameAggression ?? true) && remaining === 0) return 0;
  const reserve =
    remaining > 10 ? Math.min(20, remaining / 3, c.myBalance * 0.15) : 0;
  let bid = utility * (c.bidScale ?? 1.8) + (c.tempo ?? 0);
  if (c.clearingPrice && utility > 5)
    bid = Math.min(bid * 1.15, Math.max(bid, c.clearingPrice + 1));
  // A low face value does not make a versatile tile unimportant. Use only
  // public clearing prices; duplicated tiles and imbalanced racks don't get
  // the market floor. Keep enough liquidity to avoid one ruinous purchase.
  if (
    c.marketTarget &&
    "AEINORSTLC".includes(c.letter) &&
    have < 2 &&
    remaining > 5
  ) {
    const vowel = "AEIOU".includes(c.letter);
    if (!vowel || vowels <= Math.max(2, tiles * 0.5))
      bid = Math.max(bid, Math.min(c.marketTarget, c.myBalance * 0.3));
  }
  bid *= c.adaptiveScale ?? 1;
  if (c.auctionType === "FirstPrice") bid *= 0.65;
  if (remaining < 8)
    bid = Math.max(bid, c.myBalance / Math.max(1, remaining + 1));
  if ((c.endgameAggression ?? true) && remaining < 8 && c.dictionary) {
    const e = engine(c.dictionary);
    const next = new Map(c.myRack);
    next.set(c.letter, have + 1);
    const gain = e.partition(next).score - e.partition(c.myRack).score;
    if (gain > 0) bid = Math.max(bid, c.myBalance / Math.max(1, remaining / 4));
    else if (remaining === 1) return 0;
  }
  return Math.max(
    0,
    Math.min(
      Math.floor(c.myBalance),
      Math.floor(Math.min(bid, Math.max(1, c.myBalance - reserve))),
    ),
  );
}
export function decideBalancedBid(c:BidContext):number {
  const value=LETTER_VALUE[c.letter];const remaining=c.remaining??68;
  if(!value||!Number.isFinite(c.myBalance)||c.myBalance<=0||remaining===0)return 0;
  const have=c.myRack.get(c.letter)??0;
  const tiles=[...c.myRack.values()].reduce((s,n)=>s+n,0);
  const vowels=[...'AEIOU'].reduce((s,l)=>s+(c.myRack.get(l)??0),0);
  let base=(8+value*1.2)*0.75**have;
  if('AEIOU'.includes(c.letter)){if(vowels<tiles*0.3+0.5)base+=2;else if(vowels>tiles*0.6+1)base*=0.7;}
  if(c.letter==='Q'&&!c.myRack.get('U'))base*=0.4;
  let gain=0;
  if(c.dictionary){const e=engine(c.dictionary);const after=new Map(c.myRack);after.set(c.letter,have+1);gain=Math.max(0,(e.playable(after)[0]?.reward??0)-(e.playable(c.myRack)[0]?.reward??0));base+=gain*0.7;const marginal=e.marginalValue(c.myRack,c.letter,remaining,6,6);base+=Math.max(0,marginal-gain)*0.35;}
  let bid=base*(c.balancedScale??1)*(c.adaptiveScale??1);
  if(c.auctionType==='FirstPrice')bid*=0.65;
  if(remaining<8&&gain>0)bid=Math.max(bid,c.myBalance/Math.max(1,remaining/4));
  if(remaining===1&&gain===0)return 0;
  const reserve=remaining>10?Math.min(10,c.myBalance*0.1):0;
  return Math.max(0,Math.floor(Math.min(c.myBalance-reserve,bid)));
}
export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[];
  remaining?: number;
  myBalance?: number;
  partitionPreference?: boolean;
}
export function chooseWord(c: WordContext): string | null {
  const e = engine(c.dictionary);
  const best = e.playable(c.myRack)[0];
  if (!best) return null;
  if ((c.remaining ?? 0) <= 5) return e.partition(c.myRack).word;
  if (c.partitionPreference && best.word.length >= 7)
    return e.partition(c.myRack).word;
  const tiles = [...c.myRack.values()].reduce((a, b) => a + b, 0);
  return best.word.length >= 7 || (c.myBalance ?? 100) < 18 || tiles >= 11
    ? best.word
    : null;
}
