// Headless check of docs/puzzles.html: load puzzle ?p=<N>, capture console/page
// errors, click "Show solution", and report what the Alpine component holds.
//   node puzzle_page_test.js <docs dir> [puzzle index]
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');

const DOCS = process.argv[2];
const P = process.argv[3] || '0';
const PORT = 8765;

function waitPort(port, ms) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function tick() {
      http.get({ host: '127.0.0.1', port, path: '/' }, r => { r.resume(); res(); })
        .on('error', () => Date.now() - t0 > ms ? rej(new Error('server not up')) : setTimeout(tick, 200));
    })();
  });
}

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS], { stdio: 'ignore' });
  try {
    await waitPort(PORT, 15000);
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const logs = [];
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text()); });
    page.on('pageerror', e => logs.push('pageerror: ' + e.message));
    page.on('requestfailed', r => logs.push('requestfailed: ' + r.url().slice(0, 120)));
    page.on('response', r => { if (r.status() >= 400) logs.push('http ' + r.status() + ': ' + r.url().slice(0, 120)); });
    await page.goto(`http://127.0.0.1:${PORT}/puzzles.html?p=${P}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#puzzle-root [x-data]', { visible: true, timeout: 30000 });
    // let the controller start (500 ms delay + first prompt)
    await new Promise(r => setTimeout(r, 2500));
    const state = async () => page.evaluate(() => {
      const el = document.querySelector('#puzzle-root [x-data]');
      const d = window.Alpine && window.Alpine.$data(el);
      return d ? {
        status: d.puzzleStatus, step: d.puzzleStep, msg: d.puzzleMessage, whoseTurn: d.whoseTurn,
        awaiting: d.awaiting, actionList: d.actionList, hasShow: typeof d.puzzleShowSolution,
        solText: d.puzzleSolutionText, mate: d.puzzle && d.puzzle.mate, mover: d.puzzle && d.puzzle.mover,
        nsol: d.puzzle && d.puzzle.solutions && d.puzzle.solutions.length,
        stones: Object.values(d.nodes).filter(Boolean).length,
      } : { noAlpineData: true };
    });
    console.log('before click:', JSON.stringify(await state()));
    const buttons = await page.$$('.puzzle-panel__nav button, .puzzle-panel__nav a');
    const labels = [];
    for (const b of buttons) labels.push(await page.evaluate(el => el.textContent.trim() + (el.offsetParent === null ? ' [hidden]' : ''), b));
    console.log('nav controls:', JSON.stringify(labels));
    const show = await page.evaluateHandle(() => [...document.querySelectorAll('.puzzle-panel__nav button')].find(b => /Show solution/.test(b.textContent)));
    if (show && show.asElement()) {
      await show.asElement().click();
      await new Promise(r => setTimeout(r, 800));
      console.log('after click:', JSON.stringify(await state()));
      const panel = await page.evaluate(() => { const el = document.querySelector('.puzzle-panel__solution'); const rings = [...document.querySelectorAll('.stone-node--solution')].map(n => n.getAttribute('aria-label')); const feed = [...document.querySelectorAll('.feed--history li')].map(li => li.textContent).filter(t => /Solution/.test(t)); return el ? { display: getComputedStyle(el).display, text: el.innerText.slice(0, 300), rings, feed } : null; });
      console.log('solution panel:', JSON.stringify(panel));
    } else {
      console.log('Show solution button not found');
    }
    console.log('console/page errors:', logs.length ? '\n  ' + logs.join('\n  ') : 'none');
    await browser.close();
  } finally {
    srv.kill();
  }
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
