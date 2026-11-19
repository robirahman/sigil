#!/usr/bin/env node
/**
 * Build docs/static/data/opening-explorer.json, the data of the layout /
 * opening explorer (docs/openings.html), from a completed_games dump.
 *
 *   # the real data: a dump of /completed_games (the owner's service account;
 *   # tools/gen_mate_puzzles.py download_raw writes exactly this file)
 *   node tools/gen-opening-explorer.js --raw /tmp/completed_games.json
 *
 *   # the synthetic sample the page ships with until then
 *   node tools/gen-opening-explorer.js --sample
 *
 * Options: --out <path> (default docs/static/data/opening-explorer.json),
 * --depth N (turns in each board's tree, 6), --layout-depth N (4),
 * --min-games N (a tree node needs N games, 2), --min-layout-games N (1),
 * --max-layouts N (400), --layout-trees N (40), --sample-games N (400),
 * --seed N (sample).
 *
 * The dump is {gameId: record}; a record carries spellNames, variant,
 * setupSfn, turns (slim {color, turnNumber, kind, actions}, or legacy fat
 * entries with per-turn SFNs), winner, redUid and blueUid. Only each game's
 * first turns are replayed, through the site's own replayer
 * (reconstructGameLog, the browser engine run in a vm the way
 * functions/engine-loader.js and ai/replay_bridge.py run it), and counted
 * by docs/static/scripts/opening-explorer.js -- the same code the page uses
 * for one player's games. Games with no winner, or not from the standard
 * start, are not counted. Two segments are written: every game ("all") and
 * games between two different human accounts ("pvp").
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(REPO, 'docs', 'static', 'scripts', 'engine');
const ENGINE_FILES = ['constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js',
	'ai-player.js', 'game-controller.js', 'game-review.js'];
const EXPLORER = path.join(REPO, 'docs', 'static', 'scripts', 'opening-explorer.js');
const OUT = path.join(REPO, 'docs', 'static', 'data', 'opening-explorer.json');

function args(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const k = a.slice(2);
		if (k === 'sample') { o.sample = true; continue; }
		o[k] = argv[++i];
	}
	return o;
}

/** The browser engine + opening-explorer.js in one vm context. */
function loadEngine() {
	const parts = ENGINE_FILES.map((f) => fs.readFileSync(path.join(ENGINE_DIR, f), 'utf8'));
	parts.push(fs.readFileSync(EXPLORER, 'utf8'));
	parts.push(`;globalThis.__x = { OpeningExplorer, reconstructGameLog, normalizeSpellNames, normalizeVariant,
		SigilBoard, getStandardMoveTargets, generateSpellList, boardToSfn };`);
	const sandbox = {
		console: { log() {}, info() {}, debug() {}, warn() {}, error: console.error },
		setTimeout, clearTimeout, Promise, Math, Date, JSON,
	};
	vm.createContext(sandbox);
	new vm.Script(parts.join('\n;\n'), { filename: 'opening-explorer-bundle.js' }).runInContext(sandbox);
	return sandbox.__x;
}

/** Firebase delivers arrays as {"0": ..., "1": ...}; make them lists. */
function list(v) {
	if (Array.isArray(v)) return v;
	if (v && typeof v === 'object') {
		const keys = Object.keys(v);
		if (keys.every((k) => /^\d+$/.test(k))) return keys.sort((a, b) => a - b).map((k) => v[k]);
	}
	return null;
}

/** A record's first `depth` turns with positions, or null. */
async function openingTurns(E, rec, depth) {
	const turns = list(rec.turns);
	if (!turns || !turns.length) return null;
	const head = turns.slice(0, depth).map((t) => Object.assign({}, t, { actions: list(t.actions) || t.actions || [] }));
	if (head.every((t) => t.sfnBefore && t.sfnAfter)) return head;   // legacy fat record
	// No setupSfn (records from before 2026-08): the standard start, when
	// the transcript begins with the first turn.
	const setup = rec.setupSfn || head[0].sfnBefore || null;
	if (!setup && head[0].turnNumber !== 1) return null;
	return E.reconstructGameLog(E.normalizeSpellNames(list(rec.spellNames) || []), E.normalizeVariant(rec.variant),
		setup, head);
}

/** Synthetic games: random legal single placements from the standard start
 *  on a few Core layouts, each replayed like a real record. */
