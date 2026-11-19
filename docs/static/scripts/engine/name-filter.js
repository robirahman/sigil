/**
 * The offensive-name filter, for every name others see: display names
 * (sign-up, rename, a Google account's name), the usernames/ index and the
 * copies of a name the database keeps (leaderboards, room seats). The word
 * list lives here and only here:
 *   - pages call SigilNameFilter.allowed(name) before writing a name
 *     (account.html, auth-manager.js), and write 'Player' in place of a
 *     refused name in rooms and leaderboards (SigilNameFilter.safe);
 *   - the filterNames Cloud Functions (functions/names.js) require this
 *     file and put back 'Player' (or drop a usernames/ claim) wherever a
 *     refused name is written anyway, so a client that skips the check
 *     gains nothing;
 *   - tools/name-filter/audit-names.js lists, and with --apply resets, the
 *     names stored before the filter.
 * (Not in database.rules.json: the database compiles a rules regex into an
 * automaton on every rules load, and this list took 25 s to 85 s per load
 * in the emulator.)
 *
 * Avoiding false positives (the "Scunthorpe problem"): a term is blocked
 * inside other text only when it is not part of ordinary words or names
 * (ANYWHERE, checked against 370k English words, 108k given and family
 * names and 29M "First Last" pairs with tools/name-filter/check-corpus.js);
 * otherwise only as a whole word, between non-letters (WORD), so
 * "Scunthorpe", "Dickens", "grape", "analysis", "therapist", "Pakistan" and
 * "Essex" pass. An ANYWHERE term may name single letters that, right before
 * or after it, make an ordinary word ("snigger", "niggardly", "Scunthorpe",
 * "Penistone"). Words that are also common real names (Dick, Coon, Nazi,
 * Kike, Wank, Cock as a Flemish surname) are deliberately not listed.
 *
 * Spelling tricks it sees: letter case, accents and full-width letters
 * (a name is compared lower-cased, in Unicode compatibility form, without
 * accents: "FÜCK" is "fuck"), repeated vowels ("fuuuck"), look-alike digits
 * and symbols ("f4gg0t", "b!tch", "$h1t"), v for u ("fvck"), and a term
 * spelled out with a separator between EVERY letter ("f.u.c.k", "f u c k").
 * A separator only somewhere in the middle is not joined, so "Nesbit Chen"
 * is not "bitch".
 */
