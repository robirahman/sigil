
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

# Tectonic expansion.
TECTONIC_RITUALS = ['Fissure']
TECTONIC_SORCERIES = ['Rock_Slide']
TECTONIC_CHARMS = ['Bulwark']


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
	'tectonic':   {'rituals': TECTONIC_RITUALS,   'sorceries': TECTONIC_SORCERIES,   'charms': TECTONIC_CHARMS},
}
EXPANSION_KEYS = ['springtime', 'celestial', 'fury', 'tempest', 'tsunami', 'gloom', 'covenant', 'tectonic']

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
	  1. `expansions` — a list/set/CSV of expansion keys to combine
	  2. `pack_key` — legacy single-pack selector
	  3. SIGIL_SPELL_PACKS env var
	  4. SIGIL_SPELL_PACK env var
	  5. default to 'core'
	"""
	keys = set()
	if expansions is not None:
		if isinstance(expansions, str):
			parts = [p.strip().lower() for p in expansions.replace(',', ' ').split()]
		else:
			parts = [str(p).strip().lower() for p in expansions]
		for p in parts:
			if p:
				keys.add(p)
	elif pack_key is not None:
		keys.add(str(pack_key).strip().lower())
	elif os.environ.get('SIGIL_SPELL_PACKS'):
		parts = [p.strip().lower() for p in os.environ['SIGIL_SPELL_PACKS'].replace(',', ' ').split()]
		for p in parts:
			if p:
				keys.add(p)
	else:
		legacy_env = os.environ.get('SIGIL_SPELL_PACK', 'core').strip().lower()
		keys.add(legacy_env)

	# If 'all' is in keys, select everything
	if 'all' in keys:
		keys = {'core'} | set(EXPANSIONS.keys())

	# Map aliases
	mapped_keys = set()
	for k in keys:
		mapped_k = _EXPANSION_ALIASES.get(k, k)
		if mapped_k == 'core' or mapped_k in EXPANSIONS:
			mapped_keys.add(mapped_k)

	# If we parsed nothing, or it's empty, default to 'core'
	if not mapped_keys:
		mapped_keys = {'core'}

	# Now, pool the spells
	rituals_pool = []
	sorceries_pool = []
	charms_pool = []

	if 'core' in mapped_keys:
		rituals_pool.extend(CORE_RITUALS)
		sorceries_pool.extend(CORE_SORCERIES)
		charms_pool.extend(CORE_CHARMS)

	for k in mapped_keys:
		if k in EXPANSIONS:
			rituals_pool.extend(EXPANSIONS[k]['rituals'])
			sorceries_pool.extend(EXPANSIONS[k]['sorceries'])
			charms_pool.extend(EXPANSIONS[k]['charms'])

	# Ensure we have at least 3 of each category
	if len(rituals_pool) < 3 or len(sorceries_pool) < 3 or len(charms_pool) < 3:
		raise ValueError("Not enough spells selected to fill the board. Please select more spell packs.")

	# Select 3 of each randomly
	rituals = random.sample(rituals_pool, 3)
	sorceries = random.sample(sorceries_pool, 3)
	charms = random.sample(charms_pool, 3)

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
