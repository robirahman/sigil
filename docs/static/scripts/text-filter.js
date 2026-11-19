/**
 * text-filter.js — masks strong profanity and slurs in text people write
 * (forum posts, blogs, comments, messages, team pages), at render time:
 * "f***". The stored text is untouched, so a moderator still reads what was
 * written and a better list applies to old posts too.
 *
 * Whole words only, so place names and ordinary words that contain one
 * ("Scunthorpe", "cocktail", "assess") are left alone; common letter swaps
 * (4 for a, 0 for o, $ for s) and repeats ("fuuuck") still match.
 *
 *   SigilTextFilter.mask('what the fuck')   -> 'what the f***'
 *   SigilTextFilter.has('sh1t')             -> true
 *
 * DOM-free (classic script and CommonJS), for the pages and the tests; the
 * chat and name filters can share it.
 */
(function (root) {
	// Stems match any ending ("fucking", "shitty"); words match alone or with
	// a plural "s" / "es".
	const STEMS = ['fuck', 'motherfuck', 'shit', 'cunt', 'bitch', 'whore', 'nigger', 'nigga', 'faggot', 'retard', 'wank', 'twat', 'bollock'];
	const WORDS = ['ass', 'asshole', 'arsehole', 'bastard', 'dick', 'dickhead', 'cock', 'pussy', 'slut', 'fag', 'kike', 'spic', 'tranny', 'piss', 'prick', 'dyke', 'jizz', 'cum'];

	const LEET = { a: '[a@4]', e: '[e3]', i: '[i1!|]', o: '[o0]', s: '[s$5]', t: '[t7]', g: '[g9]', l: '[l1|]' };
	// Each letter, in any of its look-alikes, any number of times.
	const letters = (w) => w.split('').map((c) => (LEET[c] || c) + '+').join('');
	const STEM_RE = '(?:' + STEMS.map(letters).join('|') + ')[a-z]*';
	const WORD_RE = '(?:' + WORDS.map(letters).join('|') + ')(?:e?s)?';
	// Not inside a longer word: no letter or digit on either side.
	const RE = new RegExp('(^|[^a-z0-9])(' + STEM_RE + '|' + WORD_RE + ')(?![a-z0-9])', 'gi');

	// Word by word: a token longer than any of these is left alone, which
	// also keeps the pattern's cost bounded on a page of "ssssss...".
	const TOKEN = /\S+/g;
	const MAX_TOKEN = 40;

	function maskToken(tok) {
		if (tok.length > MAX_TOKEN) return tok;
		RE.lastIndex = 0;
		return tok.replace(RE, (all, pre, word) => pre + word[0] + '*'.repeat(word.length - 1));
	}

	function mask(text) {
		if (text === null || text === undefined) return '';
		return String(text).replace(TOKEN, maskToken);
	}

	function has(text) {
		const s = String(text || '');
		return mask(s) !== s;
	}

	const api = { has, mask };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else root.SigilTextFilter = api;
})(typeof window !== 'undefined' ? window : this);
