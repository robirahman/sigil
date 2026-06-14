
### Sigil Online spell generator file


import os
import random


CORE_RITUALS = ['Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning']
CORE_SORCERIES = ['Grow', 'Fireblast', 'Hail_Storm', 'Meteor', 'Seal_of_Wind']
CORE_CHARMS = ['Sprout', 'Slash', 'Surge', 'Comet', 'Seal_of_Summer']

# Each expansion lists only its OWN new spells (not the core ones). A game's
# spell pool is core + every selected expansion. Multiple expansions can be
# combined. Mirrors docs/static/scripts/engine/constants.js EXPANSIONS.
# The unofficial Panda expansion is intentionally NOT included here.

# Springtime expansion.
SPRINGTIME_RITUALS = ['Blossom']
SPRINGTIME_SORCERIES = ['Scatter']
SPRINGTIME_CHARMS = ['Seal_of_Spring']

# Celestial expansion.
CELESTIAL_RITUALS = ['Syzygy']
CELESTIAL_SORCERIES = ['Eclipse']
CELESTIAL_CHARMS = ['Azimuth']

# Inferno expansion (JS internal key 'fury', display name "Inferno").
INFERNO_RITUALS = ['Erupt']
INFERNO_SORCERIES = ['Fury']
INFERNO_CHARMS = ['Charge']

# Tempest expansion.
TEMPEST_RITUALS = ['Hurricane']
TEMPEST_SORCERIES = ['Storm_Front']
TEMPEST_CHARMS = ['Gust']

# Tsunami expansion.
TSUNAMI_RITUALS = ['Flood']
TSUNAMI_SORCERIES = ['Torrent']
TSUNAMI_CHARMS = ['Splash']

# Gloom expansion.
GLOOM_RITUALS = ['Wither']
GLOOM_SORCERIES = ['Decay']
GLOOM_CHARMS = ['Lurk']

# Covenant expansion (static seals).
COVENANT_RITUALS = ['Seal_of_Destruction']
COVENANT_SORCERIES = ['Seal_of_Stone']
COVENANT_CHARMS = ['Seal_of_Winter']


# Own-only spell lists per expansion key. Keys match the JS EXPANSIONS map
# (note Inferno's key is 'fury'). 'inferno' is accepted as an alias below.
EXPANSIONS = {
	'springtime': {'rituals': SPRINGTIME_RITUALS, 'sorceries': SPRINGTIME_SORCERIES, 'charms': SPRINGTIME_CHARMS},
	'celestial':  {'rituals': CELESTIAL_RITUALS,  'sorceries': CELESTIAL_SORCERIES,  'charms': CELESTIAL_CHARMS},
	'fury':       {'rituals': INFERNO_RITUALS,    'sorceries': INFERNO_SORCERIES,    'charms': INFERNO_CHARMS},
	'tempest':    {'rituals': TEMPEST_RITUALS,    'sorceries': TEMPEST_SORCERIES,    'charms': TEMPEST_CHARMS},
	'tsunami':    {'rituals': TSUNAMI_RITUALS,    'sorceries': TSUNAMI_SORCERIES,    'charms': TSUNAMI_CHARMS},
	'gloom':      {'rituals': GLOOM_RITUALS,      'sorceries': GLOOM_SORCERIES,      'charms': GLOOM_CHARMS},
	'covenant':   {'rituals': COVENANT_RITUALS,   'sorceries': COVENANT_SORCERIES,   'charms': COVENANT_CHARMS},
}
EXPANSION_KEYS = ['springtime', 'celestial', 'fury', 'tempest', 'tsunami', 'gloom', 'covenant']

# Accepted aliases for expansion keys.
_EXPANSION_ALIASES = {'inferno': 'fury'}


def normalize_expansion_selection(selection):
	"""Normalize a selection (str, CSV string, or iterable) into a de-duped,
	canonical list of expansion keys in EXPANSION_KEYS order. Unknown keys are
	dropped. 'core' / '' contribute nothing; 'all' selects every expansion."""
	if selection is None:
		return []
	if isinstance(selection, str):
		parts = [p.strip() for p in selection.replace(',', ' ').split()]
	else:
		parts = [str(p).strip() for p in selection]
	chosen = set()
	for p in parts:
		key = p.lower()
		if not key or key == 'core':
			continue
		if key == 'all':
			return list(EXPANSION_KEYS)
		key = _EXPANSION_ALIASES.get(key, key)
		if key in EXPANSIONS:
			chosen.add(key)
	return [k for k in EXPANSION_KEYS if k in chosen]


def spell_pool(expansions=None):
	"""Return the (rituals, sorceries, charms) pools = core + selected
	expansions. `expansions` is anything normalize_expansion_selection accepts."""
	keys = normalize_expansion_selection(expansions)
	rituals = list(CORE_RITUALS)
	sorceries = list(CORE_SORCERIES)
	charms = list(CORE_CHARMS)
	for k in keys:
		rituals += EXPANSIONS[k]['rituals']
		sorceries += EXPANSIONS[k]['sorceries']
		charms += EXPANSIONS[k]['charms']
	return rituals, sorceries, charms


