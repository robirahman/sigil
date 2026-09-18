// Drive docs/puzzles.html like a player, headlessly:
//   node puzzle_flow_test.js <docs dir> <puzzle index> <correct|wrong>
// correct: play the first stored solution (moves/hard moves only; skips others)
// wrong:   play a legal first move that is NOT a stored solution and watch the
//          engine judge it and reply.
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');
const DOCS = process.argv[2], P = process.argv[3] || '0', MODE = process.argv[4] || 'correct';
const PORT = 8766 + Math.floor(Math.random() * 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function waitPort(port, ms) {
  return new Promise((res, rej) => { const t0 = Date.now(); (function tick() {
    http.get({ host: '127.0.0.1', port, path: '/' }, r => { r.resume(); res(); })
      .on('error', () => Date.now() - t0 > ms ? rej(new Error('server not up')) : setTimeout(tick, 200)); })(); });
}
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS], { stdio: 'ignore' });
  try {
    await waitPort(PORT, 15000);
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    const logs = [];
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text().slice(0, 300)); });
    page.on('pageerror', e => logs.push('pageerror: ' + e.message));
    page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) logs.push('http ' + r.status() + ': ' + r.url().slice(0, 120)); });
    await page.goto(`http://127.0.0.1:${PORT}/puzzles.html?p=${P}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#puzzle-root [x-data]', { visible: true, timeout: 30000 });
    await sleep(2500);
    const state = () => page.evaluate(() => {
      const d = window.Alpine.$data(document.querySelector('#puzzle-root [x-data]'));
      return { status: d.puzzleStatus, step: d.puzzleStep, moves: d.puzzleMoves, msg: d.puzzleMessage, judge: d.puzzleJudge,
        diag: d.puzzleDiagnostic, whoseTurn: d.whoseTurn, awaiting: d.awaiting, actionList: Object.values(d.actionList || {}),
        validMoves: Object.keys(d.validMoves || {}), winner: d.winner, aiThinking: d.aiThinking,
        mate: d.puzzle.mate, mover: d.puzzle.mover, sfn: d.currentSfn, sol0: JSON.parse(JSON.stringify(window.Alpine.raw(d.puzzle).solutions[0])) };
    });
    let st = await state();
    console.log(`puzzle ${P}: mate-in-${st.mate}, ${st.mover} to move; valid first moves: ${st.validMoves.length}`);
    const sol = st.sol0;
    const simple = a => a && (a.type === 'move' || a.type === 'blink' || (a.type === 'hard_move' && !a.pushed_to));
    const firstActs = (sol.actions || []).filter(a => a.type !== 'pass');
    let node;
    if (MODE === 'correct') {
      if (!(firstActs.length === 1 && simple(firstActs[0]))) { console.log('SKIP: stored solution is not a single plain move:', JSON.stringify(firstActs)); await browser.close(); return; }
      node = firstActs[0].node;
    } else {
      const solNodes = new Set((sol.actions || []).map(a => a.node));
      node = st.validMoves.find(n => !solNodes.has(n));
      if (!node) { console.log('SKIP: no non-solution first move'); await browser.close(); return; }
    }
    console.log(`clicking ${node} then End Turn (${MODE})`);
    await page.click(`#stone-node--${node}`);
    await sleep(600);
    st = await state();
    console.log('after node click:', JSON.stringify({ awaiting: st.awaiting, actionList: st.actionList, msg: st.msg }));
    if (st.actionList.includes('pass')) {
      await page.click('.action-button--end-turn');
    } else {
      console.log('no End Turn offered (awaiting ' + st.awaiting + '); state: ' + JSON.stringify(st.actionList));
    }
    // wait for the judge / AI reply / game over, up to 25 s
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < 25000) {
      await sleep(1000);
      st = await state();
      const snap = JSON.stringify({ status: st.status, moves: st.moves, whoseTurn: st.whoseTurn, aiThinking: st.aiThinking, winner: st.winner });
      if (snap !== last) { console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', snap); last = snap; }
      if (st.winner || (st.status === 'failed' && !st.aiThinking && st.whoseTurn === st.mover) || (st.status === 'playing' && st.moves >= 1 && !st.aiThinking && st.whoseTurn === st.mover && st.judge)) break;
    }
    st = await state();
    console.log('final:', JSON.stringify({ status: st.status, msg: st.msg, judge: st.judge, diag: st.diag, winner: st.winner, moves: st.moves }));
    console.log('errors:', logs.length ? '\n  ' + logs.join('\n  ') : 'none');
    await browser.close();
  } finally { srv.kill(); }
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