async function sampleDump(E, n, depth, seed) {
	let s = seed >>> 0 || 1;
	const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
	const pick = (arr) => arr[Math.floor(rand() * arr.length)];
	const origRandom = Math.random;
	Math.random = rand;   // generateSpellList shuffles with Math.random
	const layouts = [];
	try {
		for (let i = 0; i < 12; i++) layouts.push(E.generateSpellList(['core']));
	} finally { Math.random = origRandom; }
	const dump = {};
	for (let g = 0; g < n; g++) {
		const spellNames = layouts[Math.min(layouts.length - 1, Math.floor(Math.pow(rand(), 2) * layouts.length))];
		const turns = [];
		let board = null;
		for (let t = 1; t <= depth; t++) {
			const color = t % 2 === 1 ? 'red' : 'blue';
			if (!board) {
				board = new E.SigilBoard(spellNames, 'standard');
				board.setupInitial();
			}
			const targets = Object.keys(E.getStandardMoveTargets(board, color, true)).sort();
			if (!targets.length) break;
			// Favour a few openings, as real players do.
			const node = rand() < 0.6 ? targets[Math.floor(rand() * Math.min(3, targets.length))] : pick(targets);
			turns.push({ color, turnNumber: t, kind: 'input', actions: [node, 'pass'] });
			const rebuilt = await E.reconstructGameLog(spellNames, 'standard', null, turns, { onBoard: (b) => { board = b; } });
			if (rebuilt.length !== turns.length) break;
		}
		const redOpen = turns[0] && turns[0].actions[0];
		const winner = rand() < (redOpen && redOpen.endsWith('2') ? 0.62 : 0.48) ? 'red' : 'blue';
		const ai = rand() < 0.35;
		dump['sample' + String(g).padStart(4, '0')] = {
			spellNames, variant: 'standard', setupSfn: null, turns, winner,
			redUid: 'sampleplayer' + Math.floor(rand() * 20),
			blueUid: ai ? '__ai_rust_hard__' : 'sampleplayer' + (20 + Math.floor(rand() * 20)),
		};
	}
	return dump;
}

async function main() {
	const a = args(process.argv.slice(2));
	const opts = {
		depth: Number(a.depth || 6),
		layoutDepth: Number(a['layout-depth'] || 4),
		minGames: Number(a['min-games'] || 2),
		minLayoutGames: Number(a['min-layout-games'] || 1),
		maxLayouts: Number(a['max-layouts'] || 400),
		layoutTrees: Number(a['layout-trees'] || 40),
	};
	const E = loadEngine();
	let dump;
	if (a.sample) {
		dump = await sampleDump(E, Number(a['sample-games'] || 400), opts.depth, Number(a.seed || 7));
	} else if (a.raw) {
		dump = JSON.parse(fs.readFileSync(a.raw, 'utf8')) || {};
	} else {
		console.error('usage: node tools/gen-opening-explorer.js --raw <completed_games.json> | --sample [--out <path>]');
		process.exit(2);
	}
	const entries = [];
	const skipped = {};
	const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
	const keys = Object.keys(dump);
	for (let i = 0; i < keys.length; i++) {
		const rec = dump[keys[i]];
		if (!rec || typeof rec !== 'object') { skip('not a record'); continue; }
		if (rec.winner !== 'red' && rec.winner !== 'blue') { skip('no winner'); continue; }
		let turns = null;
		try { turns = await openingTurns(E, rec, Math.max(opts.depth, opts.layoutDepth)); } catch (e) { skip('replay failed'); continue; }
		if (!turns || !turns.length) { skip('no turns'); continue; }
		const e = E.OpeningExplorer.gameEntry(
			{ spellNames: E.normalizeSpellNames(list(rec.spellNames) || []), winner: rec.winner, redUid: rec.redUid, blueUid: rec.blueUid },
			turns, Math.max(opts.depth, opts.layoutDepth));
		if (!e) { skip('not from the standard start'); continue; }
		entries.push(e);
		if ((i + 1) % 2000 === 0) process.stderr.write(`  ${i + 1}/${keys.length}\n`);
	}
	const out = {
		version: 1,
		generated: new Date().toISOString(),
		source: a.sample ? 'synthetic sample (tools/gen-opening-explorer.js --sample): not real games' : 'completed_games dump',
		sample: !!a.sample,
		options: opts,
		segments: {
			all: E.OpeningExplorer.aggregate(entries, opts),
			pvp: E.OpeningExplorer.aggregate(entries.filter((e) => e.pvp), opts),
		},
	};
	const outPath = a.out || OUT;
	fs.writeFileSync(outPath, JSON.stringify(out) + '\n');
	console.log(`counted ${entries.length} of ${keys.length} games (${out.segments.pvp.games} player vs player); skipped ${JSON.stringify(skipped)}`);
	console.log(`wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
