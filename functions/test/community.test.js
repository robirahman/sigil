'use strict';
// node --test functions/test/community.test.js
//
// The pieces of the community pages that need no database: the Markdown
// subset (docs/static/scripts/markdown-lite.js), the profanity mask
// (text-filter.js) and team-battle scoring (engine/team-battle.js).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const scripts = path.resolve(__dirname, '..', '..', 'docs', 'static', 'scripts');
const md = require(path.join(scripts, 'markdown-lite.js'));
const filter = require(path.join(scripts, 'text-filter.js'));
const { battleTeams, battleState, battleTeamOf, teamBattleStandings } = require('../engine-loader').requireShared('team-battle.js');

// Every node of a parsed document, flattened.
function nodes(blocks) {
	const out = [];
	const walk = (n) => {
		out.push(n);
		(n.c || []).forEach(walk);
		(n.items || []).forEach((it) => it.forEach(walk));
	};
	blocks.forEach(walk);
	return out;
}

test('markdown: the blocks and inline marks of the subset', () => {
	const doc = md.parse('# Title\n\nSome **bold**, *it*, _it_, ~~old~~ and `x < y`.\nNew line.\n\n- one\n- two\n\n3. three\n4. four\n\n> said\n\n```\ncode **not bold**\n```\n\n---');
	assert.deepStrictEqual(doc.map((b) => b.t), ['h', 'p', 'ul', 'ol', 'quote', 'code', 'hr']);
	assert.strictEqual(doc[3].start, 3);
	assert.strictEqual(doc[5].text, 'code **not bold**');
	const kinds = nodes([doc[1]]).map((n) => n.t);
	for (const k of ['b', 'i', 's', 'code', 'br']) assert.ok(kinds.includes(k), k);
	// snake_case and lone stars stay as typed.
	assert.strictEqual(md.toPlain('my_var_name and 2 * 3 * 4'), 'my_var_name and 2 * 3 * 4');
	assert.strictEqual(md.toPlain('\\*not italic\\*'), '*not italic*');
});

test('markdown: no HTML and no script links, whatever is typed', () => {
	const evil = [
		'<script>alert(1)</script>',
		'<img src=x onerror=alert(1)>',
		'[click](javascript:alert(1))',
		'[click](JaVaScRiPt:alert(1))',
		'[click]( javascript:alert(1))',
		'[x](data:text/html;base64,PHNjcmlwdD4=)',
		'[x](vbscript:msgbox)',
		'[x](//evil.com)',
		'[x](https://ok.com" onmouseover="alert(1))',
		'javascript:alert(1)',
		'<a href="javascript:alert(1)">x</a>',
	].join('\n\n');
	const all = nodes(md.parse(evil));
	// The one link left is the plain https://ok.com the bad link starts
	// with (an autolink, cut at the quote).
	const links = all.filter((n) => n.t === 'a').map((l) => l.href);
	assert.deepStrictEqual(links, ['https://ok.com']);
	// The text is kept (shown as typed by text nodes, never as markup).
	assert.ok(md.toPlain(evil).includes('<script>alert(1)</script>'));
	// Allowed: http(s) and the site's own pages.
	const ok = nodes(md.parse('[a](https://lichess.org/x?y=1) [b](puzzles.html#5) http://example.com/p.')).filter((n) => n.t === 'a').map((n) => n.href);
	assert.deepStrictEqual(ok, ['https://lichess.org/x?y=1', 'puzzles.html#5', 'http://example.com/p']);
	assert.strictEqual(md.safeHref('javascript:alert(1)'), null);
	assert.strictEqual(md.safeHref('https://a.b/c d'), null);
});

