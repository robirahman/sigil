'use strict';
/**
 * A small in-memory stand-in for the Realtime Database admin API (ref,
 * child, once('value'), set, update, remove), for tests of server code that
 * needs no emulator. It stores values the way the database does: nulls are
 * dropped (inside arrays too), arrays are stored as index-keyed objects and
 * read back as arrays only when more than half of their indices are present.
 */

function store(v) {
	if (v === null || v === undefined) return undefined;
	if (Array.isArray(v) || (typeof v === 'object')) {
		const out = {};
		for (const [k, x] of Object.entries(v)) {
			const s = store(x);
			if (s !== undefined) out[k] = s;
		}
		return Object.keys(out).length ? out : undefined;
	}
	return v;
}

function read(v) {
	if (v === undefined) return null;
	if (typeof v !== 'object') return v;
	const keys = Object.keys(v);
	const out = {};
	for (const k of keys) out[k] = read(v[k]);
	if (keys.length && keys.every((k) => /^(0|[1-9]\d*)$/.test(k))) {
		const max = Math.max(...keys.map(Number));
		if (keys.length * 2 > max + 1) {
			const arr = new Array(max + 1).fill(undefined);
			for (const k of keys) arr[Number(k)] = out[k];
			return arr;
		}
	}
	return out;
}

function fakeDb(initial) {
	let root = store(JSON.parse(JSON.stringify(initial || {}))) || {};
	const parts = (p) => String(p || '').split('/').filter(Boolean);
	const get = (ps) => ps.reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), root);
	const put = (ps, v) => {
		const s = store(v === undefined ? null : JSON.parse(JSON.stringify(v)));
		if (!ps.length) { root = s || {}; return; }
		const chain = [root];
		for (let i = 0; i < ps.length - 1; i++) {
			const cur = chain[i];
			if (!cur[ps[i]] || typeof cur[ps[i]] !== 'object') cur[ps[i]] = {};
			chain.push(cur[ps[i]]);
		}
		const parent = chain[chain.length - 1];
		if (s === undefined) delete parent[ps[ps.length - 1]];
		else parent[ps[ps.length - 1]] = s;
		// Empty parents vanish, as in the database.
		for (let i = chain.length - 1; i > 0; i--) {
			if (Object.keys(chain[i]).length === 0) delete chain[i - 1][ps[i - 1]];
		}
	};
	const ref = (path) => {
		const ps = parts(path);
		return {
			key: ps.length ? ps[ps.length - 1] : null,
			child: (c) => ref(ps.concat(parts(c)).join('/')),
			async once() {
				const v = read(get(ps));
				return { val: () => v, exists: () => v !== null, key: ps[ps.length - 1] };
			},
			async set(v) { put(ps, v); },
			async remove() { put(ps, null); },
			async transaction(fn) {
				const cur = read(get(ps));
				const next = fn(cur === null ? null : JSON.parse(JSON.stringify(cur)));
				if (next === undefined) return { committed: false, snapshot: { val: () => cur } };
				put(ps, next);
				return { committed: true, snapshot: { val: () => read(get(ps)) } };
			},
			async update(obj) {
				for (const [k, v] of Object.entries(obj)) put(ps.concat(parts(k)), v);
			},
		};
	};
	return { ref, dump: () => read(root), reads: 0 };
}

module.exports = { fakeDb };
