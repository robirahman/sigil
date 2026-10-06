# Site & UI TODOs

Suggested features and fixes for the live static site (`docs/`), from a codebase review on 2026-10-06.
Paths are relative to the repo root unless noted; `engine/…` means `docs/static/scripts/engine/…`.

## Fix first

- [ ] **Lock down Elo writes.** `database.rules.json:10-11` gives `users/$uid/elo` (and `gamesPlayed`, `wins`)
  `.write: "auth !== null"`, so any signed-in user can change any account's rating (up to ±32 per write).
  Short term: tighten the rules.
  Long term: deploy the server-side Elo in `functions/index.js` (needs the Blaze plan).
  The rating is computed by whichever player's browser reports the result (`engine/elo.js`), and only red's client saves the game record (`engine/firebase-sync.js:682`).
- [ ] **Restrict `rooms/$roomId`.** It is world-readable and world-writable (`database.rules.json:84-88`).
- [ ] **Fix the Deep Review labels.** The buttons say "Deep Review (8 ply)" (`docs/game.html:759`) and "Deep AI Review (10 ply)" (`docs/game.html:799`).
  The real preset is 60s per position with no fixed depth (`engine/game-review.js:31`), and the code comment at `engine/game-review.js:101` also says "8-ply".
  Show an estimated time instead, since a long game can take about an hour.
- [ ] **Handle online move failures.** `sendTurn`, `sendForfeit` and `saveGameState` only `console.error` (`engine/firebase-sync.js:349-388, 453`).
  Add a "reconnecting / move not sent" banner and retry, like `docs/static/scripts/offline-queue.js` does for local games.

## Onboarding & learning

- [ ] **Port the interactive tutorial to `docs/`.** The legacy Flask app has `templates/tutorial.html` and `static/scripts/tutorial.js` (~1900 lines); the live site has no equivalent.
  Rebuild it on `GameController` with scripted positions, as puzzles do.
- [ ] **Publish the strategy guide.** `docs/strategy-guide.html` is a "being written…" stub, but `docs/strategy/spell_dynamics_article.md` is written and linked from nowhere.
- [ ] **Add a page per spell**, with rules text, an example position to try, and win-rate data from `docs/strategy/data/spell_position_winrates.json`.
  Spell text is currently only a hover `title` tooltip on `docs/spells.html`, which doesn't work on touch screens.
- [ ] **Add rules pages for the variants** (Competitive, Deathmatch, Scramble, Allow duplicates, Cataclysm).
  The variants now sit in a collapsed "Game options" panel with one-line hints (`docs/index.html:502-560`).
- [ ] **Add variant rules to the in-game help popover** (`docs/static/scripts/help.js`).

## Online play & community

- [ ] **Add an open-game lobby / quick-pair.** Online play is room-code only.
  Add a "seek a game at this time control" list.
- [ ] **Add a "watch live games" list** for rooms that allow spectators. Spectating currently needs a shared link.
- [ ] **Add turn notifications for correspondence games** (12h / 24h / 3d), using the browser Notification API or Web Push through `docs/sw.js`.
- [ ] **Handle disconnects properly.** Add a grace-period countdown, a "reconnected" event and claim-win / abort on abandonment.
  Today there is only a one-off "Opponent disconnected." message (`engine/multiplayer-controller.js:32-35`).
  Timeouts are enforced only while a client is open, so they also need server-side expiry.
- [ ] **Add draw offers, abort before move 2, and takebacks by mutual agreement.**
- [ ] **Add in-game chat or preset emotes.**
- [ ] **Add a friends / follow list** with "challenge" from a profile.
- [ ] **Add the missing account features:** password reset (`sendPasswordResetEmail`), upgrading an anonymous account to a full one (`linkWith*`), and account deletion.
- [ ] **Clean up stale rooms.** Waiting rooms and their `user_active_games` entries are never cleaned up.
  Finished rooms are pruned only when someone opens `docs/active-games.html` (`:304-308`).