# Backward-compatible single-pack table, regenerated from EXPANSIONS so callers
# passing pack_key='core'/'springtime'/'celestial'/'fury'/'tempest'/'tsunami'/'all'
# keep working.
def _build_spell_packs():
	packs = {'core': {'rituals': CORE_RITUALS, 'sorceries': CORE_SORCERIES, 'charms': CORE_CHARMS}}
	for k in EXPANSION_KEYS:
		r, s, c = spell_pool([k])
		packs[k] = {'rituals': r, 'sorceries': s, 'charms': c}
	r, s, c = spell_pool('all')
	packs['all'] = {'rituals': r, 'sorceries': s, 'charms': c}
	return packs


SPELL_PACKS = _build_spell_packs()


def generate_spell_list(expansions=None, pack_key=None):
	"""Generate the 9 spell instantiation strings for a new game.

	Selection precedence:
	  1. `expansions` — a list/set/CSV of expansion keys to combine with core
	     (mirrors the deployed JS site, where multiple expansions stack).
	  2. `pack_key` — legacy single-pack selector ('core', a single expansion
	     key, or 'all').
	  3. SIGIL_SPELL_PACKS env var (CSV/space list of expansion keys).
	  4. SIGIL_SPELL_PACK env var (single legacy pack key).
	  5. 'core'.
	The unofficial Panda expansion is never included.
	"""
	if expansions is not None:
		rituals_pool, sorceries_pool, charms_pool = spell_pool(expansions)
	elif pack_key is not None:
		rituals_pool, sorceries_pool, charms_pool = spell_pool(
			list(EXPANSION_KEYS) if pack_key == 'all' else [pack_key])
	elif os.environ.get('SIGIL_SPELL_PACKS'):
		rituals_pool, sorceries_pool, charms_pool = spell_pool(os.environ['SIGIL_SPELL_PACKS'])
	else:
		rituals_pool, sorceries_pool, charms_pool = spell_pool(os.environ.get('SIGIL_SPELL_PACK', 'core'))

	rituals = random.sample(rituals_pool, 3)
	sorceries = random.sample(sorceries_pool, 3)
	charms = random.sample(charms_pool, 3)

	picks = [rituals, sorceries, charms]
	keys = normalize_expansion_selection(expansions)
	if expansions is None:
		if pack_key is not None:
			keys = normalize_expansion_selection(list(EXPANSION_KEYS) if pack_key == 'all' else [pack_key])
		elif os.environ.get('SIGIL_SPELL_PACKS'):
			keys = normalize_expansion_selection(os.environ['SIGIL_SPELL_PACKS'])
		else:
			keys = normalize_expansion_selection(os.environ.get('SIGIL_SPELL_PACK', 'core'))

	if keys:
		for k in keys:
			exp = EXPANSIONS[k]
			has_spell = (any(s in exp['rituals'] for s in picks[0]) or
			             any(s in exp['sorceries'] for s in picks[1]) or
			             any(s in exp['charms'] for s in picks[2]))
			if has_spell:
				continue

			def get_exp_count(key_name):
				e = EXPANSIONS[key_name]
				return (sum(1 for s in picks[0] if s in e['rituals']) +
				        sum(1 for s in picks[1] if s in e['sorceries']) +
				        sum(1 for s in picks[2] if s in e['charms']))

			swapped = False
			for i in range(3):
				cat_spells = exp['rituals'] if i == 0 else (exp['sorceries'] if i == 1 else exp['charms'])
				if not cat_spells:
					continue

				for slot in range(3):
					current_spell = picks[i][slot]
					can_swap_out = False
					current_spell_exp = None
					for ok in keys:
						e = EXPANSIONS[ok]
						if (current_spell in e['rituals'] or
						    current_spell in e['sorceries'] or
						    current_spell in e['charms']):
							current_spell_exp = ok
							break

					if not current_spell_exp:
						can_swap_out = True
					elif get_exp_count(current_spell_exp) > 1:
						can_swap_out = True

					if can_swap_out:
						available_spells = [s for s in cat_spells if s not in picks[i]]
						if available_spells:
							picks[i][slot] = random.choice(available_spells)
							swapped = True
							break
				if swapped:
					break

	rituals, sorceries, charms = picks[0], picks[1], picks[2]

	ritual1 = "spellfile." + rituals[0] + "(self, self.positions[1], '" + rituals[0] + "')"
	ritual2 = "spellfile." + rituals[1] + "(self, self.positions[2], '" + rituals[1] + "')"
	ritual3 = "spellfile." + rituals[2] + "(self, self.positions[3], '" + rituals[2] + "')"

	sorcery1 = "spellfile." + sorceries[0] + "(self, self.positions[4], '" + sorceries[0] + "')"
	sorcery2 = "spellfile." + sorceries[1] + "(self, self.positions[5], '" + sorceries[1] + "')"
	sorcery3 = "spellfile." + sorceries[2] + "(self, self.positions[6], '" + sorceries[2] + "')"

	charm1 = "spellfile." + charms[0] + "(self, self.positions[7], '" + charms[0] + "')"
	charm2 = "spellfile." + charms[1] + "(self, self.positions[8], '" + charms[1] + "')"
	charm3 = "spellfile." + charms[2] + "(self, self.positions[9], '" + charms[2] + "')"

	return [ritual1, ritual2, ritual3, sorcery1, sorcery2, sorcery3, charm1, charm2, charm3]
