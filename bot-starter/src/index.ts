import { mayBid, reconnectDelay, tournamentId } from "./lifecycle.js";
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
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

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
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    clearingPrice: prices
      .get(String(matchId))
      ?.reduce((s, n, _, a) => s + n / a.length, 0),
    myRack: rackForMatch(conn, matchId),
    dictionary: DICTIONARY,
    remaining: conn.db.matchState.id.find(matchId)?.bagTotal,
    auctionType: conn.db.matchState.id.find(matchId)?.auctionType.tag,
  });
  if (amount <= 0) return;
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch(logFailure(`bid on auction ${auctionId}`));
  bidsByAuction.add(key);
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId})`,
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
  retry = 0;
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
      "SELECT * FROM match_state",
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
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    const history = prices.get(String(r.matchId)) ?? [];
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
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        if (!TOURNAMENT_ID) joinLobby(conn);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
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
      .subscribe([`SELECT * FROM match_participant WHERE bot_id = ${myBotId}`]);
    return;
  }
  subscribeMatchDetails(conn);
  if (TOURNAMENT_ID) {
    const tournament = conn.db.tournament.id.find(BigInt(TOURNAMENT_ID));
    console.log(
      `[${BOT_NAME}] tournament ${TOURNAMENT_ID} status: ${tournament?.status.tag ?? "unknown"}`,
    );
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  if (!TOURNAMENT_ID) joinLobby(conn);
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
        ["auction", "auction_result", "word_play"].map(
          (table) => `SELECT * FROM ${table} WHERE match_id = ${p.matchId}`,
        ),
      );
    matchUnsubscribers.set(key, () => subscription.unsubscribe());
  }
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  if (!BOT_TOKEN && !loadToken() && !BOT_NONCE)
    throw new Error(
      "Save BOT_TOKEN in bot-starter/.env; generate it on /team.",
    );
  active = DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      console.error("connect error:", err.message);
      scheduleReconnect();
    })
    .onDisconnect(() => {
      console.log("disconnected");
      scheduleReconnect();
    })
    .build();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  myBotId = null;
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
  if (active?.isActive && myBotId !== null && !TOURNAMENT_ID) joinLobby(active);
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
