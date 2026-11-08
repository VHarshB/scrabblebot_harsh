# Competitive ScrabbleBot

Windows / PowerShell client for the real-time letter auction game. Official layout, ENABLE dictionary and server source are preserved. Imported upstream commit: b5ccb36aa238ad16692f8d6af54da15ef9f11324 (MIT).

## Install and verify

Install Node 22. Then from the repository root:

```powershell
npm ci --prefix bot-starter
npm test --prefix bot-starter
npm run benchmark --prefix bot-starter
```

The build prepares the checked-in official bindings for Node ESM. It does not publish or modify the live database. `npm run generate` requires the SpacetimeDB CLI; do not regenerate from an outdated server module. The included `probe.ts` verifies a read-only SDK connection and lists tournament IDs:

```powershell
node bot-starter/dist/probe.js
```

## Authentication and practice

1. Link your SpacetimeDB account at https://scrabblebot.spacetimedb.com/account using its displayed CLI instruction in a terminal already logged into SpacetimeDB.
2. Create or join your team at https://scrabblebot.spacetimedb.com/team and click Generate token. The screenshot's web identity is not this JWT.
3. Run `Copy-Item bot-starter/.env.example bot-starter/.env`, open `.env` locally in VS Code, and set `BOT_TOKEN`. Never paste tokens into chat or commit them.
4. Keep `TOURNAMENT_ID` empty for practice. Run:

```powershell
npm start --prefix bot-starter
```

Expected: `connected`, `subscription applied`, `acting as bot`, then `joining lobby`, bids and word plays. Health logs appear every 30 seconds. A credential error means generate/check the team bot token. No authenticated practice has been completed as part of setup without that token.

Keep this terminal and computer running, disable sleep for the session, and keep the network connected. Ctrl+C stops the bot. Restart with the same command. Connections retry with capped exponential backoff. GitHub does not run this bot. Token files and `.env` are ignored. Token files are plaintext; protect your Windows account.

## Tournament

Get an actual registration-open ID from the live site/probe, set `TOURNAMENT_ID` in `.env`, then restart. The bot calls `registerForTournament`; success is logged only after the reducer confirms it. Tournament mode avoids joining practice lobbies. Check the site's entry list. On the verification run, ID 1 was Ended and no registration was open; this bot is not registered.

## Strategy and evaluation

`strategy.ts` indexes all ENABLE words by sorted letters, caches playable words, computes integer rewards, values word-completing letters, balances vowels/duplicates/Q-U, reserves liquidity, shades first-price bids and spends down near the end. It holds smaller words until liquidity or rack pressure requires cashing in. Endgame search maximizes partitions within a 2,000-node search cap; large racks may receive an approximate result.

`simulate.ts` runs reproducible seeds against the starter, approximations of built-in strategies, aggressive bidders and five copies of our strategy. `benchmark.json` records win rate, score, placements, balance, leftover tiles and runtime. To increase sample size:

```powershell
$env:SIM_MATCHES='300'
npm run benchmark --prefix bot-starter
```

Simulation omits network delays and uses fixed six-player, five-tile, one-second Vickrey defaults. Built-in timing is approximated. It is not proof of tournament superiority. Ties count as wins. The final auction's winning tile cannot be played because the server ends the match in the same transaction; the bot cashes out earlier. Current source discards unbid letters, unlike the old docs. Starting racks are private; our client uses only its own rack and public clearing payments. Public opponent racks cannot be reconstructed completely because initial racks are hidden.

## Troubleshooting and collaboration

If `node` says no active version, run `nvm use 22` or activate an installed Node runtime in your terminal. If SDK subscriptions fail after a server upgrade, rerun the probe and regenerate compatible bindings. Empty dictionary fails startup. Reducer rejections are logged and do not crash the client. Keep Windows time synchronized for deadline checks.

Use one branch per teammate: `git switch -c feature/word-engine`, `feature/auction`, or `feature/client`. Commit tested work, push that branch and open a PR into main. Keep strategy and simulator changes paired. Never share `.env` in Git. The existing origin remains https://github.com/VHarshB/scrabblebot_harsh. Commit/push only after reviewing the source and authorizing publication.

See [upstream documentation](docs/UPSTREAM-README.md) for the preserved web/server project. Avoid root `npm run dev`/`publish` against production: they are server deployment commands.

The official Windows CLI 2.12.0 is downloaded locally under ignored `.tools/spacetime/`. For first-time account linking, run `& .\.tools\spacetime\spacetimedb-cli.exe login`, complete the browser login, then use that same executable in place of `spacetime` in the account page's `connect_id` command. Do not put your login token on a command line. This step still requires the account owner.

For a new clone, install the official SpacetimeDB CLI separately if you need account linking or binding regeneration. Normal bot builds need only Node and the checked-in bindings. Install server test dependencies with `Push-Location spacetimedb; npm ci; Pop-Location` before running root `npm test`. The module uses its own Vitest runner to keep its SDK test harness consistent.

The current bidder uses a deterministic rollout blend tested against the archived original strategy. Run `npm run build --prefix bot-starter` followed by `node bot-starter/dist/competitive-eval.js`; set `EVAL_MATCHES` to control sample size. Detailed fresh-seed results are in `bot-starter/rollout-validation.json`. The bot logs actual score, placement, and lifetime win counts. Simulation results are not live win rates.

Oily is currently registered for tournament 2 with server confirmation. `.env` selects tournament mode, which waits for organizer-created matches rather than continuously joining practice. One bot cannot enter multiple simultaneous matches or register repeatedly for additional seats. Current logs are `bot-starter/tournament.log` and `bot-starter/tournament-error.log`; the local process ID is in ignored `bot-starter/.bot.pid`.
