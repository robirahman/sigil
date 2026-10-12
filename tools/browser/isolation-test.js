// Headless check that docs/sw.js makes game.html cross-origin isolated and the
// threaded engine loads there, without breaking the page:
//
//   (cd docs && python3 -m http.server 8771) &      # a plain server: no COOP/COEP
//   node tools/browser/isolation-test.js http://127.0.0.1:8771
//
// First load: no service worker yet, so not isolated. After a reload the worker
// adds COOP/COEP; then the page must report crossOriginIsolated, the engine
// worker must start its thread pool, Firebase must connect, fonts and the CDN
// scripts must load, and a threaded search must count more nodes than its main
// thread alone (and its live progress ticks count the helpers too). Exits 1 on any failure.
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://127.0.0.1:8771';
(async () => {
  const b = await puppeteer.launch({ headless: 'shell', protocolTimeout: 300000, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const p = await b.newPage(); const logs = [];
  p.on('dialog', d => d.accept().catch(() => {}));           // the in-game leave-page prompt
  p.on('console', m => { if (['error', 'warning'].includes(m.type()) && !/deprecated parameters/.test(m.text())) logs.push(m.type() + ': ' + m.text().slice(0, 220)); });
  p.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 220)));
  p.on('requestfailed', r => logs.push('reqfail: ' + r.url().slice(0, 100) + ' ' + (r.failure() || {}).errorText));
  await p.goto(BASE + '/game.html?ai=rust_hard', { waitUntil: 'load', timeout: 90000 });
  const first = await p.evaluate(async () => {
    const iso = self.crossOriginIsolated;
    // Wait for the service worker to finish installing (it precaches the site).
    const ready = await Promise.race([navigator.serviceWorker.ready.then(() => true),
                                      new Promise(r => setTimeout(() => r(false), 60000))]);
    return { iso, swReady: ready };
  });
  await p.reload({ waitUntil: 'load', timeout: 90000 });
  await new Promise(r => setTimeout(r, 3000));
  const st = await p.evaluate(async () => {
    const out = { iso: self.crossOriginIsolated, threads: rustThreadCount() };
    const info = await getRustEngineWorker().init();
    out.engine = { threads: info.threads, err: info.threads_error };
    let lastTick = 0;
    const r = await getRustEngineWorker().search({ sfn: 'r.........r...bb...................r.../Seal_of_Destruction,Blossom,Hurricane,Storm_Front,Seal_of_Stone,Scatter,Seal_of_Winter,Seal_of_Summer,Gust r 4 0:0 -:- -:- tied',
      timeMs: 2000, ttBits: 20, widthScale: 4, historySfns: [], evalName: 'nnue_spell4', adaptive: [0.1, 2, 6], threads: out.threads },
      (m) => { lastTick = m.nodes || 0; });
    out.search = { ok: r.ok, depth: r.depth, nodes: r.nodes, all: r.all_nodes, lastTick };
    out.fbConnected = await new Promise(res => { firebase.database().ref('.info/connected').on('value', s => { if (s.val()) res(true); }); setTimeout(() => res(false), 15000); });
    out.fonts = [...document.fonts].filter(f => f.status === 'loaded').length;
    out.alpine = !!window.Alpine;
    return out;
  });
  console.log('first load:', JSON.stringify(first));
  console.log('after reload:', JSON.stringify(st));
  console.log('problems:', logs.length ? '\n  ' + logs.join('\n  ') : 'none');
  const ok = !first.iso && st.iso && st.engine.threads > 1 && st.search.ok && st.search.all > st.search.nodes
    && st.search.lastTick > 0 && st.search.lastTick <= st.search.all
    && st.fbConnected === true && st.fonts > 0 && st.alpine && logs.length === 0;
  console.log(ok ? 'ISOLATION TEST OK' : 'ISOLATION TEST FAILED');
  if (!ok) process.exitCode = 1;
  await b.close();
})();
