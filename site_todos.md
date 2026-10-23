# Site & UI TODOs

Suggested features and fixes for the live static site (`docs/`), from a codebase review on 2026-10-06.
Paths are relative to the repo root unless noted; `engine/…` means `docs/static/scripts/engine/…`.

## Fix first

- [x] **Lock down Elo writes.** Done: the `rateGame` Cloud Function (functions/) checks and rates every game; clients cannot write ratings, counters or `user_games`. `database.rules.json:10-11` gives `users/$uid/elo` (and `gamesPlayed`, `wins`)
  `.write: "auth !== null"`, so any signed-in user can change any account's rating (up to ±32 per write).
  Short term: tighten the rules.
  Long term: deploy the server-side Elo in `functions/index.js` (needs the Blaze plan).
  The rating is computed by whichever player's browser reports the result (`engine/elo.js`), and only red's client saves the game record (`engine/firebase-sync.js:682`).
- [x] **Restrict `rooms/$roomId`.** Done: only the seated uids write a room (guests sign in anonymously); settings are fixed at creation. It is world-readable and world-writable (`database.rules.json:84-88`).
- [ ] **Fix the Deep Review labels.** The buttons say "Deep Review (8 ply)" (`docs/game.html:759`) and "Deep AI Review (10 ply)" (`docs/game.html:799`).
  The real preset is 60s per position with no fixed depth (`engine/game-review.js:31`), and the code comment at `engine/game-review.js:101` also says "8-ply".
  Show an estimated time instead, since a long game can take about an hour.
- [x] **Handle online move failures.** Done: unsent moves are tracked and a banner shows while the connection is down or a write is refused (the SDK resends on reconnect). `sendTurn`, `sendForfeit` and `saveGameState` only `console.error` (`engine/firebase-sync.js:349-388, 453`).
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
- [x] **Handle disconnects properly.** Done: the server stamps `disconnectedAt` on a dropped seat; the opponent sees a countdown, "reconnected", and after 60 s can claim the game (checked by the rating function); the `expireClocks` function ends flagged games with no tab open. Add a grace-period countdown, a "reconnected" event and claim-win / abort on abandonment.
  Today there is only a one-off "Opponent disconnected." message (`engine/multiplayer-controller.js:32-35`).
  Timeouts are enforced only while a client is open, so they also need server-side expiry.
- [ ] **Add draw offers, abort before move 2, and takebacks by mutual agreement.** Abort before both players move: done (later aborts count as forfeits). Draws and takebacks: open.
- [ ] **Add in-game chat or preset emotes.**
- [ ] **Add a friends / follow list** with "challenge" from a profile.
- [ ] **Add the missing account features:** password reset (`sendPasswordResetEmail`), upgrading an anonymous account to a full one (`linkWith*`), and account deletion.
- [x] **Clean up stale rooms.** Game invite rooms (unjoined waiting rooms) expire after 72 hours and are pruned from rooms/ and user_active_games/. Finished rooms are pruned when someone opens `docs/active-games.html` (`:304-308`), and `ai/purge_stale_rooms.py` is available for maintenance.

## Showing data the site already stores

- [ ] **Show the rating change after a game** (e.g. +12 / −8). `eloChange` and the before/after Elo are stored but never shown.
- [ ] **Show whether a game is rated**, before and during it (`docs/multiplayer.html:261` only says "Sign in for ranked play").
- [ ] **Show the spectator count to players.** It is written to `rooms/X/spectators` but never displayed.
- [x] **Keep unrated, variant and casual games in profile history.** Done: `rateGame` indexes every signed-in game, marked `rated: false` when unrated. `/user_games` is written only inside `processEloClientSide` (`engine/elo.js:109-135`).
- [ ] **Add per-mode stats** (by time control and by variant) to `docs/profile.html`.
- [ ] **Improve the leaderboard** (`docs/leaderboard.html`):
  - [ ] Add a provisional-rating marker or a minimum number of games.
  - [ ] Add player search and "find me".
  - [ ] Load only the top N (`limitToLast`) instead of every entry.
- [ ] **Merge the lobby's "Active Games" list into `docs/active-games.html`.** The lobby list reads localStorage (`docs/multiplayer.html:1093-1120`) and shows "Waiting..." for every untimed game.

## Puzzles

- [ ] **Sync puzzle progress to the account.** It is stored only in `localStorage['sigil_puzzles_solved']`.
- [ ] **Add a puzzle rating.** (Streaks and a daily puzzle: done, puzzles v2.)
- [ ] **Add Cataclysm and Scramble puzzles.** The Rust engine models neither variant. (Tectonic and Providence puzzles: done, puzzles v2.)
- [x] **Add theme/tactic tags** to puzzles. (Puzzles v2: tags and a 1–5 difficulty, with filters.)
- [x] **Precache `static/puzzles/mate_puzzles.json` in `docs/sw.js`.**

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

## From a Lichess comparison (2026-10-21)

Features Lichess has for chess that the site lacks for Sigil, from a review of `lichess-org/lila` against `docs/`.
Items already listed above are not repeated; chess-only features (opening names, tablebases, chess variants, FIDE data, electronic boards) are left out.

### Pairing & ratings