const SigilNameFilter = (function () {
	// Blocked anywhere in a name. { t, notBefore, notAfter }: letters that,
	// right before / after the term, make an ordinary word instead. A space
	// in a term is an optional separator ("sieg heil", "Sieg_Heil",
	// "siegheil"); it is used only where neither half is blocked alone and
	// no common first name + surname pair spells it ("Jack Offord").
	const ANYWHERE = [
		'fuck',
		{ t: 'cunt', notBefore: 'sa', notAfter: 'zh' },   // Scunthorpe, placuntoma, Cuntz
		{ t: 'nigger', notBefore: 's' },                   // snigger
		{ t: 'nigga', notAfter: 'r' },                     // niggard, niggardly
		'faggot', 'bitch', 'whore', 'asshole',
		'cock suck', 'dick suck', 'dickhead',
		'jizz', 'dildo', 'blow job', 'hand job', 'cumshot', 'cumslut', 'jackoff', 'jerkoff',
		{ t: 'penis', notAfter: 't' },                     // Penistone
		'bullshit', 'horseshit', 'dipshit', 'batshit', 'shithead', 'shithole', 'shitface',
		'wet back', 'tranny', 'rag head', 'towel head',
		'hitler', 'sieg heil', 'pedophil', 'paedophil', 'kill your self',
	];
	// Blocked only as a whole word (not next to another letter).
	const WORD = [
		'shit', 'shits', 'shitty', 'shite', 'shitter', 'shitting',
		'slut', 'sluts', 'slutty', 'twat', 'twats', 'wanker', 'wankers', 'wanking',
		'rape', 'raped', 'rapes', 'rapist', 'rapists',
		'retard', 'retards', 'retarded',
		'porn', 'porno', 'pussy', 'pussies', 'tits', 'titty', 'titties', 'cum', 'clit', 'vagina',
		'fag', 'fags', 'spic', 'spics', 'chink', 'chinks', 'gook', 'gooks', 'kikes',
		'beaner', 'beaners', 'paki', 'pakis', 'kkk', 'kys',
	];

	// What each letter may be written as: the symbols always; digits and v
	// for u too, except in a whole-word term that digits alone could spell
	// ("7175" is a number, not "tits").
	const SYMBOLS = { a: '@', i: '!|', l: '|', s: '$', t: '+' };
	const LOOKALIKES = { a: '4', b: '8', e: '3', g: '9', i: '1', l: '1', o: '0', s: '5', t: '7', u: 'v' };
	const DIGIT_LETTERS = /^[abegilost]+$/;
	// Word edges are anything but a letter (in any script); a separator is
	// anything but a letter, a digit or a look-alike symbol.
	const LETTERS = '\\p{L}';
	const SEP = '[^\\p{L}\\p{N}@$!|+]';

	// A vowel of an ANYWHERE term may repeat ("fuuuck"); consonants may not
	// ("whittler" is not "hitler", "Pennisi" not "penis").
	function letterClass(ch, loose, repeat) {
		let set = ch + (SYMBOLS[ch] || '');
		if (loose) set += LOOKALIKES[ch] || '';
		return '[' + set + ']' + (repeat && 'aeiou'.includes(ch) ? '+' : '');
	}
	function edgeClass(letters) {
		return '[^' + letters + ']';
	}

	function termPattern(spec, word) {
		const t = typeof spec === 'string' ? spec : spec.t;
		const loose = !word || !DIGIT_LETTERS.test(t);
		const parts = t.split(' ').map((w) => w.split('').map((ch) => letterClass(ch, loose, !word)));
		// The name is padded with a space (norm), so its ends are edges too.
		if (word) return '[^' + LETTERS + ']' + parts[0].join('') + '[^' + LETTERS + ']';
		const before = spec.notBefore ? edgeClass(spec.notBefore) : '';
		const after = spec.notAfter ? edgeClass(spec.notAfter) : '';
		// Joined (optionally separated where the term has a space), or with a
		// separator between every letter ("f.u.c.k", "f u c k").
		const joined = parts.map((w) => w.join('')).join(SEP + '*');
		const spaced = [].concat(...parts).join(SEP + '+');
		return before + '(' + joined + '|' + spaced + ')' + after;
	}

	const TERMS = ANYWHERE.map((s) => ({ term: (typeof s === 'string' ? s : s.t).replace(/ /g, ''), source: termPattern(s, false) }))
		.concat(WORD.map((s) => ({ term: s, source: termPattern(s, true) })));
	const RE = new RegExp(TERMS.map((x) => '(' + x.source + ')').join('|'), 'u');
	for (const x of TERMS) x.re = new RegExp(x.source, 'u');

	// Lower case, compatibility form (full-width letters, ligatures), no
	// accents ("Analía" is "analia"), a space on each side.
	function norm(name) {
		return ' ' + name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase() + ' ';
	}

	return {
		ANYWHERE, WORD,
		/** True when the name contains none of the listed terms. */
		allowed(name) {
			return typeof name === 'string' && !RE.test(norm(name));
		},
		/** The first listed term the name contains, or null (for tools and tests). */
		match(name) {
			if (typeof name !== 'string') return null;
			const hit = TERMS.find((x) => x.re.test(norm(name)));
			return hit ? hit.term : null;
		},
		/** The name, or `fallback` when the name is not allowed. */
		safe(name, fallback) {
			return this.allowed(name) ? name : (fallback === undefined ? 'Player' : fallback);
		},
		MESSAGE: 'That name is not allowed. Please choose another.',
	};
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SigilNameFilter;
