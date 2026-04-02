import spellgenerator
import spellfile
import json
import time








class Node():
	def __init__(self, name):
		self.name = name

		### neighbors is a list of node objects which are adjacent
		self.neighbors = []

		### stone is None when empty, 'red' or 'blue' when filled
		self.stone = None




class SPBoard():
	def __init__(self):

		self.turncounter = 0

		self.whoseturn = None

		self.gameover = False

		self.winner = None

		### nodes is a dict that takes strings (names)
		### and returns the corresponding node objects
		self.nodes = self.make_board()

		### positions is a dict with keys 1-9.  1,2,3 are rituals
		### in zones a,b,c respectively.  4,5,6 are sorceries.
		### 7,8,9 are charms.
		### Each value is a list of nodes, the ones
		### constituting that spell.
		self.positions = self.make_positions()

		### spells is a list of the 9 spell objects on the board. 0,1,2 are rituals,
		### 3,4,5 are sorceries, 6,7,8 are charms.
		self.spells = self.make_spells()

		### spelldict is a dictionary with keys = spell names
		### (strings), and values which are the spell objects themselves.
		self.spelldict = self.make_spelldict()

		### There will also be board attributes for the two players.
		### But they will get added by the board.addplayers() method,
		### which we call AFTER constructing the board and then
		### constructing the players.

		### These will be player objects after the addplayers() method
		### is called.

		### ONLY REFER TO THESE ATTRIBUTES
		### after the board setup has been finished!
		self.redplayer = None
		self.blueplayer = None

		self.humanplayer = None
		self.aiplayer = None



		### A dictionary of all the relevant facts about the board state.
		### We take a snapshot using board.take_snapshot() , and then
		### if the user throws a 'reset' exception, the board returns to
		### whatever state is saved in board.snapshot.
		self.snapshot = None

		### A string that tells which player is winning and by how much.
		self.score = 'b1'

		self.last_play = None
		self.last_player = None

		self.recorder = None

	def record(self, action_type, **kwargs):
		if self.recorder is not None:
			self.recorder.record(action_type, **kwargs)

	def start_turn_recording(self, color, turn_number):
		if self.recorder is not None:
			self.recorder.start_turn(color, turn_number)

	def end_game_recording(self):
		if self.recorder is not None:
			self.recorder.end_game(self.winner)

	def take_snapshot(self):

		### ADD ALL BOARD ATTRIBUTES TO THE SNAPSHOT

		### Sets board.snapshot to be a dictionary
		### which describes the current boardstate

		snapshot = {}
		snapshot["turncounter"] = self.turncounter
		snapshot["gameover"] = self.gameover
		snapshot["winner"] = self.winner
		snapshot["score"] = self.score
		snapshot["redspellcounter"] = self.redplayer.spellcounter
		snapshot["bluespellcounter"] = self.blueplayer.spellcounter
		for nodename in self.nodes:
			snapshot[nodename] = self.nodes[nodename].stone
		if self.redplayer.lock:
			snapshot["redlock"] = self.redplayer.lock.name
		else:
			snapshot["redlock"] = None

		if self.blueplayer.lock:
			snapshot["bluelock"] = self.blueplayer.lock.name
		else:
			snapshot["bluelock"] = None

		snapshot["last_play"] = self.last_play
		snapshot["last_player"] = self.last_player

		self.snapshot = snapshot



	def update(self, update_score = False):

		### Updates the visual board display: which stones are where,
		### and also which spells are locked.

		### Updates the status of all the spells.
		### These statuses will be stored
		### in the 'charged_spells' attributes of players.

		### Also updates the players' 'mana' and 'totalstones' attributes.

		### board.update() MUST BE CALLED WHENEVER
		### ANY STONE CHANGES POSITION!
		redtotalstones = 0
		bluetotalstones = 0
		for name in self.nodes:
			color = self.nodes[name].stone
			if color == 'red':
				redtotalstones += 1
			elif color == 'blue':
				bluetotalstones += 1
		self.redplayer.totalstones = redtotalstones
		self.blueplayer.totalstones = bluetotalstones

		redscore = redtotalstones
		bluescore = bluetotalstones + 1


		if update_score:
			### score should be a string like 'tied', 'r1', 'b2' , etc.
			if redscore == bluescore:
				self.score = 'tied'
			elif redscore > bluescore:
				scorenum = min(3, redscore - bluescore)
				self.score = 'r' + str(scorenum)
			elif bluescore > redscore:
				scorenum = min(3, bluescore - redscore)
				self.score = 'b' + str(scorenum)


		redcharged = []
		bluecharged = []
		for spell in self.spells:
			spell.update_charge()

			if spell.charged == 'red':
				redcharged.append(spell)
			elif spell.charged == 'blue':
				bluecharged.append(spell)

		self.redplayer.charged_spells = redcharged
		self.blueplayer.charged_spells = bluecharged

		redmana = 0
		bluemana = 0

		for node in [self.nodes['a1'], self.nodes['b1'], self.nodes['c1']]:
			if node.stone == 'red':
				redmana += 1
			elif node.stone == 'blue':
				bluemana += 1

		self.redplayer.mana = redmana
		self.blueplayer.mana = bluemana



		### Sends a json dictionary to the human player.
		### Tells which stones are where, and also which locks are where.

		jboard = {"type": "boardstate", }
		for name in self.nodes:
			jboard[name] = self.nodes[name].stone

		if self.redplayer.lock:
			jboard["redlock"] = self.redplayer.lock.name
		else:
			jboard["redlock"] = None
		if self.blueplayer.lock:
			jboard["bluelock"] = self.blueplayer.lock.name
		else:
			jboard["bluelock"] = None

		jboard["redspellcounter"] = self.redplayer.spellcounter

		jboard["bluespellcounter"] = self.blueplayer.spellcounter

		if update_score:
			jboard["score"] = self.score

		jboard["last_player"] = self.last_player
		jboard["last_play"] = self.last_play

		self.humanplayer.ws.send(json.dumps(jboard))


	def end_game(self):
		egress = { "type": "game_over" }
		egress["winner"] = self.winner
		self.humanplayer.ws.send(json.dumps(egress))


	def make_board(self):
		nodelist = []

		for zone in ['a', 'b', 'c']:
			for number in range(1, 14):
				x = Node(zone + str(number))
				nodelist.append(x)

		for i in range(len(nodelist)):
			node = nodelist[i]
			name = node.name

			if name[1:] == '1':
				node.neighbors.append(nodelist[i + 1])
				node.neighbors.append(nodelist[i + 10])

			elif name[1:] == '2':
				node.neighbors.append(nodelist[i + 1])
				node.neighbors.append(nodelist[i + 4])
				node.neighbors.append(nodelist[i - 1])

			elif name[1:] == '3':
				node.neighbors.append(nodelist[i + 1])
				node.neighbors.append(nodelist[i + 10])
				node.neighbors.append(nodelist[i - 1])

			elif name[1:] == '4':
				node.neighbors.append(nodelist[i + 1])
				node.neighbors.append(nodelist[i + 3])
				node.neighbors.append(nodelist[i - 1])

			elif name[1:] == '5':
				node.neighbors.append(nodelist[i + 1])
				node.neighbors.append(nodelist[i + 7])
				node.neighbors.append(nodelist[i - 1])

			elif name[1:] == '6':
				node.neighbors.append(nodelist[i + 5])
				node.neighbors.append(nodelist[i - 4])
				node.neighbors.append(nodelist[i - 1])

			elif name[1:] == '7':
				node.neighbors.append(nodelist[i + 1])
				node.neighbors.append(nodelist[i - 3])

			elif name[1:] == '8':
				node.neighbors.append(nodelist[i + 1])
				node.neighbors.append(nodelist[i + 2])
				node.neighbors.append(nodelist[i - 1])

			elif name[1:] == '9':
				node.neighbors.append(nodelist[i + 1])
				node.neighbors.append(nodelist[i + 4])
				node.neighbors.append(nodelist[i - 1])

			elif name[1:] == '10':
				node.neighbors.append(nodelist[i - 2])
				node.neighbors.append(nodelist[i - 1])

			elif name[1:] == '11':
				node.neighbors.append(nodelist[i - 10])
				node.neighbors.append(nodelist[i - 5])

			elif name[1:] == '12':
				node.neighbors.append(nodelist[i - 7])

			elif name[1:] == '13':
				node.neighbors.append(nodelist[i - 10])
				node.neighbors.append(nodelist[i - 4])

		interzone_edges = []
		interzone_edges.append((nodelist[10], nodelist[35]))
		interzone_edges.append((nodelist[11], nodelist[32]))
		interzone_edges.append((nodelist[6], nodelist[24]))
		interzone_edges.append((nodelist[9], nodelist[23]))
		interzone_edges.append((nodelist[19], nodelist[37]))
		interzone_edges.append((nodelist[22], nodelist[36]))

		for x in interzone_edges:
			left = x[0]
			right = x[1]
			left.neighbors.append(right)
			right.neighbors.append(left)

		nodedict = {}
		for node in nodelist:
			nodedict[node.name] = node

		return nodedict

	def make_positions(self):
		### Returns a dictionary d with with keys 1-9 and values = the 9
		### positions.  1,2,3 are rituals
		### in zones a,b,c respectively.  4,5,6 are sorceries.
		### 7,8,9 are charms.
		### Each of these position values is a list of nodes, the ones
		### constituting that spell.

		n = self.nodes
		d = {}
		d[1] = [n['a2'], n['a3'], n['a4'], n['a5'], n['a6']]
		d[2] = [n['b2'], n['b3'], n['b4'], n['b5'], n['b6']]
		d[3] = [n['c2'], n['c3'], n['c4'], n['c5'], n['c6']]
		d[4] = [n['a8'], n['a9'], n['a10']]
		d[5] = [n['b8'], n['b9'], n['b10']]
		d[6] = [n['c8'], n['c9'], n['c10']]
		d[7] = [n['a7']]
		d[8] = [n['b7']]
		d[9] = [n['c7']]

		return d

	def make_spells(self):
		### returns the list of spell objects that will be on the board

		### spellnames is just a list of strings which are the names
		### of the spells to be instantiated, in order of their
		### position, 1-9.
		spellnames = spellgenerator.generate_spell_list()

		### Convert this spellnames list into a list of spell objects
		### and return that in-order list of spell objects

		spells = []

		for x in spellnames:
			nextspell = eval(x)
			spells.append(nextspell)

		for charm in spells[6:]:
			charm.ischarm = True

		return spells

	def make_spelldict(self):
		### Returns a dictionary which takes in names of spells
		### and returns the spell objects.

		d = {}
		for spell in self.spells:
			d[spell.name] = spell

		return d

	def set_spells_from_names(self, spell_names):
		"""Rebuild the spell objects from a list of 9 spell name strings.

		Used when loading a saved game to restore the exact spell configuration.
		"""
		spells = []
		for i, name in enumerate(spell_names):
			pos_idx = i + 1
			spell_obj = eval("spellfile." + name + "(self, self.positions[" + str(pos_idx) + "], '" + name + "')")
			spells.append(spell_obj)
		for charm in spells[6:]:
			charm.ischarm = True
		self.spells = spells
		self.spelldict = self.make_spelldict()

	def addplayers(self, human, ai):
		### Call this method AFTER building the board and the players.
		### This is my hack-y way of giving players the board as parameter,
		### and also giving the board players as parameters.

		self.humanplayer = human
		self.aiplayer = ai

		if human.color == 'red':
			self.redplayer = human
			self.blueplayer = ai
		else:
			self.redplayer = ai
			self.blueplayer = human


