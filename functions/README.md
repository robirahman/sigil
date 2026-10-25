# Cloud Functions (Blaze plan)

| function | trigger | what it does |
|---|---|---|
| `rateGame` | new `completed_games/{id}` | Checks the result (`rating.js`) and is the only writer of Elo, `gamesPlayed` / `wins` / `losses`, the leaderboard ratings and `user_games`. |
| `recordRoom` | `rooms/{code}/status` → finished | Writes the game's `completed_games` record and `rooms/{code}/gameId`. |
| `expireClocks` | every minute | Ends playing rooms whose clock ran out with no tab open (from the turns' server timestamps). |
| `settleAbort` | new `rooms/{code}/abortedBy` | An abort after both players moved becomes a forfeit by the aborter. |
| `notifyTurn` | new `rooms/{code}/turns/{id}` | Web push to the player now to move (`notify.js`): correspondence games, and realtime ones whose player to move has no tab open. Tokens from `push_tokens/{uid}` (owner-only); tokens FCM reports dead are removed. Only logged on the emulator. |
| `deleteUserData` | callable | "Delete account": removes the caller's records and sign-in, and blanks their uid in old game records. |

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

## Whose move, and the clocks

`docs/static/scripts/engine/room-clock.js` (`roomTurns`, `sideToMove`, `roomTimeLeft`) is the one rule for whose move it is and how long they have, from the turns' server timestamps. The functions `require()` it (`engine-loader.js requireShared`; copied with the engine at deploy) and the site's active-games list and "Your move" badge load it as a script.

## Tests

```sh
cd functions && npm ci
npm test             # rating.js on recorded games (no emulator)
npm run test:rules   # database.rules.json on the database emulator
npm run test:e2e     # rules + functions + auth emulators, through the client SDK
```

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

   The rules take rating writes away from the clients, so the function has to be live first. `firebase.json`'s predeploy step copies the engine files into `functions/engine/`.
4. For "Notify me when it's my move": Console → Project settings → Cloud Messaging → Web Push certificates → Generate key pair, and put the public key in `FCM_VAPID_KEY` (`docs/static/scripts/turn-notify.js`). Until then the toggle is hidden; in-tab notifications work without it.
5. Pages cached by older clients still try to write ratings themselves. Those writes are now refused, and the function rates those games anyway.
