import {
  mayBid,
  reconnectDelay,
  tournamentId,
  mayPractice,
} from "./lifecycle.js";
import { AdaptiveMarket } from "./adaptive-market.js";
import "./env.js";
// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseWord, decideBid, engine } from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "harsh";
if (!/^[a-zA-Z0-9_-]+$/.test(BOT_NAME)) throw new Error("Invalid BOT_NAME");
const BOT_TOKEN = process.env.BOT_TOKEN?.trim() || undefined;
const BOT_NONCE = process.env.BOT_NONCE?.trim() || undefined;
const TOURNAMENT_ID = tournamentId(process.env.TOURNAMENT_ID);
const PRACTICE_DURING_REGISTRATION=process.env.PRACTICE_DURING_REGISTRATION!=="false";
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const market = new AdaptiveMarket(
  path.join(process.cwd(), ".market-state.json"),
);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
const dictionaryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "spacetimedb",
  "wordlist.txt",
);
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
  : [];
if (DICTIONARY.length < 170000)
  throw new Error("Complete ENABLE dictionary missing");
engine(DICTIONARY);
DICTIONARY.sort((a, b) => b.length - a.length); // longest first for greedy pick

const prices = new Map<string, number[]>();
let ownSubscribed = false;
const subscribedMatches = new Set<string>();
const matchUnsubscribers = new Map<string, () => void>();
const wordPending = new Set<string>();
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let retry = 0;
let active: DbConnection | undefined;
let connectionGeneration = 0;
let subscriptionReady = false;
let connectionWatchdog: ReturnType<typeof setTimeout> | undefined;
let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const lastWordAttemptByMatch = new Map<string, number>();
const WORD_RETRY_MS = 500;

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const auction = conn.db.auction.id.find(auctionId);
  if (
    !auction ||
    !mayBid(
      bidsByAuction,
      key,
      auction.status.tag,
      auction.closesAt.microsSinceUnixEpoch,
    )
  )
    return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const calculationStarted = performance.now();
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    marketTarget: 0,
    adaptiveScale: market.state.scale,
    clearingPrice: prices
      .get(String(matchId))
      ?.reduce((s, n, _, a) => s + n / a.length, 0),
    myRack: rackForMatch(conn, matchId),
    dictionary: DICTIONARY,
    remaining: conn.db.matchState.id.find(matchId)?.bagTotal,
    auctionType: conn.db.matchState.id.find(matchId)?.auctionType.tag,
  });
  const calculationMs = performance.now() - calculationStarted;
  if (
    !mayBid(
      bidsByAuction,
      key,
      auction.status.tag,
      auction.closesAt.microsSinceUnixEpoch,
    )
  )
    return;
  if (amount <= 0) return;
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch(logFailure(`bid on auction ${auctionId}`));
  bidsByAuction.add(key);
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId}, calculation ${calculationMs.toFixed(2)} ms)`,
  );
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  // Only matches still being played. The bot keeps its letters from
  // matches that have ended, but can't play them.
  const matches = new Set<bigint>();
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") matches.add(p.matchId);
  }
  const now = Date.now();
  for (const matchId of matches) {
    const key = String(matchId);
    if (
      wordPending.has(key) ||
      now - (lastWordAttemptByMatch.get(key) ?? 0) < WORD_RETRY_MS
    )
      continue;
    lastWordAttemptByMatch.set(key, now);
    const word = chooseWord({
      myRack: rackForMatch(conn, matchId),
      dictionary: DICTIONARY,
      remaining: conn.db.matchState.id.find(matchId)?.bagTotal,
      myBalance: participantForMatch(conn, matchId)?.balance,
    });
    if (!word) continue;
    console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}'`);
    wordPending.add(key);
    conn.reducers
      .submitWord({ matchId, word })
      .catch(logFailure(`playing '${word}'`))
      .finally(() => wordPending.delete(key));
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  ownSubscribed = false;
  subscribedMatches.clear();
  matchUnsubscribers.clear();
  myBotId = null;
  bidsByAuction.clear();
  wordPending.clear();
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onError(() => {
      console.error("Subscription rejected; reconnecting");
      scheduleReconnect();
    })
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              scheduleReconnect();
              return;
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            bootstrapActivity(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          scheduleReconnect();
          return;
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`,
      );
      bootstrapActivity(conn);
    })
    .subscribe([
      "SELECT * FROM bot",
      "SELECT * FROM bot_credential",
      "SELECT * FROM bot_stats",
      "SELECT * FROM my_rack",
      "SELECT * FROM open_lobbies",
      "SELECT * FROM open_lobby_members",
      "SELECT * FROM tournament",
      "SELECT * FROM tournament_entry",
    ]);

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.matchParticipant.onInsert(() => subscribeMatchDetails(conn));
  conn.db.matchParticipant.onUpdate((_ctx, _old, p) => {
    if (p.botId === myBotId)
      console.log(
        JSON.stringify({
          event: "score",
          matchId: String(p.matchId),
          balance: String(p.balance),
          score: String(p.score),
        }),
      );
  });
  conn.db.wordPlay.onInsert((_ctx, p) => {
    if (p.botId === myBotId)
      console.log(
        JSON.stringify({
          event: "word_confirmed",
          matchId: String(p.matchId),
          word: p.word,
        }),
      );
  });
  conn.db.botStats.onUpdate((_ctx, _old, s) => {
    if (s.botId === myBotId)
      console.log(
        JSON.stringify({
          event: "lifetime_stats",
          matches: s.matchesPlayed,
          wins: s.wins,
          winRate: s.matchesPlayed ? s.wins / s.matchesPlayed : 0,
          rating: s.rating,
        }),
      );
  });
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    const history = prices.get(String(r.matchId)) ?? [];
    market.observe(r.letter, Number(r.paid), String(r.auctionId));
    history.push(Number(r.paid));
    if (history.length > 20) history.shift();
    prices.set(String(r.matchId), history);
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid}`,
    );
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      matchUnsubscribers.get(String(neu.id))?.();
      matchUnsubscribers.delete(String(neu.id));
      subscribedMatches.delete(String(neu.id));
      prices.delete(String(neu.id));
      for (const key of bidsByAuction)
        if (key.startsWith(`${neu.id}:`)) bidsByAuction.delete(key);
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        queueMicrotask(() => {
          const players = [...conn.db.matchParticipant.iter()].filter(
            (p) => p.matchId === neu.id,
          );
          const mine = players.find((p) => p.botId === myBotId);
          if (mine) {
            const result = {
              event: "match_result",
              matchId: String(neu.id),
              score: String(mine.score),
              balance: String(mine.balance),
              placement: 1 + players.filter((p) => p.score > mine.score).length,
              players: players.length,
            };
            console.log(JSON.stringify(result));
            if (
              market.complete({
                ...result,
                score: Number(mine.score),
                balance: Number(mine.balance),
              })
            )
              console.log(
                JSON.stringify({
                  event: "post_match_update",
                  scale: market.state.scale,
                  observations: market.state.matches.length,
                }),
              );
            try {
              fs.appendFileSync(
                path.join(process.cwd(), "practice-results.jsonl"),
                JSON.stringify(result) + "\n",
              );
            } catch {
              console.warn("Could not append match-result log");
            }
          }
        });
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        joinLobby(conn);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if(TOURNAMENT_ID&&!PRACTICE_DURING_REGISTRATION)return;
  if (myBotId === null) return;
  const entries = [...conn.db.tournamentEntry.iter()]
    .filter((e) => e.botId === myBotId)
    .map((e) => ({
      status:
        conn.db.tournament.id.find(e.tournamentId)?.status.tag ?? "Unknown",
      eliminated: e.eliminated,
    }));
  if (!mayPractice(entries)) return;
  const inRunning = Array.from(conn.db.matchParticipant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.matchState.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.openLobbies.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.openLobbyMembers.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function bootstrapActivity(conn: DbConnection) {
  if (!ownSubscribed) {
    ownSubscribed = true;
    conn
      .subscriptionBuilder()
      .onError(() => scheduleReconnect())
      .onApplied(() => bootstrapActivity(conn))
      .subscribe([
        `SELECT * FROM match_participant WHERE bot_id = ${myBotId}`,
        `SELECT match_state.* FROM match_state JOIN match_participant ON match_state.id = match_participant.match_id WHERE match_participant.bot_id = ${myBotId}`,
      ]);
    return;
  }
  subscriptionReady = true;
  retry = 0;
  if (connectionWatchdog) clearTimeout(connectionWatchdog);
  subscribeMatchDetails(conn);
  if (TOURNAMENT_ID) {
    const tournament = conn.db.tournament.id.find(BigInt(TOURNAMENT_ID));
    console.log(
      `[${BOT_NAME}] tournament ${TOURNAMENT_ID} status: ${tournament?.status.tag ?? "unknown"}`,
    );
    const registered = [...conn.db.tournamentEntry.iter()].some(
      (e) => e.botId === myBotId && e.tournamentId === TOURNAMENT_ID,
    );
    if (registered)
      console.log(
        `[${BOT_NAME}] tournament ${TOURNAMENT_ID} entry confirmed from server subscription`,
      );
    else if (tournament?.status.tag === "Registration")
      conn.reducers
        .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
        .then(() =>
          console.log(
            `[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`,
          ),
        )
        .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  }
  tryPlayWord(conn);
}

function subscribeMatchDetails(conn: DbConnection) {
  if (myBotId === null) return;
  for (const p of conn.db.matchParticipant.iter()) {
    if (
      p.botId !== myBotId ||
      conn.db.matchState.id.find(p.matchId)?.status.tag !== "Running"
    )
      continue;
    const key = String(p.matchId);
    if (subscribedMatches.has(key)) continue;
    subscribedMatches.add(key);
    const subscription = conn
      .subscriptionBuilder()
      .onError(() => scheduleReconnect())
      .onApplied(() => {
        for (const a of conn.db.auction.iter())
          if (a.matchId === p.matchId && a.status.tag === "Open")
            tryBid(conn, a.id, a.matchId, a.letter);
        tryPlayWord(conn);
      })
      .subscribe(
        ["auction", "auction_result", "word_play", "match_participant"].map(
          (table) => `SELECT * FROM ${table} WHERE match_id = ${p.matchId}`,
        ),
      );
    matchUnsubscribers.set(key, () => subscription.unsubscribe());
  }
}

function main() {
  const generation = ++connectionGeneration;
  subscriptionReady = false;
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  if (!BOT_TOKEN && !loadToken() && !BOT_NONCE)
    throw new Error(
      "Save BOT_TOKEN in bot-starter/.env; generate it on /team.",
    );
  active = DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect((conn, identity, token) => {
      if (generation !== connectionGeneration) {
        conn.disconnect();
        return;
      }
      onConnect(conn, identity, token);
    })
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      console.error("connect error:", err.message);
      if (generation === connectionGeneration) scheduleReconnect();
    })
    .onDisconnect(() => {
      console.log("disconnected");
      if (generation === connectionGeneration) scheduleReconnect();
    })
    .build();
  connectionWatchdog = setTimeout(() => {
    if (generation === connectionGeneration && !subscriptionReady) {
      console.warn("Connection bootstrap timed out");
      scheduleReconnect();
    }
  }, 30000);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  myBotId = null;
  subscriptionReady = false;
  if (connectionWatchdog) clearTimeout(connectionWatchdog);
  reconnectTimer = setTimeout(() => {
    active?.disconnect();
    reconnectTimer = undefined;
    main();
  }, reconnectDelay(retry++));
}
setInterval(() => {
  if (active?.isActive && myBotId !== null) {
    subscribeMatchDetails(active);
    tryPlayWord(active);
  }
}, 100);
setInterval(() => {
  if (active?.isActive && myBotId !== null) joinLobby(active);
}, 5000);
setInterval(
  () =>
    console.log(
      JSON.stringify({
        event: "health",
        connected: active?.isActive ?? false,
        authenticated: myBotId !== null,
      }),
    ),
  30000,
);
main();
