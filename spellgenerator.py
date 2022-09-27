
### Sigil Online spell generator file
### To play Core, un-comment the last line at the bottom of file


import random

# Set exactly one of the following variables to True, to select which spells you'll play with
starter_game = False
core = True
equinox = False
apocalypse = False
all_spells = False


def generate_spell_list():


	### These should be lists of strings, which will turn into the spell objects
	### when we hit them with eval()

	### MUST BE READY TO INSTANTIATE when we eval() them!

	### To instantiate a spell, it needs the following parameters:

	### (board, position, name)

	### We will be instantiating these spell objects as a method
	### inside the board object.  So the 'board' parameter
	### should be written as 'self'.  The 'position' parameter
	### should be written as 'self.positions[i]' for the i-th spell.
	### Then 'name' can be a string.

	core_rituals = ['Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning']
	equinox_rituals = ['Planetary_Alignment', 'Blossom', 'Harvest']
	apocalypse_rituals = ['Tidal_Wave', 'Tempest', 'Consuming_Darkness']

	core_sorceries = ['Grow', 'Fireblast', 'Hail_Storm', 'Meteor', 'Seal_of_Wind']
	equinox_sorceries = ['Full_Moon', 'Scattered_Seeds', 'Fallen_Leaves']
	apocalypse_sorceries = ['Rushing_Waters', 'Thunder', 'Blinding_Snow']

	core_charms = ['Sprout', 'Slash', 'Surge', 'Comet', 'Seal_of_Summer']
	equinox_charms = ['Eclipse', 'Spring', 'Autumn']
	apocalypse_charms = ['Gush', 'Lightning', 'Winter']


	if starter_game:
		rituals = core_rituals[:3]
		sorceries = core_sorceries[:3]
		charms = core_charms[:3]

	if core:
		rituals = random.sample(core_rituals, 3)
		sorceries = random.sample(core_sorceries, 3)
		charms = random.sample(core_charms, 3)

	if equinox:
		rituals = random.sample(equinox_rituals, 3)
		sorceries = random.sample(equinox_sorceries, 3)
		charms = random.sample(equinox_charms, 3)

	if apocalypse:
		rituals = random.sample(apocalypse_rituals, 3)
		sorceries = random.sample(apocalypse_sorceries, 3)
		charms = random.sample(apocalypse_charms, 3)

	if all_spells:
		rituals = random.sample(core_rituals + equinox_rituals + apocalypse_rituals, 3)
		sorceries = random.sample(core_sorceries + equinox_sorceries + apocalypse_sorceries, 3)
		charms = random.sample(core_charms + equinox_charms + apocalypse_charms, 3)


	ritual1 = "spellfile." + rituals[0] + "(self, self.positions[1], '" + rituals[0] + "')"
	ritual2 = "spellfile." + rituals[1] + "(self, self.positions[2], '" + rituals[1] + "')"
	ritual3 = "spellfile." + rituals[2] + "(self, self.positions[3], '" + rituals[2] + "')"

	sorcery1 = "spellfile." + sorceries[0] + "(self, self.positions[4], '" + sorceries[0] + "')"
	sorcery2 = "spellfile." + sorceries[1] + "(self, self.positions[5], '" + sorceries[1] + "')"
	sorcery3 = "spellfile." + sorceries[2] + "(self, self.positions[6], '" + sorceries[2] + "')"

	charm1 = "spellfile." + charms[0] + "(self, self.positions[7], '" + charms[0] + "')"
	charm2 = "spellfile." + charms[1] + "(self, self.positions[8], '" + charms[1] + "')"
	charm3 = "spellfile." + charms[2] + "(self, self.positions[9], '" + charms[2] + "')"

	spell_list = [ritual1, ritual2, ritual3, sorcery1, sorcery2, sorcery3, charm1, charm2, charm3]

	return spell_list












