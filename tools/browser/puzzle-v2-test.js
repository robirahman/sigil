// Assertions for the Puzzles page's v2 features, headless:
//   node tools/browser/puzzle-v2-test.js <docs dir> [puzzle json]
// The puzzle set is served from [puzzle json] (default: the committed one),
// plus a synthetic winning-turn puzzle built from a mate-in-1 puzzle whose
// solution is a single plain move, so the flow can be clicked:
//   * filters: ?set=, ?d=, ?tag= narrow the pool; the filter bar renders
//   * daily: ?daily=1 picks the same puzzle on every load; a solve extends a
//     streak that ended yesterday; a miss resets it
//   * mine=1: with a stubbed user_games map, only missed wins of that player
//   * winning turn: the stored key solves it; an off-key turn is judged by the
//     engine (accept_p 0 -> solved, accept_p 1.01 -> failed with a verdict)
// Exits 1 on the first failed assertion. Needs puppeteer (NODE_PATH) and the
// committed wasm build.
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DOCS = process.argv[2];
const SET = process.argv[3] || path.join(DOCS, 'static/puzzles/mate_puzzles.json');
const PORT = 8866 + Math.floor(Math.random() * 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(cond, what) {
  console.log((cond ? 'ok   ' : 'FAIL ') + what);
  if (!cond) failures++;
}
function waitPort(port, ms) {
  return new Promise((res, rej) => { const t0 = Date.now(); (function tick() {
    http.get({ host: '127.0.0.1', port, path: '/' }, r => { r.resume(); res(); })
      .on('error', () => Date.now() - t0 > ms ? rej(new Error('server not up')) : setTimeout(tick, 200)); })(); });
}

const data = JSON.parse(fs.readFileSync(SET, 'utf8'));
// The synthetic winning-turn puzzle: a mate-in-1 whose first stored line is
// one plain placement, re-labelled. Its index is past the real set's.
const plain = a => a && (a.type === 'move' || a.type === 'blink' || (a.type === 'hard_move' && !a.pushed_to));
const plainMate = set => set.puzzles.find(p => p.mate === 1 && p.solutions.length
  && p.solutions[0].actions.filter(a => a.type !== 'pass').length === 1
  && plain(p.solutions[0].actions[0]));
const base = plainMate(data)
  || plainMate(JSON.parse(fs.readFileSync(path.join(DOCS, 'static/puzzles/mate_puzzles.json'), 'utf8')));
if (!base) { console.log('FAIL no mate-in-1 puzzle with a plain-move solution to build the fixture from'); process.exit(1); }
const WIN_INDEX = data.puzzles.length;
function fixture(acceptP) {
  const w = JSON.parse(JSON.stringify(base));
  Object.assign(w, { id: 'test-winning', index: WIN_INDEX, kind: 'winning', mate: null,
    p_best: 0.9, p_second: 0.3, accept_p: acceptP, difficulty: 3, tags: ['Test tag'] });
  w.solutions = w.solutions.slice(0, 1).map(s => ({ actions: s.actions, after: s.after, key: s.key, p: 0.9 }));
  w.solution_keys = [w.solutions[0].key];
  const out = JSON.parse(JSON.stringify(data));
  out.puzzles = out.puzzles.concat([w]);
  return JSON.stringify(out);
}

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS], { stdio: 'ignore' });
  let browser;
  try {
    await waitPort(PORT, 15000);
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
    const errors = [];
    async function open(query, opts) {
      const page = await browser.newPage();
      // The service worker would answer the puzzle-set fetch from its cache,
      // past the interception below.
      await page.setBypassServiceWorker(true);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (/static\/puzzles\/mate_puzzles\.json/.test(req.url())) {
          return req.respond({ status: 200, contentType: 'application/json', body: fixture((opts && opts.acceptP) ?? 0.7) });
        }
        req.continue();
      });
      page.on('pageerror', e => errors.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error' && !/firebase|favicon|ERR_|net::/i.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
      if (opts && opts.before) await page.evaluateOnNewDocument(opts.before);
      await page.goto(`http://127.0.0.1:${PORT}/puzzles.html${query}`, { waitUntil: 'networkidle2', timeout: 60000 });
      return page;
    }
    const comp = page => page.evaluate(() => {
      const d = window.Alpine.$data(document.querySelector('#puzzle-root [x-data]'));
      return { id: d.puzzle.id, kind: d.puzzle.kind || 'mate', mate: d.puzzle.mate, status: d.puzzleStatus,
        msg: d.puzzleMessage, judge: d.puzzleJudge, valid: Object.keys(d.validMoves || {}),
        actions: Object.values(d.actionList || {}), title: document.querySelector('.puzzle-panel__title').textContent,
        progress: document.querySelector('.puzzle-panel__progress').textContent };
    });
    const ready = async page => {
      try {
        await page.waitForSelector('#puzzle-root [x-data]', { visible: true, timeout: 30000 });
      } catch (e) {
        const why = await page.$eval('#puzzle-loading', el => el.textContent).catch(() => '?');
        throw new Error('page did not start (' + page.url() + '): ' + why + ' ' + errors.join(' | '));
      }
      await sleep(2500);
    };

    // ---- filters
    for (const [q, test] of [
      ['?set=m2', s => s.kind === 'mate' && s.mate === 2],
      ['?set=m1&d=3', s => s.kind === 'mate' && s.mate === 1],
      ['?set=win', s => s.kind === 'winning'],
    ]) {
      const page = await open(q);
      await ready(page);
      const s = await comp(page);
      check(test(s), `filter ${q} shows a matching puzzle (${s.id}, ${s.title.trim()})`);
      const bar = await page.$eval('.puzzle-panel__filters', el => el.innerHTML);
      check(/Daily puzzle/.test(bar) && /Difficulty/.test(bar) && /<select/.test(bar), `filter bar renders for ${q}`);
      await page.close();
    }
    {
      const tag = 'Test tag';
      const page = await open('?tag=' + encodeURIComponent(tag));
      await ready(page);
      const s = await comp(page);
      check(s.id === 'test-winning', `?tag= narrows to the tagged puzzle (${s.id})`);
      await page.close();
    }

    // ---- daily puzzle and streak
    let dailyId = null;
    for (let k = 0; k < 2; k++) {
      const page = await open('?daily=1');
      await ready(page);
      const s = await comp(page);
      check(/Daily puzzle \d{4}-\d{2}-\d{2}/.test(s.title), `daily title (${s.title.trim()})`);
      if (k === 0) dailyId = s.id; else check(s.id === dailyId, `daily pick is stable across loads (${s.id})`);
      await page.close();
    }
    {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const page = await open('?daily=1', { before: `localStorage.setItem('sigil_puzzle_daily', JSON.stringify({ last: '${yesterday}', streak: 4, best: 4, done: {} }))` });
      await ready(page);
      await page.evaluate(() => window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_PUZZLE, 'solved'));
      const d = await page.evaluate(() => JSON.parse(localStorage.getItem('sigil_puzzle_daily')));
      check(d.streak === 5 && d.best === 5, `a daily solve after yesterday's extends the streak (${JSON.stringify(d)})`);
      await page.evaluate(() => window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_PUZZLE, 'failed'));
      const d2 = await page.evaluate(() => JSON.parse(localStorage.getItem('sigil_puzzle_daily')));
      check(d2.streak === 5, `only the day's first result counts (${d2.streak})`);
      const txt = await page.$eval('#puzzle-daily-status', el => el.textContent);
      check(/Daily streak: 5/.test(txt), `streak shown (${txt.trim()})`);
      await page.close();
    }

    // ---- my missed wins (stubbed user_games)
    {
      const missed = data.puzzles.find(p => p.played === false && p.game && p.game.id);
      const stub = { [missed.game.id]: missed.mover, 'not-a-puzzle-game': 'red' };
      const page = await open('?mine=1', { before: `window.SIGIL_PUZZLE_MY_GAMES_STUB = ${JSON.stringify(stub)};` });
      await ready(page);
      const s = await comp(page);
      const ids = await page.evaluate(() => window.SIGIL_PUZZLE.game.id);
      check(ids === missed.game.id, `mine=1 shows a missed win from the player's own game (${s.id})`);
      check(/of \d+ puzzles/.test(s.progress), `mine=1 progress line (${s.progress.trim().slice(0, 60)})`);
      await page.close();
    }

    // ---- winning-turn flow
    async function playWinning(acceptP, pickWrong) {
      const page = await open('?p=' + WIN_INDEX, { acceptP });
      await ready(page);
      let s = await comp(page);
      check(s.kind === 'winning' && /Winning turn/.test(s.title), `winning puzzle loads (${s.title.trim()})`);
      const solNode = base.solutions[0].actions[0].node;
      const node = pickWrong ? s.valid.find(n => n !== solNode) : solNode;
      await page.click(`#stone-node--${node}`);
      await sleep(600);
      s = await comp(page);
      if (s.actions.includes('pass')) await page.click('.action-button--end-turn');
      const t0 = Date.now();
      while (Date.now() - t0 < 90000) {
        await sleep(1000);
        s = await comp(page);
        if (s.status !== 'playing') break;
      }
      await page.close();
      return s;
    }
    let s = await playWinning(0.7, false);
    check(s.status === 'solved', `stored solution solves the winning puzzle (${s.status}: ${s.msg})`);
    s = await playWinning(0, true);
    check(s.status === 'solved' && /^Engine: after your turn you win \d+%/.test(s.judge), `off-key turn judged winning at accept_p 0 (${s.status}: ${s.judge})`);
    s = await playWinning(1.01, true);
    check(s.status === 'failed' && /win \d+%/.test(s.judge), `off-key turn judged losing at accept_p 1.01 (${s.status}: ${s.judge})`);

    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
  } catch (e) {
    console.log('FAIL exception: ' + (e && e.stack || e));
    failures++;
  } finally {
    if (browser) await browser.close();
    srv.kill();
  }
  console.log(failures ? `${failures} FAILED` : 'ALL OK');
  process.exit(failures ? 1 : 0);
})();