## Showing data the site already stores

- [ ] **Show the rating change after a game** (e.g. +12 / −8). `eloChange` and the before/after Elo are stored but never shown.
- [ ] **Show whether a game is rated**, before and during it (`docs/multiplayer.html:261` only says "Sign in for ranked play").
- [ ] **Show the spectator count to players.** It is written to `rooms/X/spectators` but never displayed.
- [ ] **Keep unrated, variant and casual games in profile history.** `/user_games` is written only inside `processEloClientSide` (`engine/elo.js:109-135`).
- [ ] **Add per-mode stats** (by time control and by variant) to `docs/profile.html`.
- [ ] **Improve the leaderboard** (`docs/leaderboard.html`):
  - [ ] Add a provisional-rating marker or a minimum number of games.
  - [ ] Add player search and "find me".
  - [ ] Load only the top N (`limitToLast`) instead of every entry.
- [ ] **Merge the lobby's "Active Games" list into `docs/active-games.html`.** The lobby list reads localStorage (`docs/multiplayer.html:1093-1120`) and shows "Waiting..." for every untimed game.

## Puzzles

- [ ] **Sync puzzle progress to the account.** It is stored only in `localStorage['sigil_puzzles_solved']`.
- [ ] **Add a puzzle rating, streaks and a daily puzzle.**
- [ ] **Add Cataclysm, Scramble and expansion puzzles.** None of the 1047 puzzles in `docs/static/puzzles/mate_puzzles.json` cover them.
- [ ] **Add theme/tactic tags** to puzzles.
- [ ] **Precache `static/puzzles/mate_puzzles.json` in `docs/sw.js`.** It is cached only after the first online visit.

## Game screen

- [ ] **Add undo / takeback in local and AI games.** "Reset Turn" only rolls back within the current turn (`docs/game.html:461-467`).
- [ ] **Add an in-game settings panel** for theme, volume (not just mute), art-only spell circles and animation level.
  These settings are spread across `docs/index.html` and `docs/account.html` today.
- [ ] **Accessibility:**
  - [ ] Add `aria-live` to the game log.
  - [ ] Have board node labels announce what is on the node, whether it is a legal move, and whether it was the last play (currently `aria-label=node`, `docs/game.html:695`).
  - [ ] Add `aria-label` or `title` to icon-only buttons: mute (`docs/game.html:239`) and the review arrows (`docs/game.html:775-786`).
  - [ ] Give the win modal `role="dialog"` and focus management.
  - [ ] Make spell tooltips open on keyboard focus.
  - [ ] Make the AI-review graph dots reachable by keyboard.
- [ ] **Add a colourblind mode.** Red and blue are told apart by colour alone in stones, glows and clocks. Add shape or pattern markers.
- [ ] **Respect `prefers-reduced-motion`.** Screen shake (`docs/static/scripts/spell-effects.js`), pulsing and twinkle animations always run.
- [ ] **Keyboard shortcuts:**
  - [ ] Add a `?` overlay that lists them.
  - [ ] Add Escape to close tooltips and reset.
  - [ ] Stop Enter from firing when a button has focus (`docs/static/scripts/game-board-local.js:1274-1289`); it currently both clicks the button and passes the turn.
- [ ] **Confirm before leaving a game in progress via "Main Menu"** (`docs/game.html:761`).
  The `beforeunload` warning is disabled on Safari.

## Cleanup

- [ ] **Share one keyboard handler** between `docs/static/scripts/game-board-local.js` and `docs/static/scripts/game-board-multiplayer.js:630-646`; multiplayer has a copy today.
- [ ] **Move the inline styles** in `docs/game.html:51-89` into the stylesheet.
- [ ] **Pass the spell argument** to `handleSpellMouseOut()` on the sorcery `mouseout` (`docs/game.html:670`).
  It is harmless today because the parameter is unused.
