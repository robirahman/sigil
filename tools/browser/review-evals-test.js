// Headless check that the game review panel picks up the Rust engine's stored
// per-position evaluation (game_evals/<roomCode>) instead of computing the
// Caveman review. Needs network access to Firebase, so it runs against the live
// site (or any served copy) rather than a local http.server:
//
//   node tools/browser/review-evals-test.js https://sigilbattle.com <roomCode>
//
// Prints the loaded review's source/modelVersion, the eval readout at a few
// positions, the accuracies, and every console / page error.
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'https://sigilbattle.com', CODE = process.argv[3];
if (!CODE) { console.error('usage: node review-evals-test.js <base-url> <roomCode>'); process.exit(2); }

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text().slice(0, 300)); });
  page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 300)));
  try {
    await page.goto(`${BASE}/multiplayer.html?id=${encodeURIComponent(CODE)}`, { waitUntil: 'networkidle2', timeout: 60000 });
    // The finished room's replay populates reviewSfns; wait for it.
    await page.waitForFunction(() => {
      const el = [...document.querySelectorAll('[x-data]')].find(e => /gameBoard\(/.test(e.getAttribute('x-data') || ''));
      const d = el && window.Alpine && Alpine.$data(el);
      return d && Array.isArray(d.reviewSfns) && d.reviewSfns.length > 1;
    }, { timeout: 60000 });
    const state = () => page.evaluate(() => {
      const el = [...document.querySelectorAll('[x-data]')].find(e => /gameBoard\(/.test(e.getAttribute('x-data') || ''));
      const d = Alpine.$data(el);
      const r = d.aiReview;
      return {
        plies: d.reviewSfns.length, room: d._roomCodeForReview, computing: d.aiReviewComputing,
        review: r && { source: r.source || 'caveman', modelVersion: r.modelVersion, mode: r.mode, depth: r.engineDepth,
                       n: r.evalPerPly.length, redAccuracy: +r.redAccuracy.toFixed(1), blueAccuracy: +r.blueAccuracy.toFixed(1),
                       mates: (r.matePerPly || []).filter(x => x).length, terminal: r.terminalWinner },
      };
    });
    console.log('loaded:', JSON.stringify(await state()));
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('[x-data]')].find(e => /gameBoard\(/.test(e.getAttribute('x-data') || ''));
      Alpine.$data(el).startAiReview('quick');
    });
    await page.waitForFunction(() => {
      const el = [...document.querySelectorAll('[x-data]')].find(e => /gameBoard\(/.test(e.getAttribute('x-data') || ''));
      const d = Alpine.$data(el); return !!d.aiReview && !d.aiReviewComputing;
    }, { timeout: 120000 });
    const st = await state();
    console.log('review:', JSON.stringify(st.review));
    // Readout at the first, a middle and the last position.
    const texts = await page.evaluate((n) => {
      const el = [...document.querySelectorAll('[x-data]')].find(e => /gameBoard\(/.test(e.getAttribute('x-data') || ''));
      const d = Alpine.$data(el); const out = {};
      for (const i of [0, Math.floor((n - 1) / 2), n - 1]) { d.reviewIndex = i; out[i] = d.aiReviewCurrentEvalText(); }
      return out;
    }, st.review.n);
    console.log('eval text by position:', JSON.stringify(texts));
    console.log('errors:', logs.length ? '\n  ' + logs.join('\n  ') : 'none');
    if (!st.review || st.review.source !== 'rust') { console.log('TEST FAILED: review did not come from game_evals'); process.exitCode = 1; }
  } catch (e) {
    console.log('TEST FAILED:', String(e && e.message || e).slice(0, 500));
    console.log('errors:', logs.join('\n  '));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