- [ ] **Add matchmaking pools** that pair players automatically within a rating range, alongside the open-game lobby.
- [ ] **Let a friend-challenge link choose colour** (random, red or blue).
- [ ] **Let players choose rated or casual per game.**
- [ ] **Split ratings by time control and variant** (bullet, blitz, rapid, correspondence; Cataclysm etc.) instead of one Elo.
- [ ] **Move to Glicko-2** with a provisional `?` marker, and show rating ranges on open games.

### During a game

- [ ] **Add "ask for more time" and "give opponent +15 s".**
- [ ] **Add pre-moves** (queue a move during the opponent's turn).
- [ ] **Add a chat toggle** so players can hide chat (once chat exists).
- [ ] **Add zen mode** that hides everything but the board and clocks.
- [ ] **Add board flip** and a choice of which side the board is drawn from.
- [ ] **Add correspondence conveniences:** a "your move" list across games and a vacation / pause option.
- [ ] **Add move input by typed notation**, and optionally by voice.
- [ ] **Let players draw arrows and circles** on the board during play and analysis.
- [ ] **Add volume, animation speed and move confirmation** to the in-game settings panel.

### Analysis & study

- [ ] **Add a free analysis board:** any position, a branching move tree, and a live engine evaluation with top lines.
- [ ] **Add a board editor** to set up a position and play it against the AI or a friend.
- [ ] **Add studies:** shared chapter-based analysis boards with comments and annotation symbols, editable live by several people.
- [ ] **Run server-side analysis for every rated game** (Lichess's fishnet), stored and shown to both players; today review runs on demand in the browser.
- [ ] **Add an evaluation cache** so already-analysed positions load instantly.
- [ ] **Add "learn from your mistakes":** replay your blunder positions from a game and find the better move.
- [ ] **Add practice-from-position** against the AI with hints.
- [ ] **Add a layout / opening explorer:** play counts and win rates for each spell layout and opening move, site-wide and per player.
- [ ] **Add insights:** charts of a player's results by spell, layout, colour, time control and game phase.

### Puzzles

- [ ] **Add a puzzle dashboard** (results by theme over time).
- [ ] **Add Puzzle Storm and Puzzle Racer** (timed rush, solo and multiplayer).
- [x] **Generate puzzles from a player's own games** (positions where they missed a win). Puzzles v2: "My missed wins", ranked games only.

### Learning

- [ ] **Add guided practice drills** (dashing, cast timing, pushes).
- [ ] **Add a node-naming trainer** for the board coordinates.
- [ ] **Add classes** where teachers manage students and track their progress.
- [ ] **Add a coach directory and a video library.**
- [ ] **Finish the strategy guide.** `docs/strategy-guide.html` is still a "being written…" stub.

### Competitions

- [ ] **Add arena tournaments** (scheduled and user-created), with berserk (halve your clock for a bonus point).
- [ ] **Add Swiss tournaments.**
- [ ] **Add simultaneous exhibitions** (one player against many).
- [ ] **Add scheduled site events and announcements.**
- [ ] **Add broadcasts** relaying games from over-the-board events.

### Social

- [ ] **Add blocking** alongside the friends / follow list.
- [ ] **Add an activity feed / timeline** ("X won a game", "X joined a tournament").
- [ ] **Add private messaging.**
- [ ] **Add a notifications inbox** plus web push.
- [ ] **Add teams** with team tournaments and team battles.
- [ ] **Add forums.**
- [ ] **Add user blogs and a site blog.**
- [ ] **Add private notes on players** and bookmarking games.
- [ ] **Add a streamer listing.**
- [ ] **Add Sigil TV** showing the top-rated live game.
- [ ] **Add an end-of-year recap** of each player's games.
- [ ] **Add supporter patrons** with a badge.

### Profile & account

- [ ] **Add per-mode stats pages:** streaks, best wins, worst losses, opponents.
- [ ] **Add game search** by player, result, spell layout and date.
- [ ] **Add bulk export** of all a player's games.
- [ ] **Add trophies, badges and verified titles.**
- [ ] **Add account closing, two-factor authentication and an active-sessions list.**
- [ ] **Add detailed preferences:** board and stone appearance, sounds, clock display, resignation confirmation, blind mode.
- [ ] **Translate the interface** into multiple languages.

### Fair play & moderation

- [ ] **Add reporting** of players and games, and a moderation panel to handle reports.
- [ ] **Add engine-correlation cheat detection** (Lichess's Irwin).
- [ ] **Add profanity filters** on chat and names.
- [ ] **Add temporary bans** for players who abandon or stall games, and an appeals process.

### Platform

- [ ] **Add a public API with OAuth** (sign in to other apps with a site account).
- [ ] **Add bot accounts** so outside engines can play on the site.
- [ ] **Add an embeddable board widget** for games and puzzles.
- [ ] **Add GIF / image export** of games and positions.
- [ ] **Add a screen-reader mode** and full keyboard control.
- [ ] **Ship a native mobile app.**

## Cleanup

- [ ] **Share one keyboard handler** between `docs/static/scripts/game-board-local.js` and `docs/static/scripts/game-board-multiplayer.js:630-646`; multiplayer has a copy today.
- [ ] **Move the inline styles** in `docs/game.html:51-89` into the stylesheet.
- [ ] **Pass the spell argument** to `handleSpellMouseOut()` on the sorcery `mouseout` (`docs/game.html:670`).
  It is harmless today because the parameter is unused.
