// List visible text whose colour has under 3:1 contrast with the background
// behind it, per theme and page (the light Parchment theme exposes colours
// hard-coded for a dark page).
//   node tools/browser/theme-text-audit.js <docs dir> [theme ...]
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');

const DOCS = process.argv[2];
const PORT = 8768;
const THEMES = process.argv.length > 3 ? process.argv.slice(3) : ['default', 'frost', 'parchment', 'forest', 'volcanic'];
const PAGES = ['index.html', 'puzzles.html?p=3', 'game.html', 'multiplayer.html', 'leaderboard.html', 'spells.html', 'account.html', 'profile.html', 'active-games.html'];

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
  let total = 0;
  try {
    await waitPort(PORT, 15000);
    for (const theme of THEMES) {
      const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
      for (const url of PAGES) {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 1000 });
        await page.evaluateOnNewDocument(t => { try { localStorage.setItem('sigil_theme', t); } catch (e) {} }, theme);
        await page.goto(`http://127.0.0.1:${PORT}/${url}`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        const bad = await page.evaluate(() => {
          const parse = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3).map(v => v / 255), a: p.length > 3 ? p[3] : 1 }; };
          const lum = c => { const l = c.map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
          const pageBg = parse(getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim().replace(/^#(..)(..)(..)$/, (_, r, g, b) => `rgb(${parseInt(r, 16)},${parseInt(g, 16)},${parseInt(b, 16)})`)) || { c: [0, 0, 0] };
          const bgOf = el => {
            let stack = [];
            for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
              const b = parse(getComputedStyle(e).backgroundColor);
              if (b && b.a > 0) { stack.push(b); if (b.a >= 0.95) break; }
            }
            let c = pageBg.c;
            for (const b of stack.reverse()) c = c.map((v, i) => v * (1 - b.a) + b.c[i] * b.a);
            return c;
          };
          const out = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const seen = new Set();
          while (walker.nextNode()) {
            const t = walker.currentNode; const el = t.parentElement;
            if (!el || seen.has(el) || !t.textContent.trim()) continue;
            seen.add(el);
            const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
            if (r.width < 2 || r.height < 2 || el.closest('.visually-hidden') || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
            if (el.closest('.game-board-container, svg, [aria-hidden="true"]')) continue;
            const fg = parse(cs.color); if (!fg) continue;
            const bg = bgOf(el);
            const f = fg.c.map((v, i) => v * fg.a + bg[i] * (1 - fg.a));
            const L1 = lum(f), L2 = lum(bg);
            const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
            if (ratio < 3) out.push(`${ratio.toFixed(2)} ${cs.color} on rgb(${bg.map(v => Math.round(v * 255))}) <${el.tagName.toLowerCase()} class="${el.className}"> ${t.textContent.trim().slice(0, 40)}`);
          }
          return out;
        });
        if (bad.length) { console.log(`== ${theme} ${url} (${bad.length})`); bad.slice(0, 25).forEach(b => console.log('  ' + b)); }
        total += bad.length;
        await page.close();
      }
      await browser.close();
    }
  } finally { srv.kill(); }
  console.log('low-contrast text elements:', total);
})();
