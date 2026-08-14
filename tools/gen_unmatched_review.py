"""Generate the INTERACTIVE unmatched-turn reconstruction harness.

Reads ai/data/slim_migration_report.json + the completed_games dump and
emits docs/dev/unmatched-review.html — a page that reuses the real game
UI (board image, stone-node CSS, spell cards) and the real engine
(GameController) so Robi can REPLAY each unmatched turn by hand: click
moves, pushes, dashes and casts exactly as in a live game. When End
Turn produces a board byte-identical to the stored after-state, the
harness records the input-token transcript for that turn; "Download
solutions" saves all solved turns as JSON, which feeds back into the
migration via `python -m ai.slim_completed_games --solutions <file>`
(solved turns become kind:'input' entries; everything re-verifies
through the replay bridge) and shows which deduction rules to add.

Cases are ordered by failure-pattern frequency (most common cluster
first, members grouped), shown one at a time.

Usage:
    python -m tools.gen_unmatched_review \
        [--report ai/data/slim_migration_report.json] \
        [--dump ai/data/completed_games_raw.json] \
        [--out docs/dev/unmatched-review.html] [--max-cases 4000]
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from notation import NODE_ORDER, sfn_to_dict
from ai.slim_completed_games import _cast_spell_name


def signature(before, after, color, cast):
    """Coarse failure-class signature for clustering."""
    enemy = 'blue' if color == 'red' else 'red'
    placed = vacated_own = vacated_enemy = conv_to_own = conv_to_enemy = 0
    arrived_enemy = 0
    for n in NODE_ORDER:
        x, y = before['stones'].get(n), after['stones'].get(n)
        if x == y:
            continue
        if y == color and x is None:
            placed += 1
        elif y == color and x == enemy:
            conv_to_own += 1
        elif x == color and y is None:
            vacated_own += 1
        elif x == color and y == enemy:
            conv_to_enemy += 1
        elif x == enemy and y is None:
            vacated_enemy += 1
        elif y == enemy and x is None:
            arrived_enemy += 1
    counter_delta = (after[f'{color}_spellcounter']
                     - before[f'{color}_spellcounter'])
    return (cast or '-', counter_delta, placed, conv_to_own, vacated_own,
            conv_to_enemy, vacated_enemy, arrived_enemy)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--report', default='ai/data/slim_migration_report.json')
    ap.add_argument('--dump', default='ai/data/completed_games_raw.json')
    ap.add_argument('--out', default='docs/dev/unmatched-review.html')
    ap.add_argument('--max-cases', type=int, default=4000)
    args = ap.parse_args()

    with open(args.report) as f:
        report = json.load(f)
    with open(args.dump) as f:
        games = json.load(f)

    # Unmatched turns: snapshot turns of hybrid conversions (new report
    # shape) plus first-failure turns from any old-style failures.
    pairs = []
    for key, idxs in (report.get('snapshot_turns') or {}).items():
        for i in idxs:
            pairs.append((key, i))
    for fail in report['failures']:
        m = re.match(r'no-matching-turn-(\d+)', fail.get('reason', ''))
        if m:
            pairs.append((fail['key'], int(m.group(1))))

    clusters = defaultdict(list)
    for key, i in pairs:
        g = games.get(key)
        turns = g.get('turns') if isinstance(g, dict) else None
        if isinstance(turns, dict):
            turns = [v for _k, v in sorted(turns.items(),
                                           key=lambda kv: int(kv[0]))]
        if not turns or i >= len(turns):
            continue
        t = turns[i]
        if not (t.get('sfnBefore') and t.get('sfnAfter')):
            continue
        try:
            before = sfn_to_dict(t['sfnBefore'])
            after = sfn_to_dict(t['sfnAfter'])
        except Exception:
            continue
        cast = _cast_spell_name(t['sfnBefore'], t['sfnAfter'], t['color'])
        sig = signature(before, after, t['color'], cast)
        clusters[sig].append({
            'key': key,
            'turnNumber': t.get('turnNumber'),
            'color': t['color'],
            'sfnBefore': t['sfnBefore'],
            'sfnAfter': t['sfnAfter'],
            'spellNames': g.get('spellNames') or [],
            'variant': g.get('variant') or 'standard',
            'cast': cast,
        })

    ranked = sorted(clusters.items(), key=lambda kv: -len(kv[1]))
    cases = []
    for rank, (sig, members) in enumerate(ranked, 1):
        label = (f'cast:{sig[0]} +{sig[1]} | placed {sig[2]} '
                 f'conv-in {sig[3]} lost {sig[4]} conv-out {sig[5]} '
                 f'killed {sig[6]} enemy+{sig[7]}')
        for mi, m in enumerate(members, 1):
            m['cluster'] = rank
            m['clusterSize'] = len(members)
            m['memberIndex'] = mi
            m['signature'] = label
            cases.append(m)
    cases = cases[:args.max_cases]

    payload = {'cases': cases, 'totalUnmatched': sum(
        len(v) for v in clusters.values())}
    html = _PAGE.replace('__DATA__', json.dumps(payload))
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'{len(cases)} cases ({len(ranked)} patterns, '
          f'{payload["totalUnmatched"]} unmatched turns) -> {args.out}')


_PAGE = r'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unmatched-turn reconstruction — sigil dev</title>
<link rel="stylesheet" href="../static/css/styles.css">
<style>
  body { background: #14151c; color: #e6e6ea; font: 14px/1.5 system-ui, sans-serif;
         margin: 0; padding: 14px 20px 40px; }
  a { color: #8fb3ff; }
  .layout { display: flex; gap: 22px; flex-wrap: wrap; align-items: flex-start; }
  .col-board { width: 520px; max-width: 96vw; }
  .col-side { flex: 1; min-width: 300px; max-width: 560px; }
  .board-host { position: relative; }
  .board-host img.game-board { width: 100%; display: block; }
  .board-host .stone-nodes { position: absolute; inset: 0; }
  .board-host.small { width: 340px; }
  .hud { margin: 8px 0; min-height: 44px; }
  .hud .msg { color: #ffd479; font-size: 14px; min-height: 20px; }
  .hud button, .casebar button, .solutions button {
    margin: 4px 6px 0 0; padding: 6px 12px; border-radius: 6px; border: 0;
    background: #4463d8; color: #fff; cursor: pointer; font-size: 13px; }
  .hud button.secondary, .casebar button.secondary { background: #3a3f4e; }
  .casebar { border: 1px solid #333846; background: #1b1d27; border-radius: 10px;
             padding: 10px 14px; margin-bottom: 12px; }
  .casebar .sig { color: #e8c84a; font-size: 12.5px; }
  .casebar .meta { color: #9aa; font-size: 12.5px; }
  .spell-list { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
                margin-top: 10px; }
  .spell-card { background: #1b1d27; border: 1px solid #333846; border-radius: 8px;
                padding: 6px; text-align: center; font-size: 11.5px; color: #cfd3dd; }
  .spell-card img { width: 100%; border-radius: 6px; display: block; margin-bottom: 4px; }
  .spell-card .pos { color: #7a8095; }
  .deltas { font-size: 12.5px; color: #cfd3dd; margin: 8px 0; }
  .status-good { color: #7fdc8a; } .status-bad { color: #ff7b7b; }
  .solutions { margin-top: 14px; border-top: 1px solid #333846; padding-top: 10px; }
  h1 { font-size: 18px; margin: 0 0 10px; }
  .lbl { font-size: 12px; color: #9aa; margin: 4px 0 10px; }
</style>
</head>
<body>
<h1>Unmatched-turn reconstruction</h1>
<div class="casebar">
  <div><b id="case-title"></b> <span id="solved-count" style="float:right;color:#7fdc8a"></span></div>
  <div class="sig" id="case-sig"></div>
  <div class="meta" id="case-meta"></div>
  <button onclick="prevCase()" class="secondary">&larr; Prev</button>
  <button onclick="nextCase()" class="secondary">Skip &rarr;</button>
  <button onclick="nextUnsolved()" class="secondary">Next unsolved pattern</button>
  <button onclick="resetTurn()">Reset turn</button>
</div>
<div class="layout">
  <div class="col-board">
    <div class="hud">
      <div class="msg" id="msg"></div>
      <div id="actions"></div>
    </div>
    <div class="board-host" id="live-board"></div>
    <div class="lbl">live board — play <b id="mover"></b>'s turn here</div>
    <div id="verdict" class="deltas"></div>
  </div>
  <div class="col-side">
    <div class="board-host small" id="target-board"></div>
    <div class="lbl">target after-state</div>
    <div class="deltas" id="deltas"></div>
    <div class="spell-list" id="spells"></div>
    <div class="solutions">
      <b>Solved: <span id="n-solved">0</span></b>
      <button onclick="downloadSolutions()">Download solutions JSON</button>
      <button onclick="clearSolutions()" class="secondary">Clear</button>
      <div class="lbl">Save the file as <code>ai/data/solved_turns.json</code> and tell Claude —
        it feeds <code>--solutions</code> in the migration and drives new parser rules.</div>
    </div>
  </div>
</div>

<script src="../static/scripts/engine/constants.js"></script>
<script src="../static/scripts/engine/notation.js"></script>
<script src="../static/scripts/engine/board.js"></script>
<script src="../static/scripts/engine/moves.js"></script>
<script src="../static/scripts/engine/spells.js"></script>
<script src="../static/scripts/engine/ai-player.js"></script>
<script src="../static/scripts/engine/game-controller.js"></script>
<script src="../static/scripts/engine/game-review.js"></script>
<script>
const DATA = __DATA__;
const LS_KEY = 'sigil_solved_turns_v1';
let solutions = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
let idx = 0, generation = 0, gc = null, liveBoard = null;
let validMoves = {}, pushOptions = {}, lastPlayNode = null;

function caseId(c) { return c.key + ':t' + c.turnNumber; }

function buildBoard(hostId) {
  const host = document.getElementById(hostId);
  host.innerHTML = '<picture><source type="image/webp" srcset="../static/images/game-board.webp">' +
    '<img class="game-board" src="../static/images/game-board.jpg" alt=""></picture>' +
    '<div class="stone-nodes"></div>';
  const wrap = host.querySelector('.stone-nodes');
  const btns = {};
  for (const n of NODE_ORDER) {
    const b = document.createElement('button');
    b.className = 'stone-node stone-node--' + n;
    b.dataset.node = n;
    wrap.appendChild(b);
    btns[n] = b;
  }
  return btns;
}

const liveBtns = buildBoard('live-board');
const targetBtns = buildBoard('target-board');
for (const n of NODE_ORDER) {
  liveBtns[n].addEventListener('click', () => nodeClicked(n));
}

function renderNodes(btns, stones, snares, opts) {
  for (const n of NODE_ORDER) {
    let cls = 'stone-node stone-node--' + n;
    const s = stones[n];
    if (s === 'red' || s === 'blue') cls += ' stone-node--' + s;
    if (s === 'X') cls += ' stone-node--destroyed';
    if (snares && snares[n]) cls += ' stone-node--snare-' + snares[n];
    if (opts) {
      if (validMoves[n]) cls += ' stone-node--valid-move-' + validMoves[n];
      if (pushOptions[n]) cls += ' stone-node--valid-move-' + pushOptions[n];
      if (lastPlayNode === n && !validMoves[n]) cls += ' stone-node--last-play';
    }
    btns[n].className = cls;
  }
}

function renderLive() {
  if (!liveBoard) return;
  renderNodes(liveBtns, liveBoard.stones, liveBoard.snares, true);
}

function sfnStones(sfn) {
  const d = sfnToDict(sfn);
  return d;
}

function renderTarget(c) {
  const d = sfnToDict(c.sfnAfter);
  renderNodes(targetBtns, d.stones, d.snares || {}, false);
  const b = sfnToDict(c.sfnBefore);
  const diffs = [];
  for (const n of NODE_ORDER) {
    if ((b.stones[n] || null) !== (d.stones[n] || null)) {
      diffs.push(n + ' ' + (b.stones[n] || '·') + '→' + (d.stones[n] || '·'));
    }
  }
  const tb = c.sfnBefore.split(' '), ta = c.sfnAfter.split(' ');
  const meta = [];
  [[3, 'counters'], [4, 'locks'], [5, 'springlocks']].forEach(([i, name]) => {
    if (tb[i] !== ta[i]) meta.push(name + ' ' + tb[i] + '→' + ta[i]);
  });
  document.getElementById('deltas').textContent =
    'changed: ' + diffs.join(', ') + (meta.length ? ' | ' + meta.join(' | ') : '');
}

function renderSpells(c) {
  const el = document.getElementById('spells');
  el.innerHTML = '';
  c.spellNames.forEach((name, i) => {
    const nodes = (POSITIONS[i + 1] || []).join(' ');
    const kind = i < 3 ? 'ritual' : i < 6 ? 'sorcery' : 'charm';
    const d = document.createElement('div');
    d.className = 'spell-card';
    d.innerHTML = '<img src="../static/images/spells/' + name + '.png" ' +
      'onerror="this.style.display=\'none\'">' +
      '<div>' + name.replace(/_/g, ' ') + '</div>' +
      '<div class="pos">' + kind + ' · ' + nodes + '</div>';
    el.appendChild(d);
  });
}

function setMsg(text) { document.getElementById('msg').textContent = text || ''; }

function setActions(list) {
  const el = document.getElementById('actions');
  el.innerHTML = '';
  (list || []).forEach(a => {
    const b = document.createElement('button');
    b.textContent = a === 'pass' ? 'End turn (pass)' : a.replace(/_/g, ' ');
    b.onclick = () => sendToken(a);
    el.appendChild(b);
  });
}

function nodeClicked(n) { sendToken(n); }

function sendToken(tok) {
  if (!gc) return;
  pushOptions = {};
  gc.handlePlayerAction(tok);
}

function makeEmit(gen) {
  return (payload) => {
    if (gen !== generation || !payload) return;
    if (payload.type === 'message') {
      setMsg(payload.message);
      validMoves = payload.moveoptions || {};
      setActions(payload.actionlist || []);
      renderLive();
    } else if (payload.type === 'pushingoptions') {
      validMoves = {};
      pushOptions = {};
      for (const k of Object.keys(payload)) {
        if (k !== 'type' && k !== 'sourceNode') pushOptions[k] = payload[k];
      }
      renderLive();
    } else if (payload.type === 'boardstate' || payload.type === 'sfn_update') {
      renderLive();
    } else if (payload.type === 'new_stone_animation'
        || payload.type === 'push_animation'
        || payload.type === 'crush_animation') {
      renderLive();
    }
  };
}

async function playCase(c) {
  const gen = ++generation;
  validMoves = {}; pushOptions = {}; lastPlayNode = null;
  document.getElementById('verdict').textContent = '';
  const variant = normalizeVariant(c.variant);
  gc = new GameController(makeEmit(gen), { variant });
  const board = new SigilBoard(c.spellNames, variant);
  board.loadFromSfn(c.sfnBefore);
  gc.board = board;
  liveBoard = board;
  board.turnCounter = c.turnNumber;
  board.whoseTurn = c.color;
  board.update();
  renderLive();
  document.getElementById('mover').textContent = c.color;

  gc._currentTurnActions = [];
  // Start-of-turn preamble (mirrors reconstructGameLog): Providence
  // shift, then Aftershock burns through the real prompt flow.
  const extra = board.pendingMoves[c.color].length ? board.pendingMoves[c.color].shift() : 0;
  board.movesLeftThisTurn = 1 + extra;
  board.movesGrantedThisTurn = 1 + extra;
  const burnsNow = board.pendingBurns[c.color].length ? board.pendingBurns[c.color].shift() : 0;
  board.burnsThisTurn = burnsNow;
  try {
    if (burnsNow > 0 && !board.gameover) {
      await resolveBurnsAtTurnStart(board, c.color, burnsNow,
        gc.getInput.bind(gc), gc.emit);
      board.burnsThisTurn = 0;
    }
    if (!board.gameover) {
      await gc._takeTurn(c.color, true, true, true, true);
      gc._eotTriggers(c.color);
    }
  } catch (e) {
    if (gen !== generation) return; // superseded by reset/skip
    console.error(e);
    setMsg('Engine error: ' + (e && e.message));
    return;
  }
  if (gen !== generation) return;
  board.update();
  finishAttempt(c);
}

function finishAttempt(c) {
  setActions([]);
  validMoves = {}; pushOptions = {};
  renderLive();
  const got = boardToSfn(liveBoard);
  const v = document.getElementById('verdict');
  if (got === c.sfnAfter) {
    solutions[caseId(c)] = {
      key: c.key, turnNumber: c.turnNumber, color: c.color,
      actions: gc._currentTurnActions.slice(),
    };
    localStorage.setItem(LS_KEY, JSON.stringify(solutions));
    updateSolvedCount();
    v.innerHTML = '<span class="status-good">SOLVED — transcript recorded: '
      + gc._currentTurnActions.join(' ') + '</span>';
    setMsg('Solved! Advancing…');
    setTimeout(() => { if (document.getElementById('verdict').textContent.startsWith('SOLVED')) nextUnsolvedCase(); }, 1400);
  } else {
    const want = sfnToDict(c.sfnAfter), have = sfnToDict(got);
    const diffs = [];
    for (const n of NODE_ORDER) {
      if ((want.stones[n] || null) !== (have.stones[n] || null)) {
        diffs.push(n + ': got ' + (have.stones[n] || '·') + ', want ' + (want.stones[n] || '·'));
      }
    }
    v.innerHTML = '<span class="status-bad">Not a match — ' +
      (diffs.length ? diffs.slice(0, 8).join('; ') : 'stones match but counters/locks differ') +
      '</span>. Reset turn to retry.';
    setMsg('No match. Hit "Reset turn" to try again.');
  }
}

function loadCase(i) {
  idx = Math.max(0, Math.min(DATA.cases.length - 1, i));
  const c = DATA.cases[idx];
  document.getElementById('case-title').textContent =
    'Case ' + (idx + 1) + '/' + DATA.cases.length + ' — pattern #' + c.cluster +
    ' (' + c.clusterSize + ' turns), game ' + c.key + ', turn ' + c.turnNumber +
    ', ' + c.color + ' to move' + (solutions[caseId(c)] ? ' — SOLVED' : '');
  document.getElementById('case-sig').textContent = c.signature +
    (c.cast ? ' | deduced cast: ' + c.cast : '');
  document.getElementById('case-meta').textContent =
    c.variant + ' | spells: ' + c.spellNames.join(', ');
  renderTarget(c);
  renderSpells(c);
  playCase(c);
}

function resetTurn() { loadCase(idx); }
function prevCase() { loadCase(idx - 1); }
function nextCase() { loadCase(idx + 1); }
function nextUnsolvedCase() {
  for (let i = idx + 1; i < DATA.cases.length; i++) {
    if (!solutions[caseId(DATA.cases[i])]) { loadCase(i); return; }
  }
  setMsg('No unsolved cases after this one.');
}
function nextUnsolved() {
  // Jump to the next PATTERN with no solved member yet.
  const solvedClusters = new Set();
  DATA.cases.forEach(c => { if (solutions[caseId(c)]) solvedClusters.add(c.cluster); });
  for (let i = idx + 1; i < DATA.cases.length; i++) {
    const c = DATA.cases[i];
    if (!solvedClusters.has(c.cluster) && !solutions[caseId(c)]) { loadCase(i); return; }
  }
  setMsg('No further unsolved patterns.');
}

function updateSolvedCount() {
  const n = Object.keys(solutions).length;
  document.getElementById('n-solved').textContent = n;
  document.getElementById('solved-count').textContent = n + ' solved';
}

function downloadSolutions() {
  const blob = new Blob([JSON.stringify(solutions, null, 1)],
                        { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'solved_turns.json';
  a.click();
}
function clearSolutions() {
  if (!confirm('Clear all locally stored solutions?')) return;
  solutions = {};
  localStorage.setItem(LS_KEY, '{}');
  updateSolvedCount();
  loadCase(idx);
}

updateSolvedCount();
loadCase(0);
</script>
</body>
</html>
'''


if __name__ == '__main__':
    main()
