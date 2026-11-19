'use strict';
/**
 * A small GIF decoder for the tests of docs/static/scripts/gif-encoder.js
 * (tools/analysis-export-smoke.js, tools/browser/analysis-export-emulator-test.js):
 * parses the blocks and LZW-decodes every frame, so a broken encoder fails
 * here rather than in a viewer.
 *
 *   decodeGif(bytes) -> { w, h, pal, loop, frames: [{ x, y, w, h, delay,
 *                         disposal, transparent, tidx, indices }] }
 */

function lzwDecode(data, min, n) {
	const clear = 1 << min, eoi = clear + 1;
	let size, next, dict;
	const reset = () => {
		dict = [];
		for (let i = 0; i < clear; i++) dict[i] = [i];
		dict[clear] = [];
		dict[eoi] = [];
		size = min + 1;
		next = eoi + 1;
	};
	reset();
	const out = [];
	let bitpos = 0, prev = null;
	const read = () => {
		let v = 0;
		for (let i = 0; i < size; i++) {
			const byte = data[(bitpos + i) >> 3];
			if (byte === undefined) return -1;
			v |= ((byte >> ((bitpos + i) & 7)) & 1) << i;
		}
		bitpos += size;
		return v;
	};
	for (;;) {
		const code = read();
		if (code < 0) throw new Error('LZW data ended without an end code');
		if (code === clear) { reset(); prev = null; continue; }
		if (code === eoi) break;
		let entry;
		if (code < next && dict[code]) entry = dict[code];
		else if (code === next && prev) entry = prev.concat([prev[0]]);
		else throw new Error('bad LZW code ' + code + ' (next ' + next + ')');
		for (const v of entry) out.push(v);
		if (prev && next < 4096) {
			dict[next++] = prev.concat([entry[0]]);
			if (next === (1 << size) && size < 12) size++;
		}
		prev = entry;
	}
	if (out.length !== n) throw new Error('decoded ' + out.length + ' pixels, expected ' + n);
	return out;
}

function decodeGif(b) {
	let p = 0;
	const u8 = () => b[p++];
	const u16 = () => { const v = b[p] | (b[p + 1] << 8); p += 2; return v; };
	const sig = String.fromCharCode(...b.slice(0, 6));
	if (sig !== 'GIF89a') throw new Error('not a GIF89a: ' + sig);
	p = 6;
	const w = u16(), h = u16(), flags = u8();
	p += 2;
	let pal = null;
	if (flags & 0x80) { const n = 2 << (flags & 7); pal = b.slice(p, p + n * 3); p += n * 3; }
	const frames = [];
	let gce = null, loop = null;
	for (;;) {
		if (p >= b.length) throw new Error('no trailer');
		const t = u8();
		if (t === 0x3b) break;
		if (t === 0x21) {
			const label = u8();
			if (label === 0xf9) {
				u8();
				const f = u8();
				const delay = u16();
				const tidx = u8();
				u8();
				gce = { disposal: (f >> 2) & 7, transparent: !!(f & 1), delay, tidx };
			} else if (label === 0xff) {
				const n = u8();
				const id = String.fromCharCode(...b.slice(p, p + n));
				p += n;
				for (let s = u8(); s; s = u8()) {
					if (id === 'NETSCAPE2.0') loop = b[p + 1] | (b[p + 2] << 8);
					p += s;
				}
			} else {
				for (let s = u8(); s; s = u8()) p += s;
			}
			continue;
		}
		if (t !== 0x2c) throw new Error('unexpected block 0x' + t.toString(16) + ' at ' + (p - 1));
		const x = u16(), y = u16(), fw = u16(), fh = u16(), ff = u8();
		if (ff & 0x80) p += 3 * (2 << (ff & 7));
		const min = u8();
		const data = [];
		for (let s = u8(); s; s = u8()) { for (let i = 0; i < s; i++) data.push(b[p + i]); p += s; }
		if (x + fw > w || y + fh > h) throw new Error('frame outside the canvas');
		frames.push(Object.assign({ x, y, w: fw, h: fh, indices: lzwDecode(data, min, fw * fh) }, gce || {}));
		gce = null;
	}
	return { w, h, pal, frames, loop };
}

module.exports = { decodeGif, lzwDecode };
