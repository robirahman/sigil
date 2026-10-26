#!/usr/bin/env python3
"""Render docs/strategy/spell_dynamics_article.md into docs/strategy-guide.html.

The article is the source; the page's chrome (header, styles, Firebase
sign-in status) lives in this script. Re-run after editing the article:

    python3 tools/render_strategy_guide.py

Handles the Markdown the article uses: #/##/### headings, paragraphs,
**bold**, *italic*, pipe tables, - and 1. lists, and --- rules.
"""
import html
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'docs', 'strategy', 'spell_dynamics_article.md')
OUT = os.path.join(ROOT, 'docs', 'strategy-guide.html')


def inline(text):
	text = html.escape(text, quote=False)
	text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
	text = re.sub(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])', r'<em>\1</em>', text)
	return text


def slug(text):
	return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')


def table(rows):
	cells = [[c.strip() for c in r.strip().strip('|').split('|')] for r in rows]
	head, body = cells[0], cells[2:]
	out = ['<div class="table-wrap"><table>', '<thead><tr>']
	out += ['<th>' + inline(c) + '</th>' for c in head]
	out.append('</tr></thead><tbody>')
	for r in body:
		out.append('<tr>' + ''.join('<td>' + inline(c) + '</td>' for c in r) + '</tr>')
	out.append('</tbody></table></div>')
	return ''.join(out)


def render(md):
	lines = md.split('\n')
	blocks, toc, title = [], [], ''
	i = 0
	while i < len(lines):
		line = lines[i]
		if not line.strip():
			i += 1
			continue
		m = re.match(r'(#{1,3}) (.*)', line)
		if m:
			level, text = len(m.group(1)), m.group(2).strip()
			if level == 1:
				title = text
			else:
				tag = 'h3' if level == 2 else 'h4'
				anchor = slug(text)
				if level == 2:
					toc.append((anchor, text))
				blocks.append('<%s id="%s">%s</%s>' % (tag, anchor, inline(text), tag))
			i += 1
			continue
		if line.strip() == '---':
			blocks.append('<hr />')
			i += 1
			continue
		if line.startswith('|'):
			rows = []
			while i < len(lines) and lines[i].startswith('|'):
				rows.append(lines[i])
				i += 1
			blocks.append(table(rows))
			continue
		if re.match(r'(- |\d+\. )', line):
			ordered = not line.startswith('- ')
			items = []
			while i < len(lines) and re.match(r'(- |\d+\. )', lines[i]):
				items.append(re.sub(r'^(- |\d+\. )', '', lines[i]))
				i += 1
			tag = 'ol' if ordered else 'ul'
			blocks.append('<%s>%s</%s>' % (tag, ''.join('<li>' + inline(t) + '</li>' for t in items), tag))
			continue
		para = []
		while i < len(lines) and lines[i].strip() and not re.match(r'(#{1,3} |\||- |\d+\. |---$)', lines[i]):
			para.append(lines[i].strip())
			i += 1
		blocks.append('<p>' + inline(' '.join(para)) + '</p>')
	return title, toc, blocks


