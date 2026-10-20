// Headless check of the threaded browser engine (engine/build-wasm-mt.sh):
// loads rust-worker.js under a cross-origin-isolated origin (coi-server.py),
// once with threads=1 and once with threads=N, and searches the same positions
// for the same time on each. Prints depth and nodes per position and totals.
//
//   python3 tools/browser/coi-server.py 8770 docs &
//   node tools/browser/wasm-mt-bench.js http://127.0.0.1:8770 [threads=4[,8,...]] [ms=3000] [n_positions]
//
// Positions: the built-in four, plus (n_positions > 4) the guest benchmark
// cases (ai/data/benchmarks/guest_2026-10_cases.json). One JSON line per
// configuration is printed (prefix RESULT) for pooling across machines.
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://127.0.0.1:8770';
const NS = (process.argv[3] || '4').split(',').map(x => parseInt(x, 10)), MS = parseInt(process.argv[4] || '3000', 10);
const NPOS = parseInt(process.argv[5] || '4', 10);
const SFNS = [
  'rrr..r....r..b..b...............bbbb.../Seal_of_Lightning,Bewitch,Endowment,Rock_Slide,Storm_Front,Fury,Bulwark,Azimuth,Sprout b 16 0:1 -:Bewitch -:- b2 competitive',
  '..b.b.r.bb.b..rrrrr.....r............../Hurricane,Seal_of_Destruction,Erupt,Seal_of_Stone,Storm_Front,Fury,Seal_of_Winter,Charge,Seal_of_Autumn b 7 1:0 Storm_Front:- -:- b1',
  'r.........r...bb...................r.../Seal_of_Destruction,Blossom,Hurricane,Storm_Front,Seal_of_Stone,Scatter,Seal_of_Winter,Seal_of_Summer,Gust r 4 0:0 -:- -:- tied',
  'bbbbbb....bb........rrr...rbrr..rrrb.rr/Harvest,Tsunami,Carnage,Rock_Slide,Fireblast,Fury,Seal_of_Summer,Azimuth,Surge b 25 1:2 Carnage:Harvest -:- tied competitive',
];
if (NPOS > SFNS.length) {
  const path = require('path');
  const cases = require(path.join(__dirname, '..', '..', 'ai', 'data', 'benchmarks', 'guest_2026-10_cases.json'));
  for (const c of cases) { if (SFNS.length >= NPOS) break; if (c.sfn) SFNS.push(c.sfn); }
}
(async () => {
  const browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.type() + ': ' + m.text().slice(0, 300)));
  page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 300)));
  await page.goto(BASE + '/static/scripts/engine/notation.js', { waitUntil: 'load' });   // any same-origin URL
  const out = await page.evaluate(async (SFNS, NS, MS) => {
    const iso = self.crossOriginIsolated;
    const run = (threads) => new Promise((resolve, reject) => {
      const w = new Worker('/static/scripts/engine/rust-worker.js?v=31');
      let id = 1; const pend = new Map();
      w.onmessage = e => { const m = e.data; const p = pend.get(m.id); if (!p) return;
        if (m.type === 'progress') return; pend.delete(m.id);
        m.type === 'error' ? p.reject(new Error(m.message)) : p.resolve(m.info || m.res); };
      w.onerror = e => reject(new Error('worker error ' + (e.message || '')));
      const call = (msg) => new Promise((res, rej) => { const i = id++; pend.set(i, { resolve: res, reject: rej }); w.postMessage(Object.assign({ id: i }, msg)); });
      (async () => {
        w.postMessage({ type: 'configure', threads });
        const info = await call({ type: 'init' });
        const rows = [];
        for (const sfn of SFNS) {
          w.postMessage({ type: 'new_game', ttBits: 20 });
          const t = performance.now();
          const r = await call({ type: 'search', sfn, timeMs: MS, ttBits: 20, widthScale: 4, historySfns: [],
                                 evalName: 'nnue_mt256', adaptive: [0.10, 2, 6], threads });
          rows.push({ depth: r.depth, nodes: r.all_nodes || r.nodes, secs: +((performance.now() - t) / 1000).toFixed(2), ok: r.ok });
        }
        w.terminate();
        resolve({ threadsUsed: info.threads, err: info.threads_error, rows });
      })().catch(reject);
    });
    const res = [['1 thread', await run(1)]];
    for (const n of NS) res.push([n + ' threads', await run(n)]);
    return { iso, res };
  }, SFNS, NS, MS);
  console.log('crossOriginIsolated:', out.iso);
  for (const [k, v] of out.res) {
    console.log('RESULT ' + JSON.stringify({ config: k, threads: v.threadsUsed, ms: MS, rows: v.rows }));
    const nodes = v.rows.reduce((a, r) => a + r.nodes, 0), d = v.rows.map(r => r.depth);
    console.log(`${k} (engine reports ${v.threadsUsed}${v.err ? ', error: ' + v.err : ''}): depths ${d.join(',')} nodes ${nodes} (${(nodes / (v.rows.length * MS / 1000) / 1000).toFixed(0)} knps)  ${JSON.stringify(v.rows.map(r => r.secs))}`);
  }
  console.log('console:', logs.filter(l => !/^log:/.test(l)).join('\n  ') || 'none');
  await browser.close();
})();
