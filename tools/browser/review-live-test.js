// Headless check of the live Rust-engine game review (game-review.js
// reviewGameRust / startAiReview) on a finished room:
//
//   node tools/browser/review-live-test.js <base-url> <roomCode> [quick|deep] [--compare]
//
// Opens multiplayer.html?id=<roomCode>, waits for the replayed game, then runs
// startAiReview(mode). A room with stored evals (game_evals) opens those; any
// other room computes the review in the page with the wasm engine at the
// Easy (quick) or Hard (deep) setting. --compare also runs reviewGameRust
// directly and prints its agreement with the stored game_evals document.
// Prints the review's source/version/tier, timings, eval readouts and every
// console / page error; exits 1 on failure.
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2], CODE = process.argv[3];
const MODE = process.argv[4] === 'deep' ? 'deep' : 'quick';
const COMPARE = process.argv.includes('--compare');
if (!BASE || !CODE) { console.error('usage: node review-live-test.js <base-url> <roomCode> [quick|deep] [--compare]'); process.exit(2); }

const board = () => {
  const el = [...document.querySelectorAll('[x-data]')].find(e => /gameBoard\(/.test(e.getAttribute('x-data') || ''));
  return el && window.Alpine && Alpine.$data(el);
};

(async () => {
  const browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 40 * 60 * 1000, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text().slice(0, 300)); });
  page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 300)));
  let failed = false;
  try {
    await page.goto(`${BASE}/multiplayer.html?id=${encodeURIComponent(CODE)}`, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForFunction(`(${board})() && Array.isArray((${board})().reviewSfns) && (${board})().reviewSfns.length > 1`, { timeout: 90000 });
    const labels = await page.evaluate(`({ quick: (${board})().aiReviewModeLabel('quick'), deep: (${board})().aiReviewModeLabel('deep') })`);
    console.log('labels:', JSON.stringify(labels));
    const t0 = Date.now();
    await page.evaluate(`(${board})().startAiReview('${MODE}')`);
    await page.waitForFunction(`(${board})().aiReview && !(${board})().aiReviewComputing || (${board})().aiReviewError`, { timeout: 30 * 60 * 1000 });
    const st = await page.evaluate(`(() => { const d = (${board})(); const r = d.aiReview;
      return { error: d.aiReviewError, plies: d.reviewSfns.length,
        review: r && { source: r.source || 'caveman', modelVersion: r.modelVersion, mode: r.mode, tier: r.engineTier || null,
          depth: r.engineDepth, n: r.evalPerPly.length, redAccuracy: +r.redAccuracy.toFixed(1), blueAccuracy: +r.blueAccuracy.toFixed(1),
          mates: (r.matePerPly || []).filter(x => x).length, terminal: r.terminalWinner || null, engineText: d.aiReviewEngineText() } }; })()`);
    console.log(`review (${((Date.now() - t0) / 1000).toFixed(1)} s):`, JSON.stringify(st.review), st.error ? 'ERROR ' + st.error : '');
    if (!st.review || st.error) failed = true;
    else {
      const texts = await page.evaluate(`(() => { const d = (${board})(); const n = d.aiReview.evalPerPly.length, out = {};
        for (const i of [0, Math.floor((n - 1) / 2), n - 2, n - 1]) { d.reviewIndex = i; out[i] = d.aiReviewCurrentEvalText(); } return out; })()`);
      console.log('eval text by position:', JSON.stringify(texts));
      // The graph's blunder dots render and jump to their ply when clicked.
      const dots = await page.evaluate(`(async () => { const d = (${board})(); d.reviewIndex = 0;
        await new Promise(r => setTimeout(r, 300));
        const cs = [...document.querySelectorAll('.ai-review-graph circle.ai-review-graph__dot')];
        if (!cs.length) return { dots: 0, expected: d.aiReviewGraphDots().length,
          panels: document.querySelectorAll('.ai-review-panel').length };   // panels 0 = the panel never rendered
        const ply = Number(cs[0].getAttribute('data-ply'));
        cs[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        return { dots: cs.length, expected: d.aiReviewGraphDots().length, clickedPly: ply, reviewIndex: d.reviewIndex }; })()`);
      console.log('graph dots:', JSON.stringify(dots));
      if (dots.dots !== dots.expected || (dots.dots && dots.reviewIndex !== dots.clickedPly + 1)) failed = true;
    }
    if (COMPARE) {
      const cmp = await page.evaluate(`(async () => { const d = (${board})(); const t = Date.now();
        const live = await reviewGameRust(d._gameLogForExport, '${MODE}');
        const secs = (Date.now() - t) / 1000;
        const doc = await loadGameEvals(firebase.database(), d._roomCodeForReview);
        const stored = doc ? rustEvalsToReview(doc, d._gameLogForExport) : null;
        if (!stored) return { secs, note: 'no stored evals to compare' };
        const a = live.stonesPerPly, b = stored.stonesPerPly; let n = 0, agree = 0, diff = 0;
        for (let i = 0; i < a.length; i++) if (typeof a[i] === 'number' && typeof b[i] === 'number') {
          n++; diff += Math.abs(a[i] - b[i]); if (Math.sign(Math.round(a[i])) === Math.sign(Math.round(b[i]))) agree++; }
        return { secs, plies: a.length, compared: n, signAgree: agree, meanAbsDiffStones: +(diff / Math.max(1, n)).toFixed(2),
                 liveDepth: live.engineDepth, storedDepth: stored.engineDepth,
                 liveMates: live.matePerPly.filter(x => x).length, storedMates: stored.matePerPly.filter(x => x).length }; })()`);
      console.log('live vs stored:', JSON.stringify(cmp));
    }
  } catch (e) {
    console.log('ERROR', String(e).slice(0, 500)); failed = true;
  }
  console.log('console errors:', logs.length ? '\n  ' + logs.join('\n  ') : 'none');
  if (failed) { console.log('TEST FAILED'); process.exitCode = 1; }
  await browser.close();
})();
