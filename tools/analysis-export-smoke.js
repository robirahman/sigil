#!/usr/bin/env node
// Node checks (no browser) for the export / embed / typed-turn / explorer
// code: the GIF encoder against an independent decoder, the typed-turn
// parser, and the opening explorer's counting, run on games replayed by the
// site's own engine; then tools/gen-opening-explorer.js on a small dump.
//
//   node tools/analysis-export-smoke.js
//
// The browser side is tools/browser/analysis-export-emulator-test.js.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SCRIPTS = path.join(REPO, 'docs', 'static', 'scripts');
const SigilGifEncoder = require(path.join(SCRIPTS, 'gif-encoder.js'));
const { decodeGif, lzwDecode } = require(path.join(__dirname, 'browser', 'gif-decode.js'));

let ok = true;
const check = (label, cond, extra) => {
	console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra === undefined ? '' : ' ' + JSON.stringify(extra)));
	ok = ok && !!cond;
};

// ---- GIF encoder
{
	const unblock = (bytes) => {
		const data = [];
		let p = 0;
		for (let s = bytes[p++]; s; s = bytes[p++]) { for (let i = 0; i < s; i++) data.push(bytes[p + i]); p += s; }
		return data;
	};
	let seed = 5;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
	const cases = {
		empty: new Uint8Array(0),
		one: Uint8Array.of(9),
		zeros: new Uint8Array(70000),
		noise: Uint8Array.from({ length: 120000 }, () => (rnd() * 256) | 0),
		ramp: Uint8Array.from({ length: 90000 }, (_, i) => (i >> 4) & 255),
		fewColours: Uint8Array.from({ length: 50000 }, () => (rnd() * 4) | 0),
	};
	for (const [name, arr] of Object.entries(cases)) {
		const enc = SigilGifEncoder.lzw(arr);
		let back = null, err = null;
		try { back = lzwDecode(unblock(enc), 8, arr.length); } catch (e) { err = e.message; }
		check('LZW round trip: ' + name, back && back.every((v, i) => v === arr[i]), err || undefined);
	}

	// Frames: a full first frame, then only the changed rectangle with the
	// unchanged pixels transparent; a repeat only lengthens the delay.
	const W = 50, H = 40;
	const frame = (dot) => {
		const a = new Uint8ClampedArray(W * H * 4);
		for (let i = 0; i < W * H; i++) {
			const x = i % W, y = (i / W) | 0;
			a[i * 4] = x * 5; a[i * 4 + 1] = y * 6; a[i * 4 + 2] = 90; a[i * 4 + 3] = 255;
			if (dot && Math.hypot(x - dot[0], y - dot[1]) < 4) { a[i * 4] = 250; a[i * 4 + 1] = 20; a[i * 4 + 2] = 20; }
		}
		return a;
	};
	const f0 = frame(null), f1 = frame([10, 10]), f2 = frame([30, 25]);
	const enc = new SigilGifEncoder(W, H, { loop: 0 });
	enc.setPalette(SigilGifEncoder.buildPalette([f0, f1, f2]));
	enc.addFrame(f0, 400);
	enc.addFrame(f1, 400);
	enc.addFrame(f1, 600);
	enc.addFrame(f2, 2000);
	let g = null, err = null;
	try { g = decodeGif(enc.finish()); } catch (e) { err = e.message; }
	check('GIF decodes', !!g, err || undefined);
	if (g) {
		check('GIF size and loop', g.w === W && g.h === H && g.loop === 0, { w: g.w, h: g.h, loop: g.loop });
		check('three frames (the repeat merged)', g.frames.length === 3, g.frames.length);
		check('first frame full and opaque', g.frames[0].w === W && g.frames[0].h === H && !g.frames[0].transparent);
		check('the repeat added its delay to the frame before', g.frames[1].delay === 100, g.frames[1].delay);
		const f = g.frames[1];
		check('the second frame is just the changed spot', f.transparent && f.w <= 9 && f.h <= 9 && f.x >= 5 && f.y >= 5, { x: f.x, y: f.y, w: f.w, h: f.h });
		// Composite and compare against the source pixels (palette error only).
		const canvas = new Array(W * H).fill(0);
		const cmp = [];
		for (const fr of g.frames) {
			for (let yy = 0; yy < fr.h; yy++) for (let xx = 0; xx < fr.w; xx++) {
				const v = fr.indices[yy * fr.w + xx];
				if (fr.transparent && v === fr.tidx) continue;
				canvas[(fr.y + yy) * W + fr.x + xx] = v;
			}
			cmp.push(canvas.slice());
		}
		let worst = 0;
		[f0, f1, f2].forEach((src, k) => {
			for (let i = 0; i < W * H; i++) {
				const v = cmp[k][i];
				const d = Math.abs(g.pal[v * 3] - src[i * 4]) + Math.abs(g.pal[v * 3 + 1] - src[i * 4 + 1]) + Math.abs(g.pal[v * 3 + 2] - src[i * 4 + 2]);
				if (d > worst) worst = d;
			}
		});
		check('composited frames match the source (palette error)', worst < 60, worst);
	}
}