test('markdown: pathological input stays fast', () => {
	const t0 = Date.now();
	for (const s of ['*'.repeat(40000), '['.repeat(20000) + ']'.repeat(20000), '[a]('.repeat(8000), '`'.repeat(40000),
		'_a'.repeat(20000), '**a '.repeat(10000), '~~a '.repeat(10000), 'http://x'.repeat(4000), '> '.repeat(20000), '- \n'.repeat(13000)]) {
		md.parse(s);
	}
	assert.ok(Date.now() - t0 < 5000, 'took ' + (Date.now() - t0) + ' ms');
	// Deep nesting is cut off, not a stack overflow.
	md.parse('*'.repeat(2) + '_'.repeat(2) + 'x'.repeat(10) + '_'.repeat(2) + '*'.repeat(2));
	md.parse('**a '.repeat(500) + 'b' + ' c**'.repeat(500));
});

test('markdown: an excerpt is plain and cut', () => {
	assert.strictEqual(md.toPlain('# Hello\n\n**Big** [news](https://x.y) today', 14), 'Hello Big new…');
	assert.strictEqual(md.toPlain(''), '');
	assert.strictEqual(md.toPlain(null), '');
});

test('profanity: whole words, look-alikes, not inside other words', () => {
	assert.strictEqual(filter.mask('what the fuck'), 'what the f***');
	assert.strictEqual(filter.mask('Sh1t, FUUUCK!'), 'S***, F*****!');
	assert.strictEqual(filter.mask('motherfuckers'), 'm************');
	for (const clean of ['Scunthorpe', 'cocktail', 'assess the class', 'Dickens', 'cumulative', 'grape spice', 'shell']) {
		assert.strictEqual(filter.mask(clean), clean);
		assert.strictEqual(filter.has(clean), false);
	}
	assert.strictEqual(filter.has('you b1tch'), true);
	assert.strictEqual(filter.mask(null), '');
	const t0 = Date.now();
	filter.mask('a' + 's'.repeat(40000));
	filter.mask(('ass' + 's'.repeat(30) + ' ').repeat(1000));
	assert.ok(Date.now() - t0 < 1000);
});

test('team battles: teams, state and the team a player plays for', () => {
	const b = { host: 'reds', start: 100, end: 200, topN: 2, teams: { blues: 'accepted', reds: 'accepted', greens: 'invited', greys: 'declined' } };
	assert.deepStrictEqual(battleTeams(b), ['reds', 'blues']);
	assert.strictEqual(battleState(b, 50), 'upcoming');
	assert.strictEqual(battleState(b, 150), 'running');
	assert.strictEqual(battleState(b, 200), 'finished');
	assert.strictEqual(battleState(Object.assign({ finished: 180 }, b), 150), 'finished');
	// The earliest joined of the battle's accepted teams.
	assert.strictEqual(battleTeamOf({ blues: 5, reds: 9, greens: 1 }, ['reds', 'blues']), 'blues');
	assert.strictEqual(battleTeamOf({ greens: 1 }, ['reds', 'blues']), null);
	assert.strictEqual(battleTeamOf(null, ['reds']), null);
});

test('team battles: a team counts its top N players', () => {
	const b = { host: 'reds', start: 0, end: 1, topN: 2, teams: { reds: 'accepted', blues: 'accepted', greens: 'invited' } };
	const players = {
		r1: { team: 'reds', points: 5, games: 6 }, r2: { team: 'reds', points: 1, games: 3 }, r3: { team: 'reds', points: 1, games: 1 },
		b1: { team: 'blues', points: 3, games: 3 }, b2: { team: 'blues', points: 3, games: 4 }, b3: { team: 'blues', points: 2, games: 2 },
		g1: { team: 'greens', points: 9, games: 9 },
	};
	const s = teamBattleStandings(b, players);
	assert.deepStrictEqual(s.map((t) => [t.team, t.score, t.points, t.counted]), [['reds', 6, 7, 2], ['blues', 6, 8, 2]].sort((x, y) => y[2] - x[2]));
	// Ties on score go to more points in all: blues (8) over reds (7).
	assert.strictEqual(s[0].team, 'blues');
	// Within a team, fewer games breaks a tie in points.
	assert.deepStrictEqual(s.find((t) => t.team === 'reds').players.map((p) => p.uid), ['r1', 'r3', 'r2']);
	assert.deepStrictEqual(teamBattleStandings(b, {}).map((t) => t.score), [0, 0]);
});
