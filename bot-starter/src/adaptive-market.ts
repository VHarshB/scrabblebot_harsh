import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
export interface MatchObservation {
  matchId: string;
  score: number;
  balance: number;
  placement: number;
  players: number;
}
interface MarketState {
  version: 1;
  prices: Record<string, number[]>;
  matches: MatchObservation[];
  scale: number;
  seen: string[];
}
export class AdaptiveMarket {
  state: MarketState = {
    version: 1,
    prices: {},
    matches: [],
    scale: 1,
    seen: [],
  };
  private seen = new Set<string>();
  constructor(private filename?: string) {
    if (filename && existsSync(filename)) {
      try {
        const raw = JSON.parse(readFileSync(filename, "utf8"));
        if (
          raw.version === 1 &&
          typeof raw.prices === "object" &&
          Array.isArray(raw.matches)
        ) {
          for (const [letter, values] of Object.entries(raw.prices))
            if (/^[A-Z]$/.test(letter) && Array.isArray(values))
              this.state.prices[letter] = values
                .filter((n) => Number.isFinite(n) && n > 0 && n < 10000)
                .slice(-60);
          this.state.matches = raw.matches
            .filter(
              (m: MatchObservation) =>
                m &&
                typeof m.matchId === "string" &&
                Number.isFinite(m.score) &&
                Number.isFinite(m.balance) &&
                m.placement >= 1 &&
                m.players >= m.placement,
            )
            .slice(-30);
          this.state.scale = Number.isFinite(raw.scale)
            ? Math.max(0.9, Math.min(1.25, raw.scale))
            : 1;
          this.state.seen = Array.isArray(raw.seen)
            ? raw.seen
                .filter((id: unknown) => typeof id === "string")
                .slice(-5000)
            : [];
          this.seen = new Set(this.state.seen);
        }
      } catch {
        console.warn("Ignoring invalid market-state file");
      }
    }
  }
  observe(letter: string, paid: number, auctionId?: string) {
    if (
      !/^[A-Z]$/.test(letter) ||
      !Number.isFinite(paid) ||
      paid <= 0 ||
      paid >= 10000
    )
      return;
    if (auctionId) {
      if (this.seen.has(auctionId)) return;
      this.seen.add(auctionId);
      this.state.seen.push(auctionId);
      if (this.state.seen.length > 5000)
        this.seen.delete(this.state.seen.shift()!);
    }
    const list = this.state.prices[letter] ?? [];
    list.push(paid);
    this.state.prices[letter] = list.slice(-60);
  }
  target(letter: string): number {
    const own = this.state.prices[letter] ?? [];
    const observations =
      own.length >= 3 ? own : Object.values(this.state.prices).flat();
    if (!observations.length) return 0;
    const sorted = observations.slice().sort((a, b) => a - b);
    return Math.min(30, sorted[Math.floor((sorted.length - 1) * 0.6)] + 1);
  }
  complete(match: MatchObservation): boolean {
    if (
      !Number.isFinite(match.score) ||
      !Number.isFinite(match.balance) ||
      match.placement < 1 ||
      match.players < match.placement
    )
      return false;
    if (this.state.matches.some((m) => m.matchId === match.matchId))
      return false;
    this.state.matches.push(match);
    this.state.matches = this.state.matches.slice(-30);
    const recent = this.state.matches.slice(-5);
    if (recent.length === 5) {
      const leftover = recent.reduce((s, m) => s + m.balance, 0) / 5;
      const rank =
        recent.reduce(
          (s, m) => s + (m.placement - 1) / Math.max(1, m.players - 1),
          0,
        ) / 5;
      if (leftover > 25 && rank > 0.5)
        this.state.scale = Math.min(1.25, this.state.scale + 0.025);
      else if (leftover < 5)
        this.state.scale = Math.max(0.9, this.state.scale - 0.025);
    }
    this.save();
    return true;
  }
  save() {
    if (!this.filename) return;
    try {
      writeFileSync(
        this.filename + ".tmp",
        JSON.stringify(this.state, null, 2),
      );
      renameSync(this.filename + ".tmp", this.filename);
    } catch {
      console.warn("Could not persist market observations");
    }
  }
}