// ---- the browser engine + the new scripts in one vm context
const ENGINE = ['constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js', 'ai-player.js', 'game-controller.js', 'game-review.js']
	.map((f) => path.join(SCRIPTS, 'engine', f));
const ctx = { console: { log() {}, warn() {}, info() {}, error: console.error }, setTimeout, clearTimeout, Promise, Math, Date, JSON };
vm.createContext(ctx);
vm.runInContext(ENGINE.concat([path.join(SCRIPTS, 'typed-turn.js'), path.join(SCRIPTS, 'opening-explorer.js')])
	.map((f) => fs.readFileSync(f, 'utf8')).join('\n;\n')
	+ '\n;globalThis.__x = { TypedTurn, OpeningExplorer, reconstructGameLog, boardToSfn };', ctx);
const { TypedTurn, OpeningExplorer, reconstructGameLog } = ctx.__x;

// ---- typed turns
{
	const T = TypedTurn;
	check('tokenize drops a record\'s turn label', JSON.stringify(T.tokenize('R12. a6 pass')) === '["a6","pass"]');
	check('tokenize keeps a node that looks like a label', JSON.stringify(T.tokenize('b2 pass')) === '["b2","pass"]');
	check('tokenize splits commas', JSON.stringify(T.tokenize('a11, dash,a1 a2')) === '["a11","dash","a1","a2"]');
	const ctxw = { nodes: ['a1', 'a2', 'b6', 'c13'], spells: ['Rock_Slide', 'Seal_of_Spring', 'Fireblast', 'Fireblast~2', 'Bewitch'] };
	const r = (text) => { const w = T.tokenize(text); return T.resolveWord(w, 0, ctxw); };
	check('a node, any case', r('A2').token === 'a2' && r('A2').kind === 'node');
	check('a node not on the board', !!r('d5').error);
	check('end and done mean pass', r('end').token === 'pass' && r('Done').token === 'pass');
	check('skip means no Providence placement', r('skip').token === 'skip_providence');
	check('a spell, any case', r('bewitch').token === 'Bewitch');
	check('a two-word spell', r('Rock Slide').token === 'Rock_Slide' && r('Rock Slide').used === 2);
	check('a three-word spell', r('seal of spring b6').token === 'Seal_of_Spring' && r('seal of spring b6').used === 3);
	check('underscores and hyphens', r('rock_slide').token === 'Rock_Slide' && r('Rock-Slide').token === 'Rock_Slide');
	check('copies of a duplicated spell by their own names', r('Fireblast').token === 'Fireblast' && r('Fireblast~2').token === 'Fireblast~2' && r('fireblast2').token === 'Fireblast~2');
	check('an unknown word', !!r('hello').error);
	const legal = T.legalWords({ awaiting: 'action', actionlist: ['move', 'dash', 'Fireblast', 'pass'], moveoptions: { a2: 1, a11: 1 } });
	check('legal words at an action prompt', JSON.stringify(legal) === '["a2","a11","dash","Fireblast","pass"]', legal);
	check('legal words at a node prompt', JSON.stringify(T.legalWords({ awaiting: 'node', moveoptions: { c3: 1 } })) === '["c3"]');
}

