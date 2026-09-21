// Headless check of the competitive opening selector on a served game page:
// force the human to blue (so the Rust AI, as red, opens the game), start
// `game.html?ai=rust_hard&variant=competitive`, wait for red's first stone and
// print where it went together with the spell draw, so the pick can be
// compared with `sigil_engine.opening_pick` for that draw.
//
//   node tools/browser/opening-live-test.js https://sigilbattle.com [rust_hard]
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'https://sigilbattle.com', TIER = process.argv[3] || 'rust_hard';

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text().slice(0, 200)); });
  page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
  await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem('sigil_rematch_human_color', 'blue'); } catch (e) { /* ignore */ } });
  try {
    await page.goto(`${BASE}/game.html?ai=${TIER}&variant=competitive`, { waitUntil: 'networkidle2', timeout: 90000 });
    const root = () => [...document.querySelectorAll('[x-data]')].find(e => /gameBoard\(/.test(e.getAttribute('x-data') || ''));
    await page.waitForFunction(() => {
      const el = [...document.querySelectorAll('[x-data]')].find(e => /gameBoard\(/.test(e.getAttribute('x-data') || ''));
      const d = el && window.Alpine && Alpine.$data(el);
      if (!d) return false;
      const red = document.querySelectorAll('.stone-node--red, .stone--red, [data-color="red"]').length;
      return red > 0 || (d.messageHistory || []).some(m => /Red AI|opening/.test(m));
    }, { timeout: 120000 });
    const info = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[x-data]')].find(e => /gameBoard\(/.test(e.getAttribute('x-data') || ''));
      const d = Alpine.$data(el);
      const keys = Object.keys(d).filter(k => /spell|sfn|color|Color|turn|whose|stones|board/i.test(k)).slice(0, 40);
      const redNodes = [...document.querySelectorAll('[aria-label]')].filter(n => /red/i.test(n.className) || /red/i.test(n.getAttribute('data-color') || '')).map(n => n.getAttribute('aria-label'));
      return { keys, myColor: d.myColor, spellNames: d.spellNames || (d.board && d.board.spellNames) || null,
               redNodes, history: (d.messageHistory || []).slice(-6) };
    });
    console.log(JSON.stringify(info, null, 1));
    console.log('errors:', logs.length ? '\n  ' + logs.join('\n  ') : 'none');
  } catch (e) {
    console.log('TEST FAILED:', String(e && e.message || e).slice(0, 400));
    console.log('errors:', logs.join('\n  '));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
