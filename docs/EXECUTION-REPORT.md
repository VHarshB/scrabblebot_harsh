# Execution report

## Implementation and verification

Imported the official starter from commit `b5ccb36aa238ad16692f8d6af54da15ef9f11324` into the existing empty worktree using fetch/restore. No nested repository was created. `origin` still points to `https://github.com/VHarshB/scrabblebot_harsh`.

Core custom files:

- `.gitattributes`, `.gitignore`, `.nvmrc`: Windows wordlist line endings, credential/tool ignores, Node version.
- `README.md`, `docs/UPSTREAM-README.md`: Windows operation and preserved upstream instructions.
- `bot-starter/package.json`, `bot-starter/package-lock.json`: build, tests, simulation, minimal client dependencies.
- `bot-starter/.env.example`: placeholder credential configuration. An ignored `.env` was also created without credentials.
- `bot-starter/src/env.ts`: local ignored environment loading.
- `bot-starter/src/index.ts`: credential loading, immediate deadline-checked bids, one pending word per match, reconnect/backoff, retrying lobby entry, tournament reducer flow, public-payment history, score/word/health logging.
- `bot-starter/src/strategy.ts`: complete ENABLE index, counted letters, exact reward, word-completion bidding, duplicate/vowel/Q-U utility, liquidity/timing, bounded endgame partition search.
- `bot-starter/src/letters.ts`: official scoring and bag constants.
- `bot-starter/src/lifecycle.ts`, `lifecycle.test.ts`, `strategy.test.ts`: critical pure strategy and event-guard tests.
- `bot-starter/src/simulate.ts`, `bot-starter/benchmark.json`: seeded evaluation, paired score comparisons and approximate 95% confidence intervals.
- `bot-starter/src/probe.ts`: read-only live connection/schema/tournament check.
- `bot-starter/scripts/prepare-bindings.mjs`, `generate.mjs`: repeatable official binding preparation and CLI generation.
- `package.json`: root test command delegates to the module's own matching runner.
- `package-lock.json`, `spacetimedb/package-lock.json`: dependency resolution after installation.
- `spacetimedb/src/dictionary.ts`: CRLF-safe parsing. Wordlist contents are unchanged; local line endings normalized to LF.
- `docs/live-schema.json`: downloaded public live-schema snapshot.
- `docs/FILE-MANIFEST.txt`: exact source-file inventory, including the imported starter.

## Commands executed

All terminal commands used PowerShell. Node 22.23.4 was already installed but its shim was not active in restricted tool sessions, so npm commands used its installation directory prepended to PATH.