// ---- the opening explorer, on games replayed by the engine
(async () => {
	const O = OpeningExplorer;
	const online = JSON.parse(fs.readFileSync(path.join(REPO, 'functions', 'test', 'online-game.json'), 'utf8'));
	const spells = online.spellNames;
	const game = (turns, winner, extra) => Object.assign({ spellNames: spells, winner, turns }, extra || {});
	const t = (color, n, actions, kind) => ({ color, turnNumber: n, kind: kind || 'input', actions });
	const games = [
		game(online.turns.slice(0, 6), 'red', { redUid: 'u1', blueUid: 'u2' }),
		// The same opening, written with a rejected click first and by the engine.
		game([t('red', 1, ['a1', 'a2', 'pass']), t('blue', 2, ['b11', 'pass'])], 'blue', { redUid: 'u1', blueUid: '__ai_rust_hard__' }),
		game([t('red', 1, [{ type: 'move', node: 'a2' }, { type: 'pass' }], 'sim'), t('blue', 2, ['b2', 'pass'])], 'red', { redUid: '__ai_rust_easy__', blueUid: 'u3' }),
		game([t('red', 1, ['a11', 'pass'])], 'blue', { redUid: 'u2', blueUid: 'u1' }),
		game([t('red', 1, ['a11', 'pass'])], null, { redUid: 'u2', blueUid: 'u1' }),   // no winner
	];
	const entries = [];
	for (const g of games) {
		const fat = await reconstructGameLog(g.spellNames, 'standard', null, g.turns);
		entries.push(O.gameEntry(g, fat, 6));
	}
	check('a game without a winner does not count', entries[4] === null);
	check('the position key leaves out the spells and the side to move', entries[0].plies[0].key === entries[1].plies[0].key && !/Flourish/.test(entries[0].plies[0].key));
	check('player vs player only between two human accounts', entries[0].pvp && !entries[1].pvp && !entries[2].pvp);
	const seg = O.aggregate(entries, { minGames: 1 });
	const root = seg.boards.core.tree;
	check('four games counted', seg.games === 4 && root.n === 4 && root.r === 2, { games: seg.games, n: root.n, r: root.r });
	const a2 = root.c.find((c) => c.m === 'a2');
	check('a2 by click, after a rejected click, and by the engine is one turn', a2 && a2.n === 3 && a2.r === 2, a2 && { n: a2.n, r: a2.r });
	check('its label is the human notation', a2 && a2.m === 'a2');
	check('the replies split under it', a2 && a2.c.length === 2 && a2.c[0].n === 2 && a2.c[0].m === 'b11', a2 && a2.c.map((c) => [c.m, c.n]));
	check('most played first', root.c[0].m === 'a2' && root.c[1].m === 'a11');
	check('one layout, with its own tree', seg.layouts.length === 1 && seg.layouts[0].n === 4 && seg.layouts[0].t && seg.layouts[0].t.n === 4);
	check('one spell set', seg.sets.length === 1 && seg.sets[0].a === 1 && JSON.stringify(seg.sets[0].s) === JSON.stringify(spells.slice().sort()));
	const pruned = O.aggregate(entries, { minGames: 2 });
	check('min games prunes rare turns', pruned.boards.core.tree.c.length === 1 && pruned.boards.core.tree.c[0].c.length === 1);
	check('walk follows keys', O.walk(root, [a2.k, a2.c[0].k]) === a2.c[0] && O.walk(root, ['nope']) === null);
	const mine = O.aggregate(entries.map((e, i) => e && Object.assign({}, e, { player: i === 3 ? 'blue' : 'red' })), { minGames: 1, withPlayer: true });
	check('the focus player\'s wins', mine.boards.core.tree.p === 3, mine.boards.core.tree.p);
	check('an engine turn reads in the notation', O.turnText({ kind: 'sim', actions: [{ type: 'dash', sacrificed: ['a1', 'a2'] }, { type: 'move', node: 'c10' }, { type: 'cast', spell: 'Rock_Slide', kept: ['a3'] }, { type: 'pass' }] }) === 'dash a1 a2 c10 Rock Slide a3');
	check('not from the standard start', O.gameEntry({ winner: 'red' }, [{ sfnBefore: online.turns && 'rr.....................................' + '/' + spells.join(',') + ' r 1 0:0 -:- -:- b1', sfnAfter: 'x' }]) === null);

	// ---- the generator, on a small dump
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-'));
	const dump = {};
	games.forEach((g, i) => { dump['g' + i] = Object.assign({}, g, { variant: 'standard', setupSfn: null }); });
	// Firebase's array-as-object shape.
	dump.obj = { spellNames: Object.assign({}, spells), winner: 'red', redUid: 'u5', blueUid: 'u6', variant: 'standard',
		turns: { 0: { color: 'red', turnNumber: 1, kind: 'input', actions: { 0: 'a11', 1: 'pass' } } } };
	fs.writeFileSync(path.join(dir, 'dump.json'), JSON.stringify(dump));
	const out = path.join(dir, 'out.json');
	const log = execFileSync(process.execPath, [path.join(REPO, 'tools', 'gen-opening-explorer.js'), '--raw', path.join(dir, 'dump.json'), '--out', out, '--min-games', '1'], { encoding: 'utf8' });
	const data = JSON.parse(fs.readFileSync(out, 'utf8'));
	check('generator: counts the dump', data.segments.all.games === 5 && !data.sample, log.trim());
	check('generator: player vs player segment', data.segments.pvp.games === 3, data.segments.pvp.games);
	check('generator: the array-shaped record counts', data.segments.all.boards.core.tree.c.find((c) => c.m === 'a11').n === 2);
	const shipped = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'static', 'data', 'opening-explorer.json'), 'utf8'));
	check('the shipped file is the marked synthetic sample', shipped.sample === true && shipped.segments.all.games > 0 && /synthetic/.test(shipped.source));
	fs.rmSync(dir, { recursive: true, force: true });

	console.log(ok ? 'ALL OK' : 'SOME CHECKS FAILED');
	process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
