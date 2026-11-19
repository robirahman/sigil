/**
 * gif-encoder.js — a small animated-GIF (GIF89a) encoder, for the game
 * review's "Download GIF" (board-image.js). Runs in the page, no server.
 *
 *   const enc = new SigilGifEncoder(width, height, { loop: 0 });
 *   enc.setPalette(SigilGifEncoder.buildPalette([rgba1, rgba2, ...]));
 *   enc.addFrame(rgba, delayMs);      // Uint8ClampedArray of width*height*4
 *   const bytes = enc.finish();       // Uint8Array
 *
 * One global palette for the whole animation (a game's frames are the same
 * board art with different stones, so a palette built from a few frames fits
 * all of them): a median cut over a 15-bit colour histogram, 255 colours,
 * with index 255 kept for transparency. Every frame after the first is
 * stored as the rectangle that changed since the frame before, with the
 * unchanged pixels inside it transparent (disposal "leave in place"), so a
 * whole game costs little more than its first frame. A frame identical to
 * the previous one only lengthens the previous frame's delay.
 *
 * Classic script (a global) and require()-able in node for tests.
 */

const SigilGifEncoder = (() => {
	const TRANSPARENT = 255;
	const MAX_COLOURS = 255;

	/** A growable byte buffer. */
	class Bytes {
		constructor(n) { this.buf = new Uint8Array(n || 4096); this.len = 0; }
		_room(n) {
			if (this.len + n <= this.buf.length) return;
			let size = this.buf.length * 2;
			while (size < this.len + n) size *= 2;
			const next = new Uint8Array(size);
			next.set(this.buf.subarray(0, this.len));
			this.buf = next;
		}
		byte(b) { this._room(1); this.buf[this.len++] = b; }
		bytes(arr) { this._room(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
		u16(v) { this.byte(v & 0xff); this.byte((v >> 8) & 0xff); }
		str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
		result() { return this.buf.slice(0, this.len); }
	}

	/**
	 * Median-cut palette from RGBA buffers (sampled, every `step` pixels).
	 * Returns a Uint8Array of 256*3 bytes (unused entries black).
	 */
	function buildPalette(buffers, maxColours) {
		maxColours = Math.min(maxColours || MAX_COLOURS, MAX_COLOURS);
		const hist = new Uint32Array(32768);
		for (const buf of buffers) {
			const n = buf.length >> 2;
			const step = Math.max(1, Math.floor(n / 200000));
			for (let i = 0; i < n; i += step) {
				const o = i << 2;
				hist[((buf[o] >> 3) << 10) | ((buf[o + 1] >> 3) << 5) | (buf[o + 2] >> 3)]++;
			}
		}
		const bins = [];
		for (let c = 0; c < 32768; c++) if (hist[c]) bins.push(c);
		const comp = (c, ch) => (ch === 0 ? (c >> 10) : ch === 1 ? ((c >> 5) & 31) : (c & 31));
		const box = (list) => {
			let lo = [31, 31, 31], hi = [0, 0, 0], count = 0;
			for (const c of list) {
				for (let ch = 0; ch < 3; ch++) {
					const v = comp(c, ch);
					if (v < lo[ch]) lo[ch] = v;
					if (v > hi[ch]) hi[ch] = v;
				}
				count += hist[c];
			}
			const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
			const ch = span[1] >= span[0] && span[1] >= span[2] ? 1 : (span[0] >= span[2] ? 0 : 2);
			return { list, count, ch, span: span[ch] };
		};
		const boxes = [box(bins)];
		while (boxes.length < maxColours) {
			// Split the box with the most pixels that can still be split.
			let best = -1, bestScore = -1;
			for (let i = 0; i < boxes.length; i++) {
				const b = boxes[i];
				if (b.list.length < 2 || b.span === 0) continue;
				const score = b.count * b.span;
				if (score > bestScore) { bestScore = score; best = i; }
			}
			if (best < 0) break;
			const b = boxes[best];
			b.list.sort((x, y) => comp(x, b.ch) - comp(y, b.ch));
			let half = b.count / 2, acc = 0, cut = 1;
			for (let i = 0; i < b.list.length - 1; i++) {
				acc += hist[b.list[i]];
				if (acc >= half) { cut = i + 1; break; }
				cut = i + 1;
			}
			boxes.splice(best, 1, box(b.list.slice(0, cut)), box(b.list.slice(cut)));
		}
		const pal = new Uint8Array(256 * 3);
		boxes.forEach((b, i) => {
			let r = 0, g = 0, bl = 0, w = 0;
			for (const c of b.list) {
				const k = hist[c];
				r += ((c >> 10) * 8 + 4) * k;
				g += (((c >> 5) & 31) * 8 + 4) * k;
				bl += ((c & 31) * 8 + 4) * k;
				w += k;
			}
			pal[i * 3] = Math.round(r / w);
			pal[i * 3 + 1] = Math.round(g / w);
			pal[i * 3 + 2] = Math.round(bl / w);
		});
		pal.colours = boxes.length;
		return pal;
	}

	/** RGBA -> palette indices (nearest colour, cached per 15-bit colour). */
	function mapper(pal) {
		const n = pal.colours || MAX_COLOURS;
		const cache = new Int16Array(32768).fill(-1);
		return function map(rgba, out) {
			const px = rgba.length >> 2;
			for (let i = 0; i < px; i++) {
				const o = i << 2;
				const key = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
				let idx = cache[key];
				if (idx < 0) {
					const r = (rgba[o] & 0xf8) + 4, g = (rgba[o + 1] & 0xf8) + 4, b = (rgba[o + 2] & 0xf8) + 4;
					let bestD = Infinity;
					for (let k = 0; k < n; k++) {
						const dr = pal[k * 3] - r, dg = pal[k * 3 + 1] - g, db = pal[k * 3 + 2] - b;
						const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
						if (d < bestD) { bestD = d; idx = k; }
					}
					cache[key] = idx;
				}
				out[i] = idx;
			}
			return out;
		};
	}

	/** GIF LZW: indices (8-bit) -> data sub-blocks (into `out`, a Bytes), min code size 8. */
	function lzw(indices, out) {
		const MIN = 8, CLEAR = 1 << MIN, EOI = CLEAR + 1;
		const HSIZE = 5003;
		const htab = new Int32Array(HSIZE);
		const codetab = new Int32Array(HSIZE);
		out = out || new Bytes(indices.length >> 1);
		const block = new Uint8Array(255);
		let blen = 0;
		let acc = 0, nbits = 0;
		let codeSize = MIN + 1, nextCode = EOI + 1;
		const flushByte = (b) => {
			block[blen++] = b;
			if (blen === 255) { out.byte(255); out.bytes(block); blen = 0; }
		};
		const emit = (code) => {
			acc |= code << nbits;
			nbits += codeSize;
			while (nbits >= 8) { flushByte(acc & 0xff); acc >>>= 8; nbits -= 8; }
		};
		const reset = () => { htab.fill(-1); codeSize = MIN + 1; nextCode = EOI + 1; };
		reset();
		emit(CLEAR);
		if (indices.length) {
			let ent = indices[0];
			for (let i = 1; i < indices.length; i++) {
				const c = indices[i];
				const fcode = (c << 12) + ent;
				let h = (c << 4) ^ ent;   // xor hashing
				if (h >= HSIZE) h %= HSIZE;
				let found = false;
				if (htab[h] === fcode) { ent = codetab[h]; found = true; }
				else if (htab[h] >= 0) {
					const disp = h === 0 ? 1 : HSIZE - h;
					for (;;) {
						h -= disp;
						if (h < 0) h += HSIZE;
						if (htab[h] === fcode) { ent = codetab[h]; found = true; break; }
						if (htab[h] < 0) break;
					}
				}
				if (found) continue;
				emit(ent);
				ent = c;
				if (nextCode < 4096) {
					codetab[h] = nextCode++;
					htab[h] = fcode;
					// The decoder widens one code later than it adds the entry.
					if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
				} else {
					emit(CLEAR);
					reset();
				}
			}
			emit(ent);
		}
		emit(EOI);
		if (nbits > 0) flushByte(acc & 0xff);
		if (blen) { out.byte(blen); out.bytes(block.subarray(0, blen)); }
		out.byte(0);
		return out;
	}

	class Encoder {
		constructor(width, height, opts) {
			this.w = width;
			this.h = height;
			this.loop = opts && typeof opts.loop === 'number' ? opts.loop : 0;
			this.parts = new Bytes(1 << 16);
			this.pal = null;
			this.map = null;
			this.prev = null;       // previous frame's full index buffer
			this.pending = null;    // last frame, held so a repeat can extend its delay
		}

		setPalette(pal) {
			this.pal = pal;
			this.map = mapper(pal);
		}

		/** Append a frame (RGBA, w*h*4) shown for `delayMs`. */
		addFrame(rgba, delayMs) {
			if (!this.pal) this.setPalette(buildPalette([rgba]));
			const idx = this.map(rgba, new Uint8Array(this.w * this.h));
			const delay = Math.max(2, Math.round((delayMs || 100) / 10));
			if (!this.prev) {
				this._queue({ x: 0, y: 0, w: this.w, h: this.h, data: idx, delay, transparent: false });
				this.prev = idx;
				return;
			}
			// Bounding box of the changed pixels.
			let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
			for (let y = 0; y < this.h; y++) {
				const row = y * this.w;
				for (let x = 0; x < this.w; x++) {
					if (idx[row + x] !== this.prev[row + x]) {
						if (x < x0) x0 = x;
						if (x > x1) x1 = x;
						if (y < y0) y0 = y;
						y1 = y;
					}
				}
			}
			if (x1 < 0) {
				// Nothing changed: the previous frame stays up longer.
				this.pending.delay += delay;
				return;
			}
			const w = x1 - x0 + 1, h = y1 - y0 + 1;
			const data = new Uint8Array(w * h);
			for (let y = 0; y < h; y++) {
				const src = (y0 + y) * this.w + x0;
				for (let x = 0; x < w; x++) {
					const v = idx[src + x];
					data[y * w + x] = v === this.prev[src + x] ? TRANSPARENT : v;
				}
			}
			this._queue({ x: x0, y: y0, w, h, data, delay, transparent: true });
			this.prev = idx;
		}

		_queue(frame) {
			if (this.pending) this._write(this.pending);
			this.pending = frame;
		}

		_write(f) {
			const p = this.parts;
			// Graphic control extension: disposal 1 (leave), transparency.
			p.bytes([0x21, 0xf9, 4, (1 << 2) | (f.transparent ? 1 : 0)]);
			p.u16(f.delay);
			p.bytes([TRANSPARENT, 0]);
			// Image descriptor (no local palette), then the LZW data.
			p.byte(0x2c);
			p.u16(f.x); p.u16(f.y); p.u16(f.w); p.u16(f.h);
			p.byte(0);
			p.byte(8);
			lzw(f.data, p);
		}

		/** The finished file as a Uint8Array. */
		finish() {
			if (this.pending) { this._write(this.pending); this.pending = null; }
			const head = new Bytes(1024);
			head.str('GIF89a');
			head.u16(this.w); head.u16(this.h);
			head.bytes([0xf7, 0, 0]);   // global colour table, 8 bits, 256 entries
			head.bytes(this.pal || new Uint8Array(256 * 3));
			// NETSCAPE2.0: loop count (0 = forever).
			head.bytes([0x21, 0xff, 11]);
			head.str('NETSCAPE2.0');
			head.bytes([3, 1]);
			head.u16(this.loop);
			head.byte(0);
			const out = new Uint8Array(head.len + this.parts.len + 1);
			out.set(head.buf.subarray(0, head.len), 0);
			out.set(this.parts.buf.subarray(0, this.parts.len), head.len);
			out[out.length - 1] = 0x3b;
			return out;
		}
	}

	Encoder.buildPalette = buildPalette;
	Encoder.lzw = (indices) => lzw(indices).result();
	Encoder.TRANSPARENT = TRANSPARENT;
	return Encoder;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SigilGifEncoder;
