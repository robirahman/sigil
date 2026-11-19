#!/usr/bin/env node
// False-positive check for the name filter (docs/static/scripts/engine/name-filter.js):
// every line of the given word lists that the filter blocks, grouped by term,
// so each blocked word can be reviewed. With --pairs FIRST LAST it also tries
// "First Last" for every first name against a sample of surnames (multi-word
// display names come from Google accounts).
//
//   node tools/name-filter/check-corpus.js words_alpha.txt first.txt last.txt
//   node tools/name-filter/check-corpus.js --pairs first.txt last.txt [stride]
//
// Word lists used for the shipped list (2026-11): dwyl/english-words
// words_alpha.txt (370k words) and smashew/NameDatabases first and surnames
// (108k names). Not committed: they are large and only needed when the list
// changes.
'use strict';
const fs = require('fs');
const path = require('path');
const F = require(path.join(__dirname, '..', '..', 'docs', 'static', 'scripts', 'engine', 'name-filter.js'));

const args = process.argv.slice(2);
const read = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const byTerm = new Map();
let tried = 0;
const tryName = (name) => {
	tried++;
	if (F.allowed(name)) return;
	const t = F.match(name);
	if (!t) return;
	if (!byTerm.has(t)) byTerm.set(t, []);
	byTerm.get(t).push(name);
};

if (args[0] === '--pairs') {
	const first = read(args[1]).map(cap);
	const last = read(args[2]).map(cap);
	// Every first name against every `stride`-th surname (default 200): a
	// term spanning the space must end the first name and start the surname,
	// so a sample of surnames sees most shapes.
	const stride = Number(args[3]) || 200;
	for (const f of first) for (let i = 0; i < last.length; i += stride) tryName(f + ' ' + last[i]);
} else {
	for (const file of args) for (const w of read(file)) tryName(w);
}

let blocked = 0;
for (const [t, names] of [...byTerm].sort((a, b) => b[1].length - a[1].length)) {
	blocked += names.length;
	console.log(t + ' (' + names.length + '): ' + names.slice(0, 30).join(', ') + (names.length > 30 ? ', ...' : ''));
}
console.log(`${blocked} of ${tried} blocked`);
