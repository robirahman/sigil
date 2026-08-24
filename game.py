import spellgenerator
import spellfile
import json
import time







class resetException(Exception):
	pass

class redwinsException(Exception):
	pass

class bluewinsException(Exception):
	pass



class Node():
	def __init__(self, name):
		self.name = name

		### neighbors is a list of node objects which are adjacent
		self.neighbors = []

		### stone is None when empty, 'red' or 'blue' when filled
		self.stone = None




class Board():
	def __init__(self):

		self.ladder_match = False

		self.elo_recorded = False

		self.turncounter = 0

		self.whoseturn = None

		self.gameover = False

		self.winner = None

		### Game variant: 'standard' or 'competitive'.
		### See SimBoard.VARIANTS for the rules of each. Set by the
		### game-start code in app.py before calling setup_initial().
		self.variant = 'standard'

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



		### A dictionary of all the relevant facts about the board state.
		### We take a snapshot using board.take_snapshot() , and then
		### if the user throws a 'reset' exception, the board returns to
		### whatever state is saved in board.snapshot.
		self.snapshot = None

		### A dictionary which stores counts of how many times each boardstate has occurred.
		### Keys are entire boardstate snapshots ('looping_snapshots') encoded as strings.
		self.all_looping_snapshot_counts = {}

		### A string that tells which player is winning and by how much.
		self.score = 'b1'

		self.last_play = None
		self.last_player = None

		### Providence: pending_moves[color][i] = extra moves granted at the
		### start of that player's i-th upcoming turn. The two counters are
		### turn-scoped: taketurn shifts the schedule head into them at the
		### start of each turn and eot_triggers zeroes them. They never
		### serialize (all SFN writes happen at turn boundaries). First move
		### of the turn <=> moves_left == moves_granted.
		self.pending_moves = {'red': [], 'blue': []}
		self.moves_left_this_turn = 0
		self.moves_granted_this_turn = 0

		### Aftershock: scheduled burns (destroy 1 adjacent enemy stone at
		### the start of each affected turn). No live counter — the prompt
		### loop in taketurn resolves them inline.
		self.pending_burns = {'red': [], 'blue': []}

		### Ambush: snare markers {node: owner}. Consumed ONLY by an
		### enemy-of-owner stone resting on the node (resolved in update())
		### or a Fissure blast; count fully toward the owner's stone total
		### (2026-08 buff).
		self.snares = {}

		self.recorder = None

	def pending_stones(self, color):
		### Phantom stones for `color`: Providence scheduled extras plus,
		### for the side to move, extras granted this turn but not yet
		### placed (before any move this turn, one remaining move is the
		### ordinary turn move — never a phantom; after that, every
		### remaining move is an extra — hence min(left, granted - 1)),
		### plus Ambush snares and pending Aftershock burns owned by
		### `color` (both count fully toward the owner's stone total,
		### 2026-08 buff).
		p = sum(self.pending_moves[color])
		if self.whoseturn == color:
			p += max(0, min(self.moves_left_this_turn,
			                self.moves_granted_this_turn - 1))
		p += sum(1 for owner in self.snares.values() if owner == color)
		p += sum(self.pending_burns[color])
		return p

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

		snapshot["red_pending"] = list(self.pending_moves['red'])
		snapshot["blue_pending"] = list(self.pending_moves['blue'])
		snapshot["red_burns"] = list(self.pending_burns['red'])
		snapshot["blue_burns"] = list(self.pending_burns['blue'])
		snapshot["snares"] = dict(self.snares)

		self.snapshot = snapshot


		### Also take a looping_snapshot, which has only the information needed to check if the game is going in a loop,
		### encoded as a string

		looping_snapshot = ""

		looping_snapshot += str(self.redplayer.spellcounter)
		looping_snapshot += str(self.blueplayer.spellcounter)
		for nodename in self.nodes:
			looping_snapshot += str(self.nodes[nodename].stone)
		if self.redplayer.lock:
			looping_snapshot += self.redplayer.lock.name
		else:
			looping_snapshot += "None"
		if self.blueplayer.lock:
			looping_snapshot += self.blueplayer.lock.name
		else:
			looping_snapshot += "None"

		### Providence: positions with different pending schedules are NOT
		### the same position. Suffix only when non-empty so legacy keys
		### stay byte-identical. Canonical form is the PRE-SHIFT schedule
		### (take_snapshot runs at turn start, before the shift); SimBoard's
		### looping_snapshot re-prepends its popped extras counter to the
		### mover's list to produce the same canonical key.
		if self.pending_moves['red'] or self.pending_moves['blue']:
			looping_snapshot += ('|P' + ','.join(map(str, self.pending_moves['red']))
			                     + '/' + ','.join(map(str, self.pending_moves['blue'])))
		if self.pending_burns['red'] or self.pending_burns['blue']:
			looping_snapshot += ('|B' + ','.join(map(str, self.pending_burns['red']))
			                     + '/' + ','.join(map(str, self.pending_burns['blue'])))
		if self.snares:
			looping_snapshot += '|S' + ','.join(
				"{}:{}".format(n, self.snares[n][0])
				for n in sorted(self.snares))


		if looping_snapshot in self.all_looping_snapshot_counts:
			self.all_looping_snapshot_counts[looping_snapshot] += 1
			if self.all_looping_snapshot_counts[looping_snapshot] == 3:
				self.redplayer.jmessage("The game is going in a loop. If this board state repeats 2 more times, Blue will automatically win.")
				self.blueplayer.jmessage("The game is going in a loop. If this board state repeats 2 more times, Blue will automatically win.")
			elif self.all_looping_snapshot_counts[looping_snapshot] == 4:
				self.redplayer.jmessage("The game is going in a loop. If this board state repeats 1 more time, Blue will automatically win.")
				self.blueplayer.jmessage("The game is going in a loop. If this board state repeats 1 more time, Blue will automatically win.")
			elif self.all_looping_snapshot_counts[looping_snapshot] == 5:
				self.gameover = True
				self.winner = "blue"
				self.end_game()
		else:
			self.all_looping_snapshot_counts[looping_snapshot] = 1



	def update(self, update_score = False):

		### Updates the visual board display: which stones are where,
		### and also which spells are locked.

		### Updates the status of all the spells.
		### These statuses will be stored
		### in the 'charged_spells' attributes of players.

		### Also updates the players' 'mana' and 'totalstones' attributes.

		### board.update() MUST BE CALLED WHENEVER
		### ANY STONE CHANGES POSITION!

		### Ambush: a snare consumes exactly the enemy-of-owner stone that
		### comes to rest on it (stone destroyed, snare spent). The owner's
		### own stones — and walls — coexist with the snare; nothing else
		### ever removes it. Resolved here, the universal choke point,
		### BEFORE the stone totals so elimination sees the kill.
		if self.snares:
			for name in list(self.snares):
				stone = self.nodes[name].stone
				if stone is None or stone == 'X':
					continue
				if stone != self.snares[name]:
					self.nodes[name].stone = None
					del self.snares[name]
					if self.last_play == name:
						self.last_play = None
						self.last_player = None

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

		### Immediate-loss (latest-edition rules): a player with zero
		### stones on playable nodes loses right away. Blue's +1 phantom
		### counter token doesn't save them — only on-board stones count.
		### The game loop checks board.gameover between phases and ends
		### the game; spell resolvers check it to skip remaining steps.
		if not self.gameover:
			if redtotalstones == 0 and bluetotalstones == 0:
				self.gameover = True
				self.winner = 'blue' if self.whoseturn == 'red' else 'red'
			elif redtotalstones == 0:
				self.gameover = True
				self.winner = 'blue'
			elif bluetotalstones == 0:
				self.gameover = True
				self.winner = 'red'

		### Providence pending stones display in the score for both sides.
		redscore = redtotalstones + self.pending_stones('red')
		bluescore = bluetotalstones + 1 + self.pending_stones('blue')


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



		### Sends a json dictionary to the players.
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

		jboard["snares"] = dict(self.snares)

		self.redplayer.ws.send(json.dumps(jboard))
		self.blueplayer.ws.send(json.dumps(jboard))


	def end_game(self):

		egress = { "type": "game_over" }
		egress["winner"] = self.winner
		self.redplayer.ws.send(json.dumps(egress))
		self.blueplayer.ws.send(json.dumps(egress))

		if self.ladder_match:
			if self.winner == 'red':
				raise redwinsException()
			elif self.winner == 'blue':
				raise bluewinsException()


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
		"""Rebuild the spell objects from a list of 9 spell name strings."""
		spells = []
		for i, name in enumerate(spell_names):
			pos_idx = i + 1
			spell_obj = eval("spellfile." + name + "(self, self.positions[" + str(pos_idx) + "], '" + name + "')")
			spells.append(spell_obj)
		for charm in spells[6:]:
			charm.ischarm = True
		self.spells = spells
		self.spelldict = self.make_spelldict()

	def addplayers(self, redplayer, blueplayer):
		### Call this method AFTER building the board and the players.
		### This is my hack-y way of giving players the board as parameter,
		### and also giving the board players as parameters.

		self.redplayer = redplayer
		self.blueplayer = blueplayer


