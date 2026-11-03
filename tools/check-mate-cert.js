#!/usr/bin/env node
/**
 * Check a SigilBench mate certificate against the browser's INTERACTIVE rules
 * (tools/rules-enum.js walks the GameController a human plays).
 *
 *   node tools/check-mate-cert.js < certs.jsonl
 *   (one certificate per line, engine/examples/cert_tool make output made with
 *    leaves on; one verdict line out:
 *    {"ok", "error"?, "and_nodes", "or_nodes", "runs", "ms"})
 *
 * The certificate is used only as hints -- at mover position `at`, play to
 * position `to` -- and everything else is established here:
 *   - at every defender node, EVERY reply the controller accepts is enumerated,
 *     and each must lose on the spot or reach a mover node that checks;
 *   - at a mover node, the hinted position must be reachable through the
 *     controller (a search that stops when it is reached: reaching it proves
 *     the turn legal) and must win, or with turns left be a defender node
 *     that checks.
 * Nothing from the Rust engine is trusted: its enumerator, its outcome rules
 * and its prover are all re-derived from the controller.
 */
'use strict';
const readline = require('readline');
const E = require('./rules-enum.js');

function preferTokens(actions) {
	const s = new Set(['pass']);
	const walk = (v) => {
		if (typeof v === 'string') s.add(v);
		else if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === 'object') Object.values(v).forEach(walk);
	};
	walk(actions || []);
	return s;
}

async function check(cert) {
	const t0 = Date.now();
	const mover = cert.mover;
	const hints = new Map();
	for (const e of (cert.internal || []).concat(cert.leaves || [])) hints.set(E.normKey(e.at), e);
	const orOk = new Map();
	const stats = { and_nodes: 0, or_nodes: 0, runs: 0 };
	const fail = (why) => { throw new Error(why); };

	async function and(sfn, j) {
		stats.and_nodes++;
		const r = await E.enumerate(sfn);
		stats.runs += r.stats.runs;
		if (r.stats.errors) fail('enumeration errors at ' + sfn);
		for (const ch of r.children) {
			if (ch.gameover && ch.winner === mover) continue;
			if (ch.gameover) fail('reply wins for the defender: ' + ch.sfn);
			if (j <= 0) fail('no turns left after reply ' + ch.sfn);
			await or(ch.sfn, j);
		}
	}

	async function or(sfn, k) {
		const key = E.normKey(sfn);
		if (orOk.has(key) && orOk.get(key) <= k) return;
		stats.or_nodes++;
		const h = hints.get(key);
		if (!h) fail('no hint at mover position ' + sfn);
		const target = E.normKey(h.to);
		const r = await E.enumerate(sfn, { target, prefer: preferTokens(h.actions) });
		stats.runs += r.stats.runs;
		const ch = r.children.find(c => c.key === target);
		if (!ch) fail('hinted turn not reachable through the controller at ' + sfn);
		if (!(ch.gameover && ch.winner === mover)) {
			if (ch.gameover) fail('hinted turn loses at ' + sfn);
			if (k <= 1) fail('hinted turn does not mate with 1 turn left at ' + sfn);
			await and(ch.sfn, k - 1);
		}
		orOk.set(key, k);
	}

	try {
		await and(cert.after, cert.n - 1);
		return Object.assign({ ok: true }, stats, { ms: Date.now() - t0 });
	} catch (e) {
		return Object.assign({ ok: false, error: String(e.message || e).slice(0, 500) }, stats, { ms: Date.now() - t0 });
	}
}

module.exports = { check };

if (require.main === module) {
	const rl = readline.createInterface({ input: process.stdin });
	const lines = [];
	rl.on('line', (l) => { if (l.trim()) lines.push(l); });
	rl.on('close', async () => {
		for (const l of lines) process.stdout.write(JSON.stringify(await check(JSON.parse(l))) + '\n');
	});
}
