'use strict';
/**
 * Line-oriented bridge to the DEPLOYED JS engine, so the Rust engine can be
 * measured against what actually ships on sigilbattle.com.
 *
 * Loads the same ten files in the same order as ai-worker.js importScripts(),
 * exactly as tools/arena/engine.js does, and calls cavemanSearch directly — no
 * DOM, no postMessage — so the move chosen from a position is the in-browser move
 * at equal search depth.
 *
 * State crosses the boundary as EXPLICIT FIELDS (a 39-char stone string plus
 * counters/locks), mirroring SimBoard.fromSigilBoard, rather than as SFN. The JS
 * SimBoard has no SFN reader, and inventing one here would put an unverified
 * parser in the measurement path.
 *
 * Protocol, one JSON object per line, one reply per line:
 *   {"cmd":"set","spells":[..9..],"variant":"standard","stones":"...39...",
 *    "turn":"red","turnCounter":0,"spellCounter":[0,0],
 *    "lock":[null,null],"springlock":[null,null]}   -> {ok:true, ...state}
 *   {"cmd":"move","timeLimit":0.2}                  -> {...state, depth, nodes,
 *                                                       gameover, winner}
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');

const ENGINE_FILES = ['constants.js','notation.js','sim-board.js','features.js',
  'sigil-net.js','sigil-net-graph.js','strategic-eval.js','enumerator.js',
  'minimax-ai.js','caveman-ai.js'];
const dir = process.argv[2];
const parts = ENGINE_FILES.map(f =>
  `// ===== ${f} =====\n` + fs.readFileSync(path.join(dir, f), 'utf8'));
parts.push(`;globalThis.__sigilEngine = { SimBoard, SimTurn, SimAction,
  cavemanSearch, _minimaxApplyTurn, NODE_ORDER };`);
vm.runInThisContext(parts.join('\n;\n'), { filename: 'sigil-engine-bundle.js' });
const E = globalThis.__sigilEngine;
const NO = E.NODE_ORDER;

let board = null;
let history = {};

function stoneString(b) {
  return NO.map(n => b.stones[n] === 'red' ? 'r' : b.stones[n] === 'blue' ? 'b'
                   : b.stones[n] === 'X' ? 'x' : '.').join('');
}
function stateOf(b) {
  return {
    stones: stoneString(b), turn: b.whoseTurn, turnCounter: b.turnCounter,
    spellCounter: [b.spellCounter.red, b.spellCounter.blue],
    lock: [b.lock.red, b.lock.blue],
    springlock: [b.springlock.red, b.springlock.blue],
    gameover: !!b.gameover, winner: b.winner || null,
    total: [b.totalStones.red, b.totalStones.blue],
  };
}

// readline does NOT await an async 'line' handler, so with several commands
// buffered the handlers interleave and a later one reads a pre-move board — both
// sides then play as the same colour. Serialise through an explicit promise chain.
const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on('line', (line) => { chain = chain.then(() => handle(line)); });

async function handle(line) {
  let m;
  try { m = JSON.parse(line); } catch (e) { console.log(JSON.stringify({error:'bad json'})); return; }
  try {
    if (m.cmd === 'set') {
      board = new E.SimBoard(m.spells, m.variant || 'standard');
      for (let i = 0; i < NO.length; i++) {
        const ch = m.stones[i];
        board.stones[NO[i]] = ch === 'r' ? 'red' : ch === 'b' ? 'blue' : ch === 'x' ? 'X' : null;
      }
      board.whoseTurn = m.turn;
      board.turnCounter = m.turnCounter;
      board.spellCounter = { red: m.spellCounter[0], blue: m.spellCounter[1] };
      board.lock = { red: m.lock[0], blue: m.lock[1] };
      board.springlock = { red: m.springlock[0], blue: m.springlock[1] };
      if (m.resetHistory) history = {};
      board.update();
      const k = board.loopingSnapshot();
      history[k] = (history[k] || 0) + 1;
      console.log(JSON.stringify(Object.assign({ ok: true }, stateOf(board))));
      return;
    }
    if (m.cmd === 'move') {
      const color = board.whoseTurn;
      const res = await E.cavemanSearch(board, color, {
        timeLimit: m.timeLimit === undefined ? 0.2 : m.timeLimit,
        maxDepth: m.maxDepth === undefined ? 64 : m.maxDepth,
        positionHistory: history,
        evalWeights: m.evalWeights || null,
      });
      // _minimaxApplyTurn already calls sim.advanceTurn(), which bumps
      // turnCounter and flips whoseTurn, and runs update()/checkGameOver.
      // Advancing again here double-counted the turn counter, which matters
      // because turnCounter gates the competitive-variant opening.
      board = E._minimaxApplyTurn(board, res.turn, color);
      const k = board.loopingSnapshot();
      history[k] = (history[k] || 0) + 1;
      console.log(JSON.stringify(Object.assign(stateOf(board), {
        depth: res.depth, nodes: res.nodes, moved: color,
        actions: res.turn.actions.map(a => ({t:a.type, n:a.node, p:a.pushed_to, s:a.spell})),
      })));
      return;
    }
    console.log(JSON.stringify({ error: 'unknown cmd' }));
  } catch (e) {
    console.log(JSON.stringify({ error: String((e && e.stack) || e).slice(0, 500) }));
  }
}