class AIPlayer():
	### Just like a humanplayer, but with no websocket.
	def __init__(self, board, color):
		self.ishuman = False
		self.board = board
		self.color = color
		if self.color == 'red':
			self.enemy = 'blue'
		else:
			self.enemy = 'red'

		### totalstones does NOT include the extra blue stone in the center.
		self.totalstones = 0

		### charged_spells is a list of which spell objects
		### are currently charged for this player.
		### Gets updated whenever board.update() is called.
		self.charged_spells = []

		###  The number of mana this player controls.
		### Gets updated by board.update()
		self.mana = 0



		### player.lock is the spell object which is locked.
		### To get its name we need player.lock.name
		self.lock = None

		### player.springlock is the spell object which is springlocked.
		self.springlock = None

		### The spell counter for this player. The EOT trigger checks in
		### player.taketurn will check if player.spellcounter >= 6,
		### and if so, end the game appropriately.
		self.spellcounter = 0

		### player.opp will be the opponent player object.
		self.opp = None

		if self.color == 'red':
			self.priority_order = ['b1','c1','a1',
			'b10','b8','b9', 'b2','b3','b4','b6','b5','b7',
			'c10','c8','c9', 'c2','c3','c4','c6','c5','c7',
			'a10','a8','a9', 'a2','a3','a4','a6','a5','a7',
			'b11','b12','b13','c11','c12','c13','a11','a12','a13']

			self.bewitch_priority_order = [
			'b10','b8','b9','b7','b4','b3','b2','b5','b6','b1',
			'c10','c8','c9','c7','c4','c3','c2','c5','c6','c1',
			'a10','a8','a9','a7','a4','a3','a2','a5','a6','a1',
			'b11','b12','b13','c11','c12','c13','a11','a12','a13']

		else:
			self.priority_order = ['a1','c1','b1',
			'a10','a8','a9', 'a2','a3','a4','a6','a5','a7',
			'c10','c8','c9', 'c2','c3','c4','c6','c5','c7',
			'b10','b8','b9', 'b2','b3','b4','b6','b5','b7',
			'a11','a12','a13','c11','c12','c13','b11','b12','b13']

			self.bewitch_priority_order = [
			'a10','a8','a9','a7','a4','a3','a2','a5','a6','a1',
			'c10','c8','c9','c7','c4','c3','c2','c5','c6','c1',
			'b10','b8','b9','b7','b4','b3','b2','b5','b6','b1',
			'a11','a12','a13','c11','c12','c13','b11','b12','b13']





	def _stone_advantage(self):
		"""How many stones ahead we are in scoring (negative = behind).
		Blue has +1 phantom stone."""
		if self.color == 'red':
			return self.totalstones - (self.opp.totalstones + 1)
		else:
			return (self.totalstones + 1) - self.opp.totalstones

	def _score_move_target(self, node):
		"""Score a potential move target node. Higher = better."""
		score = 0
		name = node.name

		# Mana nodes are very valuable -- contest them
		if name in ('a1', 'b1', 'c1'):
			score += 10

		# Prefer soft moves (place on empty) over hard moves (push enemy)
		if node.stone is None:
			score += 3
		else:
			# Hard move is riskier but useful if pushing off a key node
			if name in ('a1', 'b1', 'c1'):
				score += 5
			else:
				score += 1

		# Spell charging: prefer nodes that help complete a spell charge
		for spell in self.board.spells:
			if spell.static:
				continue
			if node in spell.position:
				own_count = sum(1 for n in spell.position if n.stone == self.color)
				total = len(spell.position)
				if own_count == total - 1:
					score += 6
				elif own_count >= total - 2:
					score += 3
				elif own_count >= 1:
					score += 1

		# Connectivity: prefer moves adjacent to own stones (build groups)
		own_neighbors = sum(1 for n in node.neighbors if n.stone == self.color)
		score += own_neighbors

		# Surrounding: bonus for moves adjacent to enemy stones
		enemy_neighbors = sum(1 for n in node.neighbors if n.stone == self.enemy)
		score += enemy_neighbors * 0.5

		# Avoid placing into our own locked spell position
		if self.lock and node in self.lock.position:
			score -= 4

		return score

	def _evaluate_spell(self, spell_name):
		"""Score how valuable it is to cast this spell now. Positive = worth casting."""
		spell = self.board.spelldict[spell_name]

		# For non-charm spells, consider the stone cost of casting
		if not spell.ischarm:
			stones_in_position = sum(1 for n in spell.position if n.stone == self.color)
			refills = self.mana
			net_cost = stones_in_position - refills
			# Don't cast if we'd lose too many stones while behind or at parity
			if net_cost > 1 and self._stone_advantage() < 2:
				return -1

		if spell_name == 'Carnage':
			targets = len(self.allhardmoveablenodes(spell.position))
			if targets >= 2:
				return 8
			elif targets >= 1:
				return 4
			return -1

		elif spell_name == 'Starfall':
			return 7 if self.starfalltargetexists() else -1

		elif spell_name == 'Bewitch':
			return 6 if self.bewitchtargetexists() else -1

		elif spell_name == 'Flourish':
			return 5

		elif spell_name == 'Fireblast':
			targets = len(self.allhardmoveablenodes(spell.position))
			return 5 if targets >= 2 else -1

		elif spell_name == 'Hail_Storm':
			count = self.hailablespellcount()
			return count * 2 if count >= 2 else -1

		elif spell_name == 'Meteor':
			return 4

		elif spell_name == 'Grow':
			return 3

		elif spell_name == 'Comet':
			return 3 if self.comettargetexists() else -1

		elif spell_name == 'Surge':
			return 2

		elif spell_name == 'Slash':
			targets = len(self.allhardmoveablenodes(spell.position))
			return 2 if targets >= 1 else -1

		elif spell_name == 'Sprout':
			return 2

		else:
			return 1

	def taketurn(self, canmove=True, candash=True, canspell=True, cansummer=True):
		self.board.update()

		### One second delay between actions, for more realistic-feeling AI
		time.sleep(1)


		actions = []
		spelllist = []

		if canmove:
			actions.append('move')
		else:
			# Dash: only consider when strategically worthwhile
			if candash and canspell and self.totalstones > 2:
				if 'Autumn' not in [s.name for s in self.opp.charged_spells]:
					has_lightning = 'Seal_of_Lightning' in [s.name for s in self.charged_spells]
					# With Lightning (costs 1 stone): dash if we're ahead by 2+ stones
					# Without Lightning (costs 2 stones): dash only if ahead by 3+ stones
					if has_lightning and self._stone_advantage() >= 2:
						actions.append('dash')
					elif not has_lightning and self._stone_advantage() >= 3 and self.totalstones > 4:
						actions.append('dash')

			summer_active = False
			if ('Seal_of_Summer' in [s.name for s in self.charged_spells]) and cansummer:
				summer_active = True

			if (canspell) or (not canspell and summer_active):
				self.board.update()
				for spell in self.charged_spells:

					if not spell.static:
						if spell.ischarm:
							if 'Winter' not in [s.name for s in self.opp.charged_spells]:
								if spell.name == 'Surge':
									if not candash:
										actions.append(spell.name)
										spelllist.append(spell.name)
								else:
									actions.append(spell.name)
									spelllist.append(spell.name)

						else:
							if self.lock == spell and ('Spring' in [s.name for s in self.charged_spells]) and self.springlock != spell:
								actions.append(spell.name)
								spelllist.append(spell.name)
							if self.lock != spell:
								actions.append(spell.name)
								spelllist.append(spell.name)
			actions.append('pass')


		### Select 1 action from the actions list.

		if 'move' in actions:
			action = 'move'
		else:
			# Evaluate each possible action and pick the best one
			best_action = 'pass'
			best_score = 0

			for act in actions:
				if act == 'pass':
					continue
				elif act == 'dash':
					# Dash is moderately valuable when allowed
					score = 3
				else:
					# It's a spell -- evaluate it
					score = self._evaluate_spell(act)

				if score > best_score:
					best_score = score
					best_action = act

			action = best_action


		if action == 'move':
			self.move(standardmove=True)
			self.taketurn(False, candash, canspell, cansummer)
			return None

		elif action == 'dash':
			if ('Seal_of_Lightning' in [s.name for s in self.charged_spells]):
				self.dash(True)
				self.taketurn(canmove, False, canspell, cansummer)
				return None
			else:
				self.dash()
				self.taketurn(canmove, False, canspell, cansummer)
				return None

		elif action in spelllist:
			self.board.record('cast', spell=action)
			self.board.spelldict[action].cast(self)
			if canspell:
				self.taketurn(False, candash, False, cansummer)
				return None
			else:
				self.taketurn(False, candash, False, False)
				return None


		elif action == 'pass':
			return None

	def bot_triggers(self):
		### Put any spell-specific beginning-of-turn triggers here,
		### like Inferno, which should set the global
		### variables gameover = True and winner = self.enemy

		if 'Inferno' in [spell.name for spell in self.charged_spells]:
			self.board.humanplayer.jmessage("DEATH BY INFERNO!")
			self.board.gameover = True
			self.board.winner = self.enemy


	def eot_triggers(self):
		### Put code in here for every specific spell
		### that causes end-of-turn triggers.
		### It must come BEFORE the end-game code below!

		### Check whether someone is up by 3 or more.

		### Check whether the spellcounter >= 6.


		### INSERT SPELL-SPECIFIC EOT EFFECTS HERE


		if 'Inferno' in [spell.name for spell in self.charged_spells]:
			self.board.humanplayer.jmessage("INFERNO TRIGGER!")
			for name in board.nodes:
				node = board.nodes[name]
				if node.stone == self.enemy:
					for neighbor in node.neighbors:
						if neighbor.stone == self.color:
							node.stone = None
							if (self.board.last_play == node.name):
								self.board.last_play = None
								self.board.last_player = None
			board.update()

		### END OF SPELL-SPECIFIC EOT EFFECTS

		redtotal = 0
		bluetotal = 1

		for name in self.board.nodes:
			color = self.board.nodes[name].stone
			if color == 'red':
				redtotal += 1
			elif color == 'blue':
				bluetotal += 1

		if redtotal > bluetotal + 2:
			self.board.gameover = True
			self.board.winner = 'red'

		elif bluetotal > redtotal + 2:
			self.board.gameover = True
			self.board.winner = 'blue'

		else:
			if self.spellcounter >= 6:
				self.board.gameover = True
				if redtotal > bluetotal:
					self.board.winner = 'red'
				elif bluetotal > redtotal:
					self.board.winner = 'blue'
				else:
					a = ['red', 'blue']
					a.remove(self.board.whoseturn)
					self.board.winner = a[0]

		self.board.update()

	def allmoveablenodes(self):
		answer = []
		for name in self.priority_order:
			node = self.board.nodes[name]
			if node.stone != self.color:
				adjacent = False
				for neighbor in node.neighbors:
					if neighbor.stone == self.color:
						adjacent = True
				if adjacent:
					answer.append(node)
		return answer


	def allsoftmoveablenodes(self):
		answer = []
		for name in self.priority_order:
			node = self.board.nodes[name]
			if node.stone == None:
				adjacent = False
				for neighbor in node.neighbors:
					if neighbor.stone == self.color:
						adjacent = True
				if adjacent:
					answer.append(node)
		return answer


	def allhardmoveablenodes(self,hardmove_spell_nodes=[]):
		answer = []
		for name in self.priority_order:
			node = self.board.nodes[name]
			if node.stone == self.enemy:
				adjacent = False
				for neighbor in node.neighbors:
					if not (neighbor in hardmove_spell_nodes):
						if neighbor.stone == self.color:
							adjacent = True
				if adjacent:
					answer.append(node)
		return answer


	def allblinkablenodes(self):
		answer = []
		for name in self.priority_order:
			node = self.board.nodes[name]
			if node.stone != self.color:
				answer.append(node)
		return answer

	def hailablespellcount(self):
		hailablespellcount = 0

		for i in range(1,7):
			innernodelist = self.board.positions[i]
			for node in innernodelist:
				if node.stone == self.enemy:
					hailablespellcount += 1
					break
		return hailablespellcount

	def bewitchtargetexists(self):
		target_exists = False
		for name in self.priority_order:
			node = self.board.nodes[name]
			if node.stone == self.enemy:
				for neighbor in node.neighbors:
					if neighbor.stone == self.enemy:
							target_exists = True
		return target_exists

	def comettargetexists(self):
		for node in [self.board.nodes['a1'], self.board.nodes['b1'], self.board.nodes['c1']]:
			already_touching = False
			adjacent_enemy_count = 0
			if node.stone == self.color:
				already_touching = True
			else:
				if node.stone == self.enemy:
					adjacent_enemy_count += 1
				for neighbor in node.neighbors:
					if neighbor.stone == self.color:
						already_touching = True
					elif neighbor.stone == self.enemy:
						adjacent_enemy_count += 1
			if (not already_touching) and (adjacent_enemy_count < 2):
				return True
		return False

	def starfalltargetexists(self):
		for name in self.priority_order:
			node = self.board.nodes[name]
			if node.stone == None:
				adjacent_to_empty = False
				adjacent_enemy_count = 0
				for neighbor in node.neighbors:
					if neighbor.stone == None:
						adjacent_to_empty = True
					elif neighbor.stone == self.enemy:
						adjacent_enemy_count += 1
				if adjacent_to_empty and adjacent_enemy_count > 1:
					return True
		return False



	def move(self, standardmove = False):
		### standardmove is True iff this is the player's standard move for the turn.

		time.sleep(1)

		if standardmove and 'Seal_of_Wind' in [s.name for s in self.charged_spells]:
			legalmoves = self.allblinkablenodes()
			# Score blink targets and pick the best one
			best_node = None
			best_score = -999
			for node in legalmoves:
				adjacent_nonenemy_count = 0
				if node.stone == None:
					adjacent_nonenemy_count += 1
				for neighbor in node.neighbors:
					if neighbor.stone != self.enemy:
						adjacent_nonenemy_count += 1
				if adjacent_nonenemy_count > 1:
					score = self._score_move_target(node)
					if score > best_score:
						best_score = score
						best_node = node

			if best_node is not None:
				if best_node.stone == self.enemy:
					self.board.record('blink', node=best_node.name)
					self.pushenemy(best_node)
					return
				else:
					best_node.stone = self.color
					self.board.record('blink', node=best_node.name)
					egress =  {"type": "new_stone_animation", "color": self.color, "node": best_node.name}
					self.opp.ws.send(json.dumps(egress))
					self.board.update()
					return
			# Fall through to normal move if no good blink target


		legalmoves = self.allmoveablenodes()
		if len(legalmoves) == 0:
			return

		# Score each legal move and pick the best
		best_node = None
		best_score = -999
		for node in legalmoves:
			score = self._score_move_target(node)
			if score > best_score:
				best_score = score
				best_node = node

		if best_node is None:
			best_node = legalmoves[0]

		node = best_node
		nodename = node.name
		if node.stone == None:
			node.stone = self.color
			self.board.record('move', node=nodename)

			egress =  {"type": "new_stone_animation", "color": self.color, "node": node.name}
			self.opp.ws.send(json.dumps(egress))

			self.board.last_play = nodename
			self.board.last_player = self.color
			self.board.update()
		else:
			self.board.record('hard_move', node=nodename, pushed_to='pending')
			self.pushenemy(node)



	def softmove(self, dumb_move_nodes):

		legalmoves = self.allsoftmoveablenodes()
		if len(legalmoves) == 0:
			return

		time.sleep(1)

		### Score each legal soft move, avoiding dumb_move_nodes
		if self.lock:
			dumb_move_nodes += self.lock.position

		best_node = None
		best_score = -999
		for node in legalmoves:
			score = self._score_move_target(node)
			if node in dumb_move_nodes:
				score -= 8
			if score > best_score:
				best_score = score
				best_node = node

		if best_node is None:
			best_node = legalmoves[0]

		node = best_node
		nodename = node.name
		node.stone = self.color
		self.board.record('move', node=nodename)

		egress =  {"type": "new_stone_animation", "color": self.color, "node": node.name}
		self.opp.ws.send(json.dumps(egress))

		self.board.last_play = nodename
		self.board.last_player = self.color
		self.board.update()


	def hardmove(self):

		legalmoves = self.allhardmoveablenodes()
		if len(legalmoves) == 0:
			return

		time.sleep(1)

		### Score each target and pick the best one to push
		best_node = None
		best_score = -999
		for node in legalmoves:
			score = self._score_move_target(node)
			if score > best_score:
				best_score = score
				best_node = node

		if best_node is None:
			best_node = legalmoves[0]

		node = best_node
		nodename = node.name
		self.board.record('hard_move', node=nodename, pushed_to='pending')
		self.pushenemy(node)


	def dash(self, seal_of_lightning=False):
		self.opp.jmessage("Opponent dashes!")
		time.sleep(1)
		sacrificed = []
		if seal_of_lightning:
			for name in reversed(self.priority_order):
				node = self.board.nodes[name]
				if node.stone == self.color:
					sacrificed.append(name)
					node.stone = None
					if self.board.last_play == name:
						self.board.last_play = None
						self.board.last_player = None
					self.board.update()
					time.sleep(1)
					break
			self.board.record('dash_lightning', sacrificed=sacrificed, dest='pending')
		else:
			# Sacrifice 2 stones (least valuable first)
			count = 0
			for name in reversed(self.priority_order):
				if count >= 2:
					break
				node = self.board.nodes[name]
				if node.stone == self.color:
					sacrificed.append(name)
					node.stone = None
					if self.board.last_play == name:
						self.board.last_play = None
						self.board.last_player = None
					count += 1
					self.board.update()
					time.sleep(1)
			self.board.record('dash', sacrificed=sacrificed, dest='pending')
		self.move()



	def pushenemy(self, node):
		node.stone = self.color

		egress =  {"type": "new_stone_animation", "color": self.color, "node": node.name}
		self.opp.ws.send(json.dumps(egress))

		self.board.last_play = node.name
		self.board.last_player = self.color
		self.board.update()
		### push the enemy stone. Return a list of options
		### for where to push it.
		pushingqueue = [(x, 1) for x in node.neighbors]
		pushingoptions = []
		alreadyvisited = [node]
		### This loop searches for a first valid pushing option
		while pushingoptions == []:
			if pushingqueue == []:
				### enemy stone crushed
				egress =  {"type": "crush_animation", "crushed_color": self.enemy, "node": node.name}

				self.opp.ws.send(json.dumps(egress))

				self.board.update()
				return None
			nextpair = pushingqueue.pop(0)
			nextnode, distance = nextpair
			alreadyvisited.append(nextnode)
			if nextnode.stone == self.color:
				continue
			elif nextnode.stone == self.enemy:
				for neighbor in nextnode.neighbors:
					if neighbor not in alreadyvisited:
						pushingqueue.append((neighbor, distance + 1))
				continue
			else:
				pushingoptions.append(nextnode)
				shortestdistance = distance

		### This loop finishes finding the other pushing options
		### at the same distance, and breaks when distance gets bigger
		while pushingqueue != []:
			nextpair = pushingqueue.pop(0)
			nextnode, distance = nextpair
			if distance > shortestdistance:
				break
			if nextnode.stone == None:
				pushingoptions.append(nextnode)

		pushingoptionnames = [x.name for x in pushingoptions]

		if len(pushingoptionnames) == 1:
			push = pushingoptionnames[0]
			self.board.nodes[push].stone = self.enemy
			egress =  {"type": "push_animation", "pushed_color": self.enemy, "starting_node": node.name, "ending_node": push}

			self.opp.ws.send(json.dumps(egress))

			self.board.update()
			return None

		else:
			### Choose to push to the first spot in the list
			push = pushingoptionnames[0]
			self.board.nodes[push].stone = self.enemy
			egress =  {"type": "push_animation", "pushed_color": self.enemy, "starting_node": node.name, "ending_node": push}

			self.opp.ws.send(json.dumps(egress))

			self.board.update()
			return None