PAGE = '''<!DOCTYPE html>
<html class="height:100%%" lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link href="static/css/global.css?v202305191" rel="stylesheet" />
	<link href="static/css/layout.css" rel="stylesheet" />
	<link href="static/css/styles.css" rel="stylesheet" />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
	<link href="https://fonts.googleapis.com/css2?family=Arvo&family=Overlock&display=swap" rel="stylesheet" />
	<link href="https://use.typekit.net/rot4udi.css" rel="stylesheet" />
	<script src="static/scripts/theme-manager.js"></script>
	<title>Strategy Guide - Sigil Online</title>
	<style>
		body > .main { padding-top: 80px; }
		.guide {
			box-sizing: border-box;
			width: 100%%;
			min-width: 0;
			max-width: 760px;
			margin: 0 auto;
			padding: 24px 16px 60px;
			font-family: 'Overlock', sans-serif;
			color: var(--color-text);
			line-height: 1.55;
		}
		.guide h2 { font-family: 'Arvo', serif; color: var(--color-text-warm); font-size: 1.5em; margin: 0 0 12px; line-height: 1.3; }
		.guide h3 { font-family: 'Arvo', serif; color: var(--color-text-warm); font-size: 1.2em; margin: 32px 0 10px; }
		.guide h4 { font-family: 'Arvo', serif; color: var(--color-text-warm); font-size: 1.05em; margin: 22px 0 8px; }
		.guide p, .guide li { color: var(--color-text); }
		.guide p { margin: 0 0 12px; }
		.guide strong { color: var(--color-text-warm); }
		.guide a { color: var(--color-accent); text-decoration: none; }
		.guide a:hover { text-decoration: underline; }
		.guide ul, .guide ol { padding-left: 1.4em; }
		.guide li { margin: 4px 0; }
		.guide hr { border: 0; border-top: 1px solid var(--color-border); margin: 28px 0 16px; }
		.guide .toc {
			margin: 16px 0 8px;
			padding: 12px 16px;
			background: var(--color-surface);
			border: 2px solid var(--color-border);
			border-radius: 10px;
		}
		.guide .toc ol { margin: 6px 0 0; }
		/* Wide tables scroll inside their box on phones, never the page. */
		.guide .table-wrap { max-width: 100%%; overflow-x: auto; margin: 12px 0 16px; }
		.guide table { border-collapse: collapse; font-size: 0.92em; min-width: 100%%; }
		.guide th, .guide td { border: 1px solid var(--color-border); padding: 5px 8px; text-align: left; vertical-align: top; }
		.guide th { background: var(--color-surface); color: var(--color-text-warm); }
		.guide .back { margin-top: 32px; text-align: center; }
	</style>
</head>
<body>
	<header>
		<div class="container">
			<div class="header-container">
				<div>
					<h1 class="logo"><a href="./"><span class="visually-hidden">Sigil Online</span><img alt="" src="static/images/logo-icon.svg" height="40" width="32" /></a></h1>
				</div>
				<h1></h1>
				<div id="auth-status"></div>
			</div>
		</div>
	</header>

	<div class="main">
		<!-- Generated from docs/strategy/spell_dynamics_article.md by
		     tools/render_strategy_guide.py: edit the article and re-run. -->
		<article class="guide">
			<h2>%(title)s</h2>
%(intro)s
			<nav class="toc" aria-label="Contents">
				<strong>Contents</strong>
				<ol>
%(toc)s
				</ol>
			</nav>
%(body)s
			<p class="back">New to the game? Start with the <a href="tutorial.html">tutorial</a>. Then try the <a href="puzzles.html">puzzles</a>, or read the <a href="spells.html">Spells Matrix</a> and the <a href="static/Sigil_Rulebook.pdf" target="_blank" rel="noopener">rulebook</a>.</p>
			<p class="back"><a href="./">&larr; Back to menu</a></p>
		</article>
	</div>

	<!-- Firebase SDK + auth status -->
	<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
	<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js"></script>
	<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
	<script>
		if (typeof firebase !== 'undefined') firebase.initializeApp({
			apiKey: "AIzaSyDcYsA9GxotScZ6m92B_TDSArkeN1qMHvE",
			authDomain: "sigil-js.firebaseapp.com",
			databaseURL: "https://sigil-js-default-rtdb.firebaseio.com",
			projectId: "sigil-js",
			storageBucket: "sigil-js.firebasestorage.app",
			messagingSenderId: "174679859896",
			appId: "1:174679859896:web:9f8e5ddc4388ae73a60a4d"
		});
	</script>
	<script src="static/scripts/auth-status.js"></script>
</body>
</html>
'''


def main():
	with open(SRC, encoding='utf-8') as f:
		title, toc, blocks = render(f.read())
	# The blocks before the first section heading are the standfirst.
	first = next(i for i, b in enumerate(blocks) if b.startswith('<h3'))
	indent = lambda bs: '\n'.join('\t\t\t' + b for b in bs)
	page = PAGE % {
		'title': inline(title),
		'intro': indent(blocks[:first]),
		'toc': '\n'.join('\t\t\t\t\t<li><a href="#%s">%s</a></li>' % (a, inline(t)) for a, t in toc),
		'body': indent(blocks[first:]),
	}
	with open(OUT, 'w', encoding='utf-8') as f:
		f.write(page)


if __name__ == '__main__':
	main()
