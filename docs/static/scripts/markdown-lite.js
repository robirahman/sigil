/**
 * markdown-lite.js — the safe Markdown subset of forum posts, blogs, comments
 * and team pages.
 *
 *   Blocks:  paragraphs (a single newline is a line break), # / ## / ###
 *            headings, - or * bullet lists, 1. numbered lists, > quotes,
 *            ``` fenced code, --- rules.
 *   Inline:  **bold**, *italic* / _italic_, ~~struck~~, `code`,
 *            [text](https://...) and bare https:// links, \-escapes.
 *
 * No HTML of any kind: parse() turns the source into a small tree of plain
 * objects, and render() builds DOM nodes from it with createElement and
 * text nodes, never innerHTML, so "<script>" or "<img onerror>" in a post is
 * shown as typed. Links must be http(s) or one of the site's own pages
 * ("puzzles.html#..."), so "javascript:" never becomes a link; they open in
 * a new tab with rel="nofollow ugc noopener noreferrer".
 *
 *   SigilMarkdown.render(SigilMarkdown.parse(text), { mask }) -> DocumentFragment
 *   SigilMarkdown.toPlain(text, 140)                            -> excerpt
 *
 * parse() and toPlain() are DOM-free (classic script and CommonJS, for the
 * tests).
 */
