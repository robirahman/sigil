# Cloud Functions (Blaze plan)

| function | trigger | what it does |
|---|---|---|
| `rateGame` | new `completed_games/{id}` | Checks the result (`rating.js`) and is the only writer of Elo, `gamesPlayed` / `wins` / `losses`, the leaderboard ratings and `user_games`. |
| `recordRoom` | `rooms/{code}/status` → finished | Writes the game's `completed_games` record and `rooms/{code}/gameId`. |
| `expireClocks` | every minute | Ends playing rooms whose clock ran out with no tab open (from the turns' server timestamps). |
| `settleAbort` | new `rooms/{code}/abortedBy` | An abort after both players moved becomes a forfeit by the aborter. |
| `notifyTurn` | new `rooms/{code}/turns/{id}` | Web push to the player now to move (`notify.js`): correspondence games, and realtime ones whose player to move has no tab open. Tokens from `push_tokens/{uid}` (owner-only); tokens FCM reports dead are removed. Only logged on the emulator. |
| `analyzeGame` | task queue, enqueued by `rateGame` for each rated game | The Rust engine's review of the game (`analysis.js`) at the Quick-review preset, 10 positions per task, re-enqueued until done; writes `game_evals/{roomCode}`, which the review panel reads. Progress in `game_evals_progress/{gameId}` (server-only). Fills and reads the eval cache `position_evals/{key}`. |
| `evalPositions` | callable (signed in) | Up to 10 positions a browser Quick review searched itself: each is checked (it must read back to itself) and searched again here before it is cached in `position_evals`, so clients cannot poison the cache. |
| `deleteUserData` | callable | "Delete account": removes the caller's records and sign-in, and blanks their uid in old game records. |
| `api` | HTTPS (`onRequest`, public) | The HTTP API (`api.js`, documented in `docs/api.html`): public reads (`public-api.js`) and the bot API (`bot-api.js`), by personal token, rate limited (`rate-limit.js`). |
| `createApiToken` / `revokeApiToken` | callable | The account page's API tokens (`api-tokens.js`): the token is returned once and stored only as its SHA-256. |
| `upgradeToBot` | callable | Makes the caller's account a BOT account, for good (`bot-api.js upgradeToBot`). |

## How a result is checked

- **Online games** are checked against `rooms/{code}`. Only the two seated uids can write a room (`database.rules.json`).
  - A natural end is replayed with the site's own engine (`engine-loader.js` runs `docs/static/scripts/engine/`), and it must end with the claimed winner.
  - A forfeit must be the loser's own `forfeitedBy` write.
  - A loss on time is recomputed from the turns' server timestamps.
  - A claim that the opponent left (`endReason: 'abandon'`) needs their seat marked gone, by the server's onDisconnect stamp, for 60 s, after both players have moved.
  - A result that does not follow from the room is rated as a forfeit by whoever wrote it (`finishedBy`).
- **Games against the AI** are replayed the same way.
  - A human win must end on the board.
  - A resignation or flag is rated only when the AI won.
  - The AI's moves cannot be re-searched here, so a player who types in both sides of a game can still fake one. Nothing short of running the AI on the server stops that.
- **Rating:** both humans need full (non-anonymous) accounts. The game must be rated under `unratedReason` (`docs/static/scripts/engine/elo.js`), which the lobby uses too.
- **Duplicates:** each game is rated once. `rating_claims/` is keyed by room, or by a hash of an AI game's transcript.
- **Unrated games** are written to `user_games` with `rated: false` and the reason.

## The HTTP API and BOT accounts

`https://us-central1-sigil-js.cloudfunctions.net/api/v1/...` (`api.js` routes; `docs/api.html` is the reference).

- **Public reads** (`public-api.js`): profiles, a player's games (with moves and SFNs for online games, replayed by `turn-check.js roomGame`), a game by room code (long-poll with `?after=&wait=`), the daily puzzle (the same pick as `puzzles.html`; the puzzle set is copied to `functions/data/` at deploy), the leaderboards. Only what the rules already let anyone read; never `completed_games` (so never the moves of a game against the site AI), and a game in play without spectators only to its players.
- **Tokens** (`api-tokens.js`): `api_tokens/{sha256}` → `{ uid, id, scopes }`, `api_token_hashes/{uid}/{id}` (both server-only), `user_api_tokens/{uid}/{id}` (the owner reads the list). Scopes `read` and `bot`; a bot token only for a BOT account; 10 per account; revoked with the account.
- **Rate limits** (`rate-limit.js`): fixed one-minute windows in `api_rate/{key}` (token id, or a hash of the IP: the last `X-Forwarded-For` hop), 60/min anonymous, 300/min per token; swept by `expireClocks`.
- **BOT accounts** (`bot-api.js`): `bots/{uid}` (public) and `users/{uid}/isBot`, written by `upgradeToBot` only (an account with no games). The rules refuse every room, lobby, challenge, leaderboard, puzzle-rating and game-record write by a bot uid, so a bot's moves reach a room only through `POST /v1/bot/games/{room}/turn`, which `turn-check.js checkTurn` checks with the rating replay (`reconstructGameLog`, its new `strict` mode for the new turn: live controller, every token used). The API writes the turn as a client would (`last`, the clock node, `currentSfn`, the result at a natural end) in one transaction on the room. Bots are rated on `bot_leaderboard/` (`rating.js ratingUpdates`); against a human only with the human's `rooms/{code}/rateBot` (`judgeGame`: `bot-opt-in`), never against the site AI (`bot-vs-ai`). Bots play timed games only. `recordRoom` takes finished games off a bot's `user_active_games`.
- **Reference bot**: `tools/sigil-bot.js` (random legal turns, through the site's own `GameController`).

## Whose move, and the clocks

`docs/static/scripts/engine/room-clock.js` (`roomTurns`, `sideToMove`, `roomTimeLeft`) is the one rule for whose move it is and how long they have, from the turns' server timestamps. The functions `require()` it (`engine-loader.js requireShared`; copied with the engine at deploy) and the site's active-games list and "Your move" badge load it as a script.

## Tests

```sh
cd functions && npm ci
npm test             # rating.js on recorded games, analysis.js with the wasm engine (no emulator)
npm run test:rules   # database.rules.json on the database emulator
npm run test:e2e     # rules + functions + auth emulators, through the client SDK
                     # (bot-e2e.test.js: tokens, BOT accounts, a bot-vs-bot game with tools/sigil-bot.js)
```

`test/api.test.js` (tokens, rate limits, the read endpoints, the HTTP handler) and `test/turn-check.test.js` (the bot turn check on the recorded game) need no emulator.

`test/online-game.json` is a complete game of input transcripts. It is produced by `node test/gen-online-fixture.js`.

`tools/browser/online-emulator-test.js` drives the real lobby in Chrome against the emulators (see its header); `show-data-emulator-test.js` checks the Rated / Casual badges, the spectator count and the rating line after a game, and `leaderboard-emulator-test.js` the leaderboard.

`tools/browser/online-emulator-test.js` drives the real lobby in Chrome against the emulators, and `tools/browser/lobby-emulator-test.js` the open games, quick pair and Watch Live lists (see their headers).

## Deploy

1. Switch the Firebase project to Blaze.
2. Back up the live rules (Console → Realtime Database → Rules). The live rules have lagged this file before.
3. From the repo root, deploy the functions and the rules together:

   ```sh
   firebase deploy --only functions,database
   ```

   The rules take rating writes away from the clients, so the function has to be live first. `analyzeGame` is a task queue function: the first deploy creates its Cloud Tasks queue (the Cloud Tasks API must be enabled). `firebase.json`'s predeploy step copies the engine files into `functions/engine/`.
4. For "Notify me when it's my move": Console → Project settings → Cloud Messaging → Web Push certificates → Generate key pair, and put the public key in `FCM_VAPID_KEY` (`docs/static/scripts/turn-notify.js`). Until then the toggle is hidden; in-tab notifications work without it.
5. Pages cached by older clients still try to write ratings themselves. Those writes are now refused, and the function rates those games anyway.
