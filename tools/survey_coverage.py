"""Archive new spell-survey-*.json exports, re-ingest, and report comparison coverage."""
import json, glob, shutil, os, subprocess
from collections import defaultdict
for f in glob.glob('spell-survey-*.json'):
    j = json.load(open(f)); stamp = j['exportedAt'].replace(':', '').replace('-', '')[:15]
    dst = f'survey_exports/spell-survey-{stamp}.json'
    if not os.path.exists(dst): shutil.copy(f, dst); print('archived', dst)
files = sorted(glob.glob('survey_exports/*.json'))
print(subprocess.run(['python3', 'tools/ingest_spell_survey.py', *files], capture_output=True, text=True).stdout.strip())
spells = {}; pairs = {}
for f in files:
    j = json.load(open(f))
    for k, v in j['spells'].items(): spells.setdefault(k, {}).update(v)
    for k, v in j['pairs'].items(): pairs.setdefault(k, {}).update(v)
ALL = set(spells)
comps = [(k.split('|'), v['better']) for k, v in pairs.items() if v.get('better')]
print('comparisons:', len(comps), '| fully answered pairs:', sum(all(x in v for x in ('synergy', 'advantage', 'better')) for v in pairs.values()))
und = defaultdict(set); deg = defaultdict(int); g = defaultdict(set)
for (a, b), w in comps:
    und[a].add(b); und[b].add(a); deg[a] += 1; deg[b] += 1
    if w == a: g[a].add(b)
    elif w == b: g[b].add(a)
cyc = []
def dfs(n, stack, seen):
    for m in g[n]:
        if m in stack: cyc.append(stack[stack.index(m):] + [m]); continue
        if m not in seen: seen.add(m); dfs(m, stack + [m], seen)
for n in list(g): dfs(n, [n], {n})
print('strict cycles:', cyc[:5] or 'none')
Q = {'good': 0, 'medium': 1, 'bad': 2}
bad = [(w, b if w == a else a) for (a, b), w in comps if w in (a, b) and Q[spells[w]['quality']] > Q[spells[b if w == a else a]['quality']]]
print('lower-quality judged better:', bad or 'none')
hubs = {n for n in ALL if deg[n] >= 10}
print('hubs:', sorted(hubs))
print('deg<4 or hub-only:', [f"{n}({deg[n]})" for n in sorted(ALL, key=lambda n: (deg[n], n)) if deg[n] < 4 or not [m for m in und[n] if m not in hubs]])