(function (root) {
	const WEB_LINK = /^https?:\/\/[^\s<>"'`\\]+$/i;
	const SITE_LINK = /^[a-z0-9-]+\.html(?:[?#][^\s<>"'`\\]*)?$/i;
	// Nesting depth of emphasis inside emphasis; deeper markers stay text.
	const MAX_DEPTH = 6;

	/** The href for a link target, or null when it may not be one. */
	function safeHref(url) {
		const u = String(url || '').trim();
		if (WEB_LINK.test(u) || SITE_LINK.test(u)) return u;
		return null;
	}

	// ---- Blocks ----

	const RE_FENCE = /^\s{0,3}```/;
	const RE_HEADING = /^(#{1,3})\s+(.*)$/;
	const RE_RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
	const RE_QUOTE = /^\s{0,3}>/;
	const RE_BULLET = /^\s{0,3}[-*+]\s+/;
	const RE_NUMBER = /^\s{0,3}(\d{1,9})[.)]\s+/;
	const RE_BLANK = /^\s*$/;

	function startsBlock(line) {
		return RE_FENCE.test(line) || RE_HEADING.test(line) || RE_RULE.test(line)
			|| RE_QUOTE.test(line) || RE_BULLET.test(line) || RE_NUMBER.test(line);
	}

	function parse(src) {
		const lines = String(src === null || src === undefined ? '' : src).replace(/\r\n?/g, '\n').split('\n');
		const blocks = [];
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			if (RE_BLANK.test(line)) { i++; continue; }
			if (RE_FENCE.test(line)) {
				const buf = [];
				i++;
				while (i < lines.length && !RE_FENCE.test(lines[i])) buf.push(lines[i++]);
				i++;
				blocks.push({ t: 'code', text: buf.join('\n') });
				continue;
			}
			let m = RE_HEADING.exec(line);
			if (m) {
				blocks.push({ t: 'h', level: m[1].length, c: inline(m[2].replace(/\s+#+\s*$/, ''), 0) });
				i++;
				continue;
			}
			if (RE_RULE.test(line)) {
				blocks.push({ t: 'hr' });
				i++;
				continue;
			}
			if (RE_QUOTE.test(line)) {
				const buf = [];
				while (i < lines.length && RE_QUOTE.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
				blocks.push({ t: 'quote', c: inlineLines(buf) });
				continue;
			}
			if (RE_BULLET.test(line)) {
				const items = [];
				while (i < lines.length && RE_BULLET.test(lines[i])) items.push(inline(lines[i++].replace(RE_BULLET, ''), 0));
				blocks.push({ t: 'ul', items });
				continue;
			}
			m = RE_NUMBER.exec(line);
			if (m) {
				const items = [];
				while (i < lines.length && RE_NUMBER.test(lines[i])) items.push(inline(lines[i++].replace(RE_NUMBER, ''), 0));
				blocks.push({ t: 'ol', start: Math.min(Number(m[1]), 1e6), items });
				continue;
			}
			// A paragraph runs to a blank line or the start of another block.
			const buf = [line];
			i++;
			while (i < lines.length && !RE_BLANK.test(lines[i]) && !startsBlock(lines[i])) buf.push(lines[i++]);
			blocks.push({ t: 'p', c: inlineLines(buf) });
		}
		return blocks;
	}

	function inlineLines(lines) {
		const out = [];
		lines.forEach((l, k) => {
			if (k) out.push({ t: 'br' });
			out.push(...inline(l, 0));
		});
		return out;
	}

	// ---- Inline ----

	const ESCAPABLE = /[\\`*_~[\]()#>!+.-]/;
	const isWordChar = (c) => !!c && /[A-Za-z0-9]/.test(c);

	/**
	 * Inline nodes of one line. Each search for a closing marker is
	 * remembered (found or not), so a line of a thousand "*" or "[" stays
	 * linear.
	 */
	function inline(text, depth) {
		const out = [];
		let buf = '';
		const none = {};   // marker -> no closer at or after this index
		const hit = {};    // marker -> [from, at]: the first closer after `from`
		const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
		const find = (marker, from, test) => {
			if (none[marker] !== undefined && from >= none[marker]) return -1;
			const h = hit[marker];
			if (h && from >= h[0] && from <= h[1]) return h[1];
			for (let j = from; j <= text.length - marker.length; j++) {
				if (text.startsWith(marker, j) && (!test || test(j))) {
					hit[marker] = [from, j];
					return j;
				}
			}
			none[marker] = from;
			return -1;
		};
		let i = 0;
		while (i < text.length) {
			const ch = text[i];
			if (ch === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
				buf += text[i + 1];
				i += 2;
				continue;
			}
			if (ch === '`') {
				const j = find('`', i + 1);
				if (j > i + 1) {
					flush();
					out.push({ t: 'code', v: text.slice(i + 1, j) });
					i = j + 1;
					continue;
				}
			}
			if ((ch === '*' || ch === '_' || ch === '~') && depth < MAX_DEPTH) {
				const dbl = text[i + 1] === ch;
				const marker = dbl ? ch + ch : ch;
				const open = i + marker.length;
				// Opens before a non-space; "_" only at the start of a word
				// (snake_case stays as typed); "~" only doubled.
				const canOpen = (ch !== '~' || dbl) && open < text.length && !/\s/.test(text[open])
					&& (ch !== '_' || !isWordChar(text[i - 1]));
				if (canOpen) {
					const j = find(marker, open + 1, (k) => !/\s/.test(text[k - 1])
						&& (dbl || (text[k + 1] !== ch && text[k - 1] !== ch)) && (ch !== '_' || !isWordChar(text[k + marker.length])));
					if (j > open) {
						flush();
						out.push({ t: ch === '~' ? 's' : dbl ? 'b' : 'i', c: inline(text.slice(open, j), depth + 1) });
						i = j + marker.length;
						continue;
					}
				}
				buf += marker;
				i += marker.length;
				continue;
			}
			if (ch === '[') {
				const close = find(']', i + 1);
				if (close > i && text[close + 1] === '(') {
					const end = find(')', close + 2);
					const href = end > close + 1 ? safeHref(text.slice(close + 2, end)) : null;
					if (href) {
						flush();
						const label = close > i + 1 ? inline(text.slice(i + 1, close), depth + 1) : [{ t: 'text', v: href }];
						out.push({ t: 'a', href, c: label });
						i = end + 1;
						continue;
					}
				}
			}
			if ((ch === 'h' || ch === 'H') && (i === 0 || /[\s(]/.test(text[i - 1]))) {
				const m = /^https?:\/\/[^\s<>"'`\\]+/i.exec(text.slice(i, i + 2048));
				if (m) {
					// Trailing punctuation belongs to the sentence.
					const url = m[0].replace(/[.,;:!?)\]]+$/, '');
					if (/^https?:\/\/./i.test(url)) {
						flush();
						out.push({ t: 'a', href: url, c: [{ t: 'text', v: url }] });
						i += url.length;
						continue;
					}
				}
			}
			buf += ch;
			i++;
		}
		flush();
		return out;
	}

	// ---- Plain text ----

	function plainInline(nodes) {
		return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? ' ' : n.c ? plainInline(n.c) : '')).join('');
	}

	/** The text of a post without its markup, cut to `max` characters. */
	function toPlain(src, max) {
		const parts = parse(src).map((b) => {
			if (b.t === 'code') return b.text;
			if (b.t === 'ul' || b.t === 'ol') return b.items.map(plainInline).join('; ');
			if (b.c) return plainInline(b.c);
			return '';
		}).filter(Boolean);
		const s = parts.join(' ').replace(/\s+/g, ' ').trim();
		return max && s.length > max ? s.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : s;
	}

	// ---- DOM ----

	/**
	 * DOM nodes for parsed blocks. opts.mask(text) -> text is applied to
	 * every piece of text shown (the profanity filter); opts.doc is the
	 * document (tests).
	 */
	function render(blocks, opts) {
		const o = opts || {};
		const doc = o.doc || root.document;
		const mask = typeof o.mask === 'function' ? o.mask : (s) => s;
		const el = (tag, cls) => {
			const e = doc.createElement(tag);
			if (cls) e.className = cls;
			return e;
		};
		const inl = (parent, nodes) => {
			for (const n of nodes) {
				if (n.t === 'text') parent.appendChild(doc.createTextNode(mask(n.v)));
				else if (n.t === 'br') parent.appendChild(el('br'));
				else if (n.t === 'code') { const c = el('code'); c.textContent = mask(n.v); parent.appendChild(c); }
				else if (n.t === 'a') {
					const a = el('a');
					a.setAttribute('href', n.href);
					if (/^https?:/i.test(n.href)) {
						a.setAttribute('target', '_blank');
						a.setAttribute('rel', 'nofollow ugc noopener noreferrer');
					}
					inl(a, n.c);
					parent.appendChild(a);
				} else if (n.t === 'b' || n.t === 'i' || n.t === 's') {
					const e = el(n.t === 'b' ? 'strong' : n.t === 'i' ? 'em' : 'del');
					inl(e, n.c);
					parent.appendChild(e);
				}
			}
			return parent;
		};
		const frag = doc.createDocumentFragment();
		for (const b of blocks) {
			if (b.t === 'p') frag.appendChild(inl(el('p'), b.c));
			else if (b.t === 'h') frag.appendChild(inl(el('h' + (b.level + 2), 'md-h md-h' + b.level), b.c));
			else if (b.t === 'quote') frag.appendChild(inl(el('blockquote'), b.c));
			else if (b.t === 'hr') frag.appendChild(el('hr'));
			else if (b.t === 'code') {
				const pre = el('pre');
				const code = el('code');
				code.textContent = mask(b.text);
				pre.appendChild(code);
				frag.appendChild(pre);
			} else if (b.t === 'ul' || b.t === 'ol') {
				const list = el(b.t);
				if (b.t === 'ol' && b.start !== 1) list.setAttribute('start', String(b.start));
				for (const item of b.items) list.appendChild(inl(el('li'), item));
				frag.appendChild(list);
			}
		}
		return frag;
	}

	/** Replace `target`'s content with the rendered Markdown of `src`. */
	function renderInto(target, src, opts) {
		if (!target) return;
		target.textContent = '';
		target.appendChild(render(parse(src), Object.assign({ doc: target.ownerDocument }, opts || {})));
	}

	const api = { parse, render, renderInto, toPlain, safeHref };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else root.SigilMarkdown = api;
})(typeof window !== 'undefined' ? window : this);
