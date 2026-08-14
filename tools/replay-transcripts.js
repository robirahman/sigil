// Replay-bridge driver for slim game records.
//
// NOT a standalone script: ai/replay_bridge.py concatenates the browser
// engine files (constants, notation, board, moves, spells, ai-player,
// game-controller, game-review) ahead of this body and runs the result
// with node — the same single canonical replayer (reconstructGameLog /
// hydrateGameLog) the review UI uses, so Python consumers can never
// drift from what the site replays.
//
// Usage (after concatenation):  node <script> <in.json> <out.json>
//   in.json:  [{spellNames, variant, setupSfn, finalSfn, turns}, ...]
//   out.json: [{ok: true, turns: [{color, turnNumber, sfnBefore,
//              sfnAfter}]} | {ok: false, error}, ...]
//
// Fat records (turns already carrying SFNs) pass through unchanged —
// hydrateGameLog is the dual-format entry point.

(async () => {
	const fs = require('fs');
	const inPath = process.argv[2];
	const outPath = process.argv[3];
	if (!inPath || !outPath) {
		console.error('usage: node <concatenated-script> <in.json> <out.json>');
		process.exit(2);
	}
	const records = JSON.parse(fs.readFileSync(inPath, 'utf8'));
	const out = [];
	for (const rec of records) {
		try {
			const fat = await hydrateGameLog(
				rec.spellNames, rec.variant, rec.setupSfn || null,
				rec.finalSfn || null, rec.turns || []);
			out.push({
				ok: true,
				turns: fat.map(t => ({
					color: t.color,
					turnNumber: t.turnNumber,
					sfnBefore: t.sfnBefore,
					sfnAfter: t.sfnAfter,
				})),
			});
		} catch (e) {
			out.push({ ok: false, error: String((e && e.message) || e) });
		}
	}
	fs.writeFileSync(outPath, JSON.stringify(out));
	process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