- `git status --short`, `git remote -v`
- `git fetch https://github.com/clockworklabs/scrabblebot.git main`
- `git restore --source=FETCH_HEAD --worktree -- .`
- `nvm list`, `nvm install 22`, `nvm use 22`
- `npm install` at root; dependency installations in bot-starter and spacetimedb
- `npm test --prefix bot-starter` (includes TypeScript build)
- `npm run build` (root TypeScript + Vite)
- `npm test` (now delegates to the server module's runner)
- `$env:SIM_MATCHES='300'; npm run benchmark --prefix bot-starter`
- `node bot-starter/dist/probe.js`
- npm audit of bot dependencies; removed unused tsx dependency; final bot audit reported zero vulnerabilities
- Official SpacetimeDB v2.12.0 Windows ZIP downloaded/extracted into ignored `.tools`; CLI source bindings regenerated into `.tools/live-bindings` and compared with imported bindings (identical after line-ending normalization)
- Public schema downloaded from `https://maincloud.spacetimedb.com/v1/database/scrabblebot/schema?version=9`
- Reference README and strategy inspected; retained reference download only in ignored `.tools`
- Prettier applied to custom bot sources and scripts
- `git check-ignore bot-starter/.env bot-starter/.token-test` confirmed both ignored

Initial dependency/network commands needed sandbox elevation; they subsequently succeeded. Initial tests exposed and led to fixes for Windows ESM imports, dictionary line endings, the module test-runner mismatch, and empty-token fallback.

## Results

- Bot: 9 tests passed; TypeScript compilation passed.
- Official module: 178 tests passed in 12 suites, including auctions, words, privacy views, registration, lobbies, ratings, and tournament finals.
- Root application: TypeScript and Vite production build passed.
- Word engine: all 172,820 ENABLE entries loaded; warm search average below 100 ms in the adversarial-rack test. Index initialization happens before connecting. Network deadlines remain unmeasured without real practice.
- Live SDK 2.12 connection and initial public table subscriptions succeeded. Tournament ID `1` was `Ended`; no open tournament was listed.

Final seeded sweep: 300 seeds per configuration, two fields, three scales = 1,800 matches, approximately 20.5 seconds. Results with live-client clearing-price adaptation included:

| Field | Scale | Mean score | Win rate | Mean place | Leftover tiles | Balance |
|---|---:|---:|---:|---:|---:|---:|
| Mixed | 1.2 | 305.67 | 100% | 1.00 | 2.78 | 123.12 |
| Mixed | 1.8 | 317.90 | 100% | 1.00 | 2.78 | 120.14 |
| Mixed | 2.4 | 325.16 | 100% | 1.00 | 2.79 | 117.04 |
| Self | 1.2 | 44.11 | 1.0% | 5.49 | 1.82 | 29.23 |
| Self | 1.8 | 72.64 | 15.3% | 3.51 | 0.75 | 23.01 |
| Self | 2.4 | 71.09 | 17.7% | 3.66 | 1.20 | 6.54 |

Keep scale 1.8: scale 2.4's paired self-play score difference is -1.55, approximate 95% interval [-4.29, 1.19], with materially less remaining liquidity. This does not demonstrate that 1.8 is statistically superior to 2.4. Scale 1.2 clearly underperforms in self-play. The simulator approximates built-in timing and has no network latency; these results do not establish tournament-winning strength. Endgame partition search is capped at 2,000 states and is approximate on sufficiently large racks. Disconnect/backoff and duplicate/expiration guards have unit coverage, but authenticated disconnect/reducer-failure integration behavior remains to be exercised.

## Remaining account actions and status

The account was linked using the authenticated SpacetimeDB CLI, and the user saved the bot JWT locally in ignored `bot-starter/.env`. Authentication succeeded for **Oily, bot ID 329**. No token was printed or committed.

Real practice match **46974** ended with **59 points, balance 14, placement 6 of 6**. Server-confirmed words were EPHEDRA (39), PAIK (16), and DIG (4). Opponent scores were 123, 96, 70, 70, and 66. This demonstrates working connectivity and word/bid reducers, but does not demonstrate competitive strength. Offline mixed-field results substantially overstate performance against the actual live field; further tuning needs stronger opponent models and repeated live measurements.

The bot automatically rejoined and started match **46989**, with ARMLOCK and HOGTIE already confirmed. Persistent hidden Node process **24280** remains running locally. Output: `bot-starter/practice.log`; errors: `bot-starter/practice-error.log`; PID: ignored `bot-starter/.bot.pid`. No reducer errors were logged during the first completed match. Keep this computer awake and online. To stop this specific process from PowerShell, run `Stop-Process -Id 24280`. To restart after stopping, run `npm start --prefix bot-starter`.

Tournament status was rechecked after practice: only tournament **1**, status **Ended**. No registration was attempted or claimed. Remaining work is competitive tuning, authenticated reconnect stress testing, registration when a real tournament opens, and GitHub publication after authorization.

Root/server development dependencies inherited audit findings; they are separate from the zero-vulnerability bot dependency set. The web/server has not been published or changed on the live service.

Final client scalability verification: an unbounded historical subscription probe timed out. The client now loads only its own participation records and subscribes to auction/word history per active match, dropping those subscriptions when the match ends. The bounded public probe then passed, including match-state and credential/rack views. Its authenticated subscription lifecycle has now been verified through a completed practice match and automatic rejoining.

A clean `npm ci` in `bot-starter` followed by all 9 bot tests also passed, with zero audit vulnerabilities. The implementation is committed locally as 3e02978; no push to origin is authorized or performed.

## Strategy revision and tournament registration

The original strategy completed 8 live matches with 0 wins and 462 total points before replacement. Additional matches were running while evaluation proceeded. That live record prompted a new paired evaluation rather than claiming the earlier mixed-field simulation predicted live success.

The new bidder blends the original valuation with deterministic Monte Carlo marginal rack value: six common-random future samples, a six-letter horizon capped to keep projected racks at 12 tiles, 50% blend, scale 1.8. Future samples use a standard bag prior, not hidden server letters. It retains seven-letter word timing because earlier six-letter cash-in underperformed. Endgame bidding prioritizes usable score gains and skips the final unplayable auction. Partition search has a 25 ms time budget and a 2,000-state cap. It is approximate on large racks.

Fresh validation seeds 20000–20149, 150 games per configuration and field:

| Field | Baseline score / wins | Selected rollout score / wins | Paired mean score improvement (approx. 95% CI) |
|---|---|---|---|
| Five original strategies | 74.13 / 19.3% | 89.07 / 39.3% | +14.93 [11.17, 18.69] |
| Five premium-bidding strategies | 96.99 / 79.3% | 108.72 / 90.0% | +11.73 [7.73, 15.72] |

These are offline results, not measured live win rates. `rollout-validation.json` preserves all four configurations across both fields (1,200 games); `rollout-training.json` and `rollout-pilot.json` preserve earlier experiments. The final configuration was checked on new seeds after initial tuning; additional holdout measurements are still appropriate before claiming general superiority. An initial two-letter-completion heuristic and early six-letter cash-in were rejected because paired tests worsened scores. The archived `baseline-strategy.ts` makes comparisons reproducible. All 13 bot tests pass. Worst measured rollout decision in the automated large-rack/normal-rack test was 7.69 ms; live observed calculations also included values around 30 ms. One late bid rejection during live resumption was handled without stopping the client.

The upgraded client adds lifetime wins/matches logging and per-match score/placement records in ignored `practice-results.jsonl`, loads all participants only for active matches, guards old connection callbacks, and retries bootstrap timeouts. It resumed a running match after process replacement and automatically rejoined afterward. The first partially upgraded match, 47113, scored 58 and placed fifth; this is not evidence of a live win-rate improvement yet.

On the latest check, tournament **2** opened with status **Registration**. At the user's explicit request, `TOURNAMENT_ID=2` was saved only in ignored `.env`, and the bot was switched to tournament mode. **Server-confirmed entry: tournament_id 2, bot_id 329 (Oily).** Duplicate entries and simultaneous practice matches are not supported for one bot. The client remains active as process **1952**, logs `bot-starter/tournament.log` and `bot-starter/tournament-error.log`, and will finish any existing practice match before the server seats tournament matches. Earlier process IDs 24280 and 1792 were stopped during upgrades. Keep the computer online and awake. Tournament start is controlled by the organizer, not this client.

Matched-history review: the public result for match 46974 confirms PAIK paid 15 and DIG paid 5 (the total score remains 59). The winner played CAZIQUE for 81, HO for 5, and TOXICS for 37. Long-word reward and access to valuable letter combinations explain the gap; the leaderboard screenshot's leading entries themselves show win rates around 38–41%, not guaranteed wins.

## Pre-tournament correction and readiness

Live verification after eleven matches showed 0 wins, 599 total points, a 54.5 mean score, legacy Elo 853, and OpenSkill approximately 1192 ±190. The pasted screenshots select differing HTML rows/counts; the live bot ID 329 was used as the authoritative record. No rating/version reset was used to conceal losses.

Added `adaptive-market.ts` with bounded local persistence of public clearing prices, deduplication of replayed auctions, idempotent per-match updates, and small capped scale changes. Added liquidity-reserve correction: a bot with fewer than 20 coins is no longer restricted to one-coin bids simply by the reserve. Tournament registration/practice transitions are now explicit and tested. For the impending tournament, ignored `.env` selects `PRACTICE_DURING_REGISTRATION=false`, which keeps the bot free for organizer seating.

Market-price-floor experiments against the archived v2 strategy were not robust. At 50 seeds per configuration, the conservative 0.8 setting gained 5.52 points in the legacy field (95% interval crosses zero) but lost 27.58 in the premium field (95% interval strictly negative). The full-price and 1.2 settings were worse. Live trials also failed to improve results: matches 47262, 47285, 47308, 47327 scored 31, 36, 30, 22, all sixth. The price floor was therefore disabled before tournament readiness. `market-evaluation.json` preserves the 500-game sweep. The alternative balanced policy remains an offline experiment, not the deployed policy; `balanced-evaluation.json` preserves its 240-game pilot. Neither model has demonstrated reliable live superiority. `rollout-v2-strategy.ts` is an archived comparison baseline.

A significant client bottleneck was found: global match-state replication consumed sustained CPU during unrelated service traffic. A read-only live probe confirmed the server-side join `match_state JOIN match_participant WHERE bot_id=329` returns only Oily's own 14 match rows. That query is now used by the client. Recent live auction calculations after deployment measured 0.44–0.70 ms, versus values around 20–60 ms in earlier logs; this is observed timing, not an isolated causal benchmark.

All 18 bot tests pass, including low-liquidity unlocking bids, public-market observation validation, duplicate event protection, bounded match learning, and active-tournament practice exclusion. The most recent tested rollout decision maximum under competing test/process load was 21.37 ms. No server scoring or rating rules were changed.

Tournament entry 2 / bot 329 remains server-confirmed and not eliminated. The last practice match, **47346**, is confirmed **Ended** (33 points, fifth). Oily is now free for tournament seating, with practice autojoining disabled. Current persistent process: **25780**. Current logs: `bot-starter/tournament-ready.log` and `bot-starter/tournament-ready-error.log`. Process 13700 was stopped during readiness deployment. The organizer has not yet started the tournament at this verification point; no tournament result or win is claimed.
