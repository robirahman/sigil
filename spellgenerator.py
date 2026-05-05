
### Sigil Online spell generator file


import os
import random


CORE_RITUALS = ['Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning']
CORE_SORCERIES = ['Grow', 'Fireblast', 'Hail_Storm', 'Meteor', 'Seal_of_Wind']
CORE_CHARMS = ['Sprout', 'Slash', 'Surge', 'Comet', 'Seal_of_Summer']

# Springtime expansion: each pack adds to the core pool.
SPRINGTIME_RITUALS = ['Blossom']
SPRINGTIME_SORCERIES = ['Scatter']
SPRINGTIME_CHARMS = ['Seal_of_Spring']

# Celestial expansion.
CELESTIAL_RITUALS = ['Syzygy']
CELESTIAL_SORCERIES = ['Eclipse']
CELESTIAL_CHARMS = ['Azimuth']


SPELL_PACKS = {
	'core': {
		'rituals': CORE_RITUALS,
		'sorceries': CORE_SORCERIES,
		'charms': CORE_CHARMS,
	},
	'springtime': {
		'rituals': CORE_RITUALS + SPRINGTIME_RITUALS,
		'sorceries': CORE_SORCERIES + SPRINGTIME_SORCERIES,
		'charms': CORE_CHARMS + SPRINGTIME_CHARMS,
	},
	'celestial': {
		'rituals': CORE_RITUALS + CELESTIAL_RITUALS,
		'sorceries': CORE_SORCERIES + CELESTIAL_SORCERIES,
		'charms': CORE_CHARMS + CELESTIAL_CHARMS,
	},
	'all': {
		'rituals': CORE_RITUALS + SPRINGTIME_RITUALS + CELESTIAL_RITUALS,
		'sorceries': CORE_SORCERIES + SPRINGTIME_SORCERIES + CELESTIAL_SORCERIES,
		'charms': CORE_CHARMS + SPRINGTIME_CHARMS + CELESTIAL_CHARMS,
	},
}


def generate_spell_list(pack_key=None):
	"""Generate the 9 spell instantiation strings for a new game.

	`pack_key` selects which pack pool to draw from ('core', 'springtime',
	'celestial', or 'all'). Defaults to the SIGIL_SPELL_PACK env var if set,
	else 'core'.
	"""
	if pack_key is None:
		pack_key = os.environ.get('SIGIL_SPELL_PACK', 'core')
	pack = SPELL_PACKS.get(pack_key, SPELL_PACKS['core'])

	rituals = random.sample(pack['rituals'], 3)
	sorceries = random.sample(pack['sorceries'], 3)
	charms = random.sample(pack['charms'], 3)

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