class Player():
	### color parameter should be 'red' or 'blue'
	def __init__(self, board, color):
		self.ishuman = True
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

		### The player.ws attribute will be where we store
		### the object which is the ws connection to each player.
		self.ws = None

		### Username is only set in ladder matches.
		self.username = None

		### Countdown timer (measured in seconds).
		self.timer = 900

		### The timer ticks down only while this is true.
		self.timer_running = False



	def jmessage(self, message, awaiting= None):
		egress =  {"type": "message", "message": message, "awaiting": awaiting, }
		self.ws.send(json.dumps(egress))


	def receivemessage(self):
		ingress = self.ws.receive()
		if json.loads(ingress)['message'] == 'reset':
			raise resetException()

		actualmessage = json.loads(ingress)['message']
		return actualmessage


	def violates_bulwark(self, node_name):
		node = self.board.nodes[node_name]
		if node.stone != self.enemy:
			return False
		if 'Bulwark' not in [s.name for s in self.opp.charged_spells]:
			return False
		if not self.opp.lock:
			return False
		lock_nodes = [n.name for n in self.opp.lock.position]
		return node_name in lock_nodes

	def allmoveablenodes(self):
		answer = {}
		for nodename in self.board.nodes:
			if self.violates_bulwark(nodename):
				continue
			node = self.board.nodes[nodename]
			if node.stone == 'X':
				continue  # permanently destroyed node (wall) — impassable
			if node.stone != self.color:
				adjacent = False
				for neighbor in node.neighbors:
					if neighbor.stone == self.color:
						adjacent = True
				if adjacent:
					answer[nodename] = self.color
		return answer

	def allsoftmoveablenodes(self):
		answer = {}
		for nodename in self.board.nodes:
			node = self.board.nodes[nodename]
			if node.stone == None:
				adjacent = False
				for neighbor in node.neighbors:
					if neighbor.stone == self.color:
						adjacent = True
				if adjacent:
					answer[nodename] = self.color
		return answer

	def allhardmoveablenodes(self):
		answer = {}
		for nodename in self.board.nodes:
			if self.violates_bulwark(nodename):
				continue
			node = self.board.nodes[nodename]
			if node.stone == self.enemy:
				adjacent = False
				for neighbor in node.neighbors:
					if neighbor.stone == self.color:
						adjacent = True
				if adjacent:
					answer[nodename] = self.color
		return answer


	def allblinkablenodes(self):
		answer = {}
		for nodename in self.board.nodes:
			if self.violates_bulwark(nodename):
				continue
			if self.board.nodes[nodename].stone == 'X':
				continue  # permanently destroyed node (wall) — impassable
			if self.board.nodes[nodename].stone != self.color:
				answer[nodename] = self.color
		return answer



	def taketurn(self, canmove=True, candash=True, canspell=True, cansummer=True):
		self.board.update()

		if self.opp.ishuman:
			self.opp.timer_running = False
			self.timer_running = True

		### Providence: at the turn-initial call, shift the schedule head
		### into the turn-scoped move counters and turn `canmove` into an
		### integer countdown of remaining moves. Recursions and retries
		### pass ints, so `canmove is True` fires exactly once per turn.
		if canmove is True:
			extra = 0
			sched = self.board.pending_moves[self.color]
			if sched:
				extra = sched.pop(0)
			self.board.moves_left_this_turn = 1 + extra
			self.board.moves_granted_this_turn = 1 + extra
			canmove = 1 + extra
			if extra > 0:
				plural = '' if extra == 1 else 's'
				self.jmessage("You get {} extra move{} this turn (Providence).".format(extra, plural))
				if self.opp.ishuman:
					self.opp.jmessage("{} gets {} extra move{} this turn (Providence).".format(
						self.color.capitalize(), extra, plural))

			### Aftershock: resolve scheduled burns before the move phase
			### (SOT order: Destruction [bot_triggers] -> Providence shift
			### -> burns -> moves). Out-of-contact burns are SAVED, not
			### lost (2026-08 buff): the leftover banks back into the head
			### of the schedule and matures again next turn. Once the
			### eligible set runs dry it stays dry within the turn. Burns
			### ignore Bulwark.
			burns = 0
			bsched = self.board.pending_burns[self.color]
			if bsched:
				burns = bsched.pop(0)
			for i in range(burns):
				moveoptions = {}
				for nodename in self.board.nodes:
					node = self.board.nodes[nodename]
					if node.stone == self.enemy and any(
							nb.stone == self.color for nb in node.neighbors):
						moveoptions[nodename] = self.enemy
				if not moveoptions:
					left = burns - i
					if bsched:
						bsched[0] += left
					else:
						bsched.append(left)
					self.jmessage(("Your burn is saved for later" if left == 1
					               else "Your {} remaining burns are saved for later".format(left))
					              + ": no enemy stone touches your stones (Aftershock).")
					self.board.update()
					break
				label = "Burn {} of {}: ".format(i + 1, burns) if burns > 1 else ""
				egress = {"type": "message",
				          "message": label + "Choose an enemy stone touching your stones to destroy (Aftershock).",
				          "awaiting": "node", "moveoptions": moveoptions}
				self.ws.send(json.dumps(egress))
				while True:
					resp = self.receivemessage()
					if resp in moveoptions:
						break
				self.board.nodes[resp].stone = None
				if self.board.last_play == resp:
					self.board.last_play = None
					self.board.last_player = None
				self.board.record('burn', node=resp)
				crush = {"type": "crush_animation", "crushed_color": self.enemy, "node": resp}
				self.ws.send(json.dumps(crush))
				if self.opp.ishuman:
					self.opp.ws.send(json.dumps(crush))
				self.board.update()
				if self.board.gameover:
					return None

		### Competitive variant opening: when this player has zero stones
		### and the variant is 'competitive', their entire turn is a single
		### free blink onto any empty node. No dash, no cast.
		if (canmove and self.board.variant == 'competitive'
				and self.totalstones == 0):
			moveoptions = {}
			for nodename in self.board.nodes:
				if self.board.nodes[nodename].stone is None:
					moveoptions[nodename] = self.color
			self.jmessage("Place your first stone (Competitive opening).")
			egress = {"type": "message", "message": "Place your first stone.",
			          "awaiting": "node", "moveoptions": moveoptions}
			self.ws.send(json.dumps(egress))
			while True:
				resp = self.receivemessage()
				if resp in moveoptions:
					node = self.board.nodes[resp]
					node.stone = self.color
					self.board.last_play = node.name
					self.board.last_player = self.color
					self.board.record('blink', node=resp)
					self.board.update()
					new_stone = {"type": "new_stone_animation", "color": self.color, "node": resp}
					self.ws.send(json.dumps(new_stone))
					if self.opp.ishuman:
						self.opp.ws.send(json.dumps(new_stone))
					return None

		actions = []
		spelllist = []

		if canmove:
			### Providence: Seal of Wind (and Seal of Stone, via the
			### standardmove flag below) applies only to the turn's FIRST
			### move; extra granted moves are ordinary moves.
			first_move = (self.board.moves_left_this_turn == self.board.moves_granted_this_turn)
			if self.board.moves_granted_this_turn > 1:
				move_num = self.board.moves_granted_this_turn - self.board.moves_left_this_turn + 1
				self.jmessage("Move {} of {}: choose where to move.".format(
					move_num, self.board.moves_granted_this_turn))
			else:
				self.jmessage("Choose where to move.")
			actions.append('move')
			if first_move and ('Seal_of_Wind' in [s.name for s in self.charged_spells]):
				moveoptions = self.allblinkablenodes()
			else:
				moveoptions = self.allmoveablenodes()
		else:
			moveoptions = {}
			if (candash & canspell & (self.totalstones > 2)):
				if 'Autumn' not in [s.name for s in self.opp.charged_spells]:
					actions.append('dash')
			summer_active = False
			if ('Seal_of_Summer' in [s.name for s in self.charged_spells]) and cansummer:
				summer_active = True

			if (canspell) or (not canspell and summer_active):
				self.board.update()
				for spell in self.charged_spells:
					if not spell.static:
						if spell.ischarm:
							if 'Seal_of_Winter' not in [s.name for s in self.opp.charged_spells]:
								if spell.name == 'Surge':
									if not candash:
										actions.append(spell.name)
										spelllist.append(spell.name)
								elif spell.name == 'Splash':
									if candash:
										actions.append(spell.name)
										spelllist.append(spell.name)
								else:
									actions.append(spell.name)
									spelllist.append(spell.name)
						else:
							if self.lock == spell and ('Seal_of_Spring' in [s.name for s in self.charged_spells]) and self.springlock != spell:
								actions.append(spell.name)
								spelllist.append(spell.name)
							if self.lock != spell:
								actions.append(spell.name)
								spelllist.append(spell.name)
			actions.append('pass')


		egress =  {"type": "message", "message": str(actions),
		"awaiting": "action", "actionlist": actions, "moveoptions": moveoptions}

		self.ws.send(json.dumps(egress))

		action = self.receivemessage()


		### This clause performs the 'move' action with the node name preloaded.
		### In this case action == the name of a node.
		if 'move' in actions:
			shortcuts = self.board.nodes.keys()
		else:
			shortcuts = []

		if action not in actions and action not in shortcuts:
			self.taketurn(canmove, candash, canspell, cansummer)
			return None

		elif action in shortcuts:
			first_move = (self.board.moves_left_this_turn == self.board.moves_granted_this_turn)
			self.move(action, standardmove=first_move)
			self.board.moves_left_this_turn = max(0, self.board.moves_left_this_turn - 1)
			self.taketurn(self.board.moves_left_this_turn, candash, canspell, cansummer)
			return None

		elif action == 'move':
			first_move = (self.board.moves_left_this_turn == self.board.moves_granted_this_turn)
			self.move(standardmove=first_move)
			self.board.moves_left_this_turn = max(0, self.board.moves_left_this_turn - 1)
			self.taketurn(self.board.moves_left_this_turn, candash, canspell, cansummer)
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
		### Put any beginning-of-turn triggers here,
		### like Inferno, which should set the global
		### variables gameover = True and winner = self.enemy

		if 'Seal_of_Destruction' in [spell.name for spell in self.charged_spells]:
			self.jmessage("DESTRUCTION CLAIMS YOU!")
			if self.opp.ishuman:
				self.opp.jmessage("DESTRUCTION CLAIMS YOU!")
			self.board.gameover = True
			self.board.winner = self.enemy


	def eot_triggers(self):
		### Put code in here for every specific spell
		### that causes end-of-turn triggers.
		### It must come BEFORE the end-game code below!

		### Check whether someone is up by 3 or more.

		### Check whether the spellcounter >= 6.

		### Providence: unused granted moves are forfeited. Zero the
		### counters BEFORE the win checks so leftover this-turn phantoms
		### never enter the lead/tiebreak math.
		self.board.moves_left_this_turn = 0
		self.board.moves_granted_this_turn = 0

		### INSERT SPELL-SPECIFIC EOT EFFECTS HERE


		if 'Seal_of_Destruction' in [spell.name for spell in self.charged_spells]:
			self.jmessage("DESTRUCTION BURNS!")
			if self.opp.ishuman:
				self.opp.jmessage("DESTRUCTION BURNS!")
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

		### ±3-lead check: Providence phantoms count ASYMMETRICALLY
		### (defense only) — each win claim uses real placed stones,
		### checked against the opponent's real+pending total. Ambush
		### snares and pending Aftershock burns count SYMMETRICALLY
		### everywhere (2026-08 buff): they add to the owner's total in
		### both the ±3-lead claim and the sixth-spell count (where
		### Providence phantoms are symmetric too, 2026-08 playtest
		### ruling).
		redprov = sum(self.board.pending_moves['red'])
		blueprov = sum(self.board.pending_moves['blue'])
		redamb = sum(self.board.pending_burns['red'])
		blueamb = sum(self.board.pending_burns['blue'])
		for owner in self.board.snares.values():
			if owner == 'red':
				redamb += 1
			else:
				blueamb += 1

		if redtotal + redamb > bluetotal + blueprov + blueamb + 2:
			self.board.gameover = True
			self.board.winner = 'red'

		elif bluetotal + blueamb > redtotal + redprov + redamb + 2:
			self.board.gameover = True
			self.board.winner = 'blue'

		else:
			if self.spellcounter >= 6:
				self.board.gameover = True
				if redtotal + redprov + redamb > bluetotal + blueprov + blueamb:
					self.board.winner = 'red'
				elif bluetotal + blueprov + blueamb > redtotal + redprov + redamb:
					self.board.winner = 'blue'
				else:
					a = ['red', 'blue']
					a.remove(self.board.whoseturn)
					self.board.winner = a[0]

		self.board.update()



	def move(self, preloaded = False, standardmove = False):
		### If the user clicked on a node while they had 'move' action available,
		### we call this move function with preloaded == the node they clicked.

		### standardmove is True iff this is the player's standard move for the turn.
		if not preloaded:
			if ('Seal_of_Wind' in [s.name for s in self.charged_spells]) and standardmove:
				moveoptions = self.allblinkablenodes()
			else:
				moveoptions = self.allmoveablenodes()

			egress =  {"type": "message", "message": "Choose where to move.",
			"awaiting": "node", "moveoptions": moveoptions}

			self.ws.send(json.dumps(egress))

			nodename = self.receivemessage()
		else:
			nodename = preloaded

		node = self.board.nodes[nodename]
		adjacent = False
		for neighbor in node.neighbors:
			if neighbor.stone == self.color:
				adjacent = True

		if node.stone == 'X':
			### permanently destroyed node (wall): not a legal move target.
			self.move(standardmove=standardmove)
			return None

		if node.stone == self.color:
			self.move(standardmove=standardmove)
			return None

		if self.violates_bulwark(nodename):
			self.move(standardmove=standardmove)
			return None

		elif not adjacent:
			if not (standardmove and ("Seal_of_Wind" in [spell.name for spell in self.charged_spells])):
				self.move(standardmove=standardmove)
				return None
			else:
				if node.stone == None:
					node.stone = self.color
					self.board.record('blink', node=node.name)

					egress =  {"type": "new_stone_animation", "color": self.color, "node": node.name}

					self.ws.send(json.dumps(egress))
					if self.opp.ishuman:
						self.opp.ws.send(json.dumps(egress))

					self.board.last_play = node.name
					self.board.last_player = self.color
					self.board.update()
				else:
					if (standardmove and ("Seal_of_Stone" in [spell.name for spell in self.opp.charged_spells])):
						self.jmessage("You can only make soft moves under the Seal of Stone.")
						self.move(standardmove=standardmove)
						return None
					self.board.record('hard_move', node=node.name, pushed_to='pending')
					self.pushenemy(node)


		elif node.stone == None:

			node.stone = self.color
			self.board.record('move', node=node.name)

			egress =  {"type": "new_stone_animation", "color": self.color, "node": node.name}
			self.ws.send(json.dumps(egress))
			if self.opp.ishuman:
				self.opp.ws.send(json.dumps(egress))

			self.board.last_play = node.name
			self.board.last_player = self.color
			self.board.update()

		elif node.stone == self.enemy:
			if (standardmove and ("Seal_of_Stone" in [spell.name for spell in self.opp.charged_spells])):
				self.jmessage("You can only make soft moves under the Seal of Stone.")
				self.move(standardmove=standardmove)
				return None
			self.board.record('hard_move', node=node.name, pushed_to='pending')
			self.pushenemy(node)



	def softmove(self):
		moveoptions = self.allsoftmoveablenodes()

		egress =  {"type": "message", "message": "Choose where to soft move.",
		"awaiting": "node", "moveoptions": moveoptions}

		self.ws.send(json.dumps(egress))

		nodename = self.receivemessage()
		node = self.board.nodes[nodename]
		adjacent = False
		for neighbor in node.neighbors:
			if neighbor.stone == self.color:
				adjacent = True

		if node.stone == None and adjacent:
			node.stone = self.color
			self.board.record('move', node=nodename)

			egress =  {"type": "new_stone_animation", "color": self.color, "node": node.name}
			self.ws.send(json.dumps(egress))
			if self.opp.ishuman:
				self.opp.ws.send(json.dumps(egress))

			self.board.last_play = nodename
			self.board.last_player = self.color
			self.board.update()

		elif node.stone == self.color:
			self.softmove()
			return None

		elif not adjacent:
			self.softmove()
			return None

		elif node.stone == self.enemy:
			self.jmessage("Invalid move-- that's not a soft move!")
			self.softmove()
			return None

	def hardmove(self):
		moveoptions = self.allhardmoveablenodes()

		egress =  {"type": "message", "message": "Choose where to hard move.",
		"awaiting": "node", "moveoptions": moveoptions}

		self.ws.send(json.dumps(egress))

		nodename = self.receivemessage()
		node = self.board.nodes[nodename]
		adjacent = False
		for neighbor in node.neighbors:
			if neighbor.stone == self.color:
				adjacent = True

		if not adjacent:
			self.hardmove()
			return None

		elif node.stone == self.color:
			self.hardmove()
			return None

		elif node.stone != self.enemy:
			self.jmessage("Invalid move-- that's not a hard move!")
			self.hardmove()
			return None

		else:
			self.board.record('hard_move', node=node.name, pushed_to='pending')
			self.pushenemy(node)

	def dash(self, shimmer=False):
		if self.opp.ishuman:
			self.opp.jmessage("Opponent dashes!")
		if shimmer:
			while True:
				self.jmessage("Choose a stone to sacrifice. ", "node")

				actualmessage = self.receivemessage()
				if actualmessage in self.board.nodes:
					node = self.board.nodes[actualmessage]
					if (node.stone != self.color):
						continue
					else:
						node.stone = None
						if (self.board.last_play == node):
							self.board.last_play = None
							self.board.last_player = None
						self.board.record('dash_lightning', sacrificed=[actualmessage], dest='pending')
						self.board.update()
						break
			self.move()
			self.board.update()

		else:
			sacrificed = []
			while True:
				self.jmessage("Sacrifice two stones.", "node")

				actualmessage = self.receivemessage()
				if actualmessage in self.board.nodes:
					node = self.board.nodes[actualmessage]
					if (node.stone != self.color):
						continue
					else:
						sacrificed.append(actualmessage)
						node.stone = None
						if (self.board.last_play == node):
							self.board.last_play = None
							self.board.last_player = None
						self.board.update()
						break

			while True:
				self.jmessage("", "node")

				actualmessage = self.receivemessage()
				if actualmessage in self.board.nodes:
					node = self.board.nodes[actualmessage]
					if (node.stone != self.color):
						continue
					else:
						sacrificed.append(actualmessage)
						node.stone = None
						if (self.board.last_play == node):
							self.board.last_play = None
							self.board.last_player = None
						self.board.update()
						break
			self.board.record('dash', sacrificed=sacrificed, dest='pending')
			self.move()
			self.board.update()

	def pushenemy(self, node):
		### Ambush: a snare beneath the occupant intercepts the incoming
		### stone FIRST (2026-08 playtest ruling): the arriving stone is
		### consumed together with the snare before any push resolves —
		### the occupant is neither displaced nor crushed. Only later
		### moves, with the snare spent, can push/crush it.
		if self.board.snares.get(node.name) == self.enemy:
			del self.board.snares[node.name]
			for egress in ({"type": "new_stone_animation", "color": self.color, "node": node.name},
			               {"type": "crush_animation", "crushed_color": self.color, "node": node.name}):
				self.ws.send(json.dumps(egress))
				if self.opp.ishuman:
					self.opp.ws.send(json.dumps(egress))
			self.jmessage("Your stone is destroyed by a snare!")
			if self.opp.ishuman:
				self.opp.jmessage("An enemy stone is destroyed by your snare!")
			self.board.update()
			return None

		node.stone = self.color

		egress =  {"type": "new_stone_animation", "color": self.color, "node": node.name}
		self.ws.send(json.dumps(egress))
		if self.opp.ishuman:
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
				self.jmessage("Enemy stone crushed!")

				egress =  {"type": "crush_animation", "crushed_color": self.enemy, "node": node.name}

				self.ws.send(json.dumps(egress))
				if self.opp.ishuman:
					self.opp.ws.send(json.dumps(egress))
				self.board.update()
				return None
			nextpair = pushingqueue.pop(0)
			nextnode, distance = nextpair
			alreadyvisited.append(nextnode)
			if nextnode.stone == self.color:
				continue
			elif nextnode.stone == 'X':
				### permanently destroyed node (wall): blocks the retreat
				### chain and is not a valid push destination.
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
		deduped_pushingoptionnames = list(set(pushingoptionnames))

		if len(deduped_pushingoptionnames) == 1:
			push = deduped_pushingoptionnames[0]
			self.board.nodes[push].stone = self.enemy
			egress =  {"type": "push_animation", "pushed_color": self.enemy, "starting_node": node.name, "ending_node": push}

			self.ws.send(json.dumps(egress))
			if self.opp.ishuman:
				self.opp.ws.send(json.dumps(egress))

			self.board.update()
			return None

		while True:
			egress = {"type": "pushingoptions", }
			for nodename in deduped_pushingoptionnames:
				egress[nodename] = self.enemy

			self.ws.send(json.dumps(egress))

			self.jmessage("Choose where to push the enemy stone.", "node")

			push = self.receivemessage()
			if push not in deduped_pushingoptionnames:
				self.jmessage("Invalid option!")
				continue
			self.board.nodes[push].stone = self.enemy

			egress =  {"type": "push_animation", "pushed_color": self.enemy, "starting_node": node.name, "ending_node": push}

			self.ws.send(json.dumps(egress))
			if self.opp.ishuman:
				self.opp.ws.send(json.dumps(egress))

			self.board.update()
			break
