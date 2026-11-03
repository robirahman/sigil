// Walk a puzzle's solution with "Show solution", headlessly:
//   node puzzle-walk-test.js <docs dir> <puzzle index> <follow|deviate>
// follow:  Show solution, then play each ringed turn (single plain moves
//          only) and check the AI answers with the stored defence and the
//          next turn is ringed, to the mate.
// deviate: Show solution, then play a different first move and check the
//          walk stops and the engine replies.
// Exits non-zero on a failed check or a page error.
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');
const DOCS = process.argv[2], P = process.argv[3] || '879', MODE = process.argv[4] || 'follow';
const PORT = 8866 + Math.floor(Math.random() * 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function waitPort(port, ms) {
  return new Promise((res, rej) => { const t0 = Date.now(); (function tick() {
    http.get({ host: '127.0.0.1', port, path: '/' }, r => { r.resume(); res(); })
      .on('error', () => Date.now() - t0 > ms ? rej(new Error('server not up')) : setTimeout(tick, 200)); })(); });
}
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failures++; };
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS], { stdio: 'ignore' });
  try {
    await waitPort(PORT, 15000);
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const logs = [];
    page.on('console', m => { if (m.type() === 'error') logs.push('console: ' + m.text().slice(0, 300)); });
    page.on('pageerror', e => logs.push('pageerror: ' + e.message));
    await page.goto(`http://127.0.0.1:${PORT}/puzzles.html?p=${P}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#puzzle-root [x-data]', { visible: true, timeout: 30000 });
    await sleep(2500);
    const state = () => page.evaluate(() => {
      const d = window.Alpine.$data(document.querySelector('#puzzle-root [x-data]'));
      const g = d._puzzleGuideNode ? JSON.parse(JSON.stringify(window.Alpine.raw(d._puzzleGuideNode))) : null;
      return { status: d.puzzleStatus, msg: d.puzzleMessage, diag: d.puzzleDiagnostic, whoseTurn: d.whoseTurn,
        actionList: Object.values(d.actionList || {}), validMoves: Object.keys(d.validMoves || {}), winner: d.winner,
        aiThinking: d.aiThinking, mate: d.puzzle.mate, mover: d.puzzle.mover, guiding: !!d._puzzleGuiding,
        rings: Object.keys(d.puzzleSolutionNodes || {}).sort(), guide: g };
    });
    const ringedDom = () => page.evaluate(() => [...document.querySelectorAll('.stone-node--solution')]
      .map(e => e.id.replace('stone-node--', '')).sort());
    const waitFor = async (pred, ms) => { const t0 = Date.now(); let s;
      while (Date.now() - t0 < ms) { s = await state(); if (pred(s)) return s; await sleep(500); } return s; };
    const play = async (node) => {
      await page.click(`#stone-node--${node}`);
      await sleep(600);
      const s = await state();
      if (!s.actionList.includes('pass')) throw new Error('no End Turn after ' + node + ': ' + JSON.stringify(s.actionList));
      await page.click('.action-button--end-turn');
    };
    let st = await state();
    console.log(`puzzle ${P}: mate in ${st.mate}, ${st.mover} to move (${MODE})`);
    await page.evaluate(() => window.Alpine.$data(document.querySelector('#puzzle-root [x-data]')).puzzleShowSolution());
    await sleep(300);
    st = await state();
    check(st.status === 'revealed' && st.guiding && !!st.guide, 'Show solution starts the walk');
    check(/your turn 1 of /.test(st.msg), 'message names turn 1: ' + st.msg);
    const nodesOf = (acts) => [...new Set(acts.filter(a => a && a.node).map(a => a.node))].sort();
    if (MODE === 'deviate') {
      const sol = new Set(nodesOf(st.guide.actions));
      const other = st.validMoves.find(n => !sol.has(n));
      await play(other);
      st = await waitFor(s => s.whoseTurn === s.mover && !s.aiThinking, 30000);
      check(!st.guiding && st.rings.length === 0, 'the walk stops off the line');
      check(/leaves the solution line/.test(st.msg), 'message: ' + st.msg);
      check(st.whoseTurn === st.mover, 'the engine replied');
    } else {
      for (let turn = 1; turn <= st.mate; turn++) {
        const acts = (st.guide.actions || []).filter(a => a.type !== 'pass');
        check(JSON.stringify(st.rings) === JSON.stringify(await ringedDom()), `turn ${turn}: board rings match the guide (${st.rings.join(' ')})`);
        check(acts.every(a => st.rings.includes(a.node)), `turn ${turn}: the ringed nodes cover the solution turn`);
        if (acts.length !== 1 || !['move', 'blink', 'hard_move'].includes(acts[0].type)) { console.log('SKIP: not a single plain move'); break; }
        await play(acts[0].node);
        if (turn === st.mate) {
          st = await waitFor(s => s.winner, 15000);
          check(st.winner === st.mover, 'the mover wins');
          check(/solution is complete/.test(st.msg), 'message: ' + st.msg);
          break;
        }
        st = await waitFor(s => s.guide || !s.guiding, 30000);
        check(st.guiding && !!st.guide, `turn ${turn}: the AI played the stored defence and turn ${turn + 1} is ringed`);
        check(new RegExp('your turn ' + (turn + 1) + ' of').test(st.msg), 'message: ' + st.msg);
        check(!st.diag, 'no replay mismatch');
        if (!st.guide) break;
      }
    }
    check(logs.length === 0, 'no page errors' + (logs.length ? ':\n  ' + logs.join('\n  ') : ''));
    await browser.close();
  } finally { srv.kill(); }
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
