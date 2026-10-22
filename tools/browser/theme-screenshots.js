// Screenshot every theme on the boards a player sees, for review of the
// theme palettes (tools/themes/). Each shot stages one board with stones of
// both colours, a Fissure wall, a last play, valid-move glows and both lock
// rings, so every element the themes recolour is on screen at once.
//   node tools/browser/theme-screenshots.js <docs dir> <out dir> [theme ...]
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DOCS = process.argv[2];
const OUT = process.argv[3];
const PORT = 8767;
const THEMES = process.argv.length > 4 ? process.argv.slice(4) : ['default', 'frost', 'parchment', 'forest', 'volcanic'];

function waitPort(port, ms) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function tick() {
      http.get({ host: '127.0.0.1', port, path: '/' }, r => { r.resume(); res(); })
        .on('error', () => Date.now() - t0 > ms ? rej(new Error('server not up')) : setTimeout(tick, 200));
    })();
  });
}

// Stage the puzzle board: add a wall, both glows, both locks and a last play.
async function stage(page) {
  await page.evaluate(() => {
    const el = document.querySelector('#puzzle-root [x-data]');
    const d = window.Alpine.$data(el);
    const empty = Object.keys(d.nodes).filter(n => !d.nodes[n]);
    const red = Object.keys(d.nodes).filter(n => d.nodes[n] === 'red');
    d.nodes[empty[0]] = 'X';
    d.nodes[empty[1]] = 'X';
    d.validMoves = { [empty[2]]: 'red', [empty[3]]: 'red', [empty[4]]: 'blue' };
    if (red.length) d.lastPlay = red[0];
    const spells = Object.values(d.spellDict || {});
    if (spells.length > 1) { d.redLock = spells[0]; d.blueLock = spells[1]; }
  });
  await new Promise(r => setTimeout(r, 2600));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS], { stdio: 'ignore' });
  const errors = [];
  try {
    await waitPort(PORT, 15000);
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
    for (const theme of THEMES) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1400, height: 1000 });
      page.on('pageerror', e => errors.push(`${theme} pageerror: ${e.message}`));
      page.on('response', r => { if (r.status() >= 400) errors.push(`${theme} http ${r.status()}: ${r.url()}`); });
      await page.evaluateOnNewDocument(t => { try { localStorage.setItem('sigil_theme', t); } catch (e) {} }, theme);
      await page.goto(`http://127.0.0.1:${PORT}/puzzles.html?p=3`, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.waitForSelector('#puzzle-root [x-data]', { visible: true, timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
      await stage(page);
      const board = await page.$('.game-board-container');
      await board.screenshot({ path: path.join(OUT, `board-${theme}.png`) });
      await page.screenshot({ path: path.join(OUT, `page-${theme}.png`) });
      await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.screenshot({ path: path.join(OUT, `index-${theme}.png`) });
      // Drawn (Cataclysm) board: render the geometry's SVG on a blank page
      // that loads the site stylesheet and the theme.
      await page.goto(`http://127.0.0.1:${PORT}/puzzles.html?p=3`, { waitUntil: 'networkidle2', timeout: 60000 });
      const ok = await page.evaluate(() => {
        if (typeof boardGeometry !== 'function') return false;
        const g = boardGeometry('pentagon');
        document.body.innerHTML = `<div style="width:900px;height:900px">${g.svg}</div>`;
        return true;
      }).catch(e => { errors.push(`${theme} drawn: ${e.message}`); return false; });
      if (ok) await page.screenshot({ path: path.join(OUT, `drawn-${theme}.png`), clip: { x: 0, y: 0, width: 900, height: 900 } });
      await page.close();
    }
    await browser.close();
  } finally {
    srv.kill();
  }
  if (errors.length) { console.log(errors.join('\n')); process.exitCode = 1; }
  console.log('shots in', OUT);
})();
