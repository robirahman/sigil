import spellgenerator
import spellfile
import json
import time







class resetException(Exception):
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



		### A dictionary of all the relevant facts about the board state.
		### We take a snapshot using board.take_snapshot() , and then
		### if the user throws a 'reset' exception, the board returns to
		### whatever state is saved in board.snapshot.
		self.snapshot = None

		### A string that tells which player is winning and by how much.
		self.score = 'b1'

		self.last_play = None
		self.last_player = None


	def take_snapshot(self):

		### ADD ALL BOARD ATTRIBUTES TO THE SNAPSHOT

		### Sets board.snapshot to be a dictionary 
		### which describes the current boardstate

		snapshot = {}
		snapshot["turncounter"] = self.turncounter
		snapshot["gameover"] = self.gameover
		snapshot["winner"] = self.winner
		snapshot["score"] = self.score
		snapshot["redcountdown"] = self.redplayer.countdown
		snapshot["bluecountdown"] = self.blueplayer.countdown
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



		### Sends a json dictionary to the players.
		### Tells which stones are where, and also which locks are where.

		jboard = {"type": "boardstate", }
		for name in self.nodes:
			jboard[name] = self.nodes[name].stone

		if self.redplayer.lock:
			jboard["redlock"] = self.redplayer.lock.name
		if self.blueplayer.lock:
			jboard["bluelock"] = self.blueplayer.lock.name


		if self.redplayer.countdown > 1:
			redcountdownstring = "{} Red spells".format(self.redplayer.countdown)
		elif self.redplayer.countdown == 1:
			redcountdownstring = "1 Red spell"
		else:
			redcountdownstring = "Zero Red spells"

		jboard["redcountdown"] = redcountdownstring

		if self.blueplayer.countdown > 1:
			bluecountdownstring = "{} Blue spells".format(self.blueplayer.countdown)
		elif self.blueplayer.countdown == 1:
			bluecountdownstring = "1 Blue spell"
		else:
			bluecountdownstring = "Zero Blue spells"


		jboard["bluecountdown"] = bluecountdownstring

		if update_score:
			jboard["score"] = self.score

		jboard["last_player"] = self.last_player
		jboard["last_play"] = self.last_play
		
		self.redplayer.ws.send(json.dumps(jboard))
		self.blueplayer.ws.send(json.dumps(jboard))


	def end_game(self):
		### Right now this doesn't DO anything special,
		### just prints some silly stuff.
		### But this would be a good place to put any 'store the data'
		### type code.
		self.redplayer.jmessage("Game over-- the winner is " + self.winner.upper() +
							   " !!!")
		self.blueplayer.jmessage("Game over-- the winner is " + self.winner.upper() +
								" !!!")
		for i in range(3):
			self.redplayer.jmessage(self.winner.upper() + " VICTORY")
			self.blueplayer.jmessage(self.winner.upper() + " VICTORY")

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

		### The spell countdown for this player. The EOT trigger checks in
		### player.taketurn will check if player.countdown == 0,
		### and if so, end the game appropriately.
		self.countdown = 6

		### player.opp will be the opponent player object.
		self.opp = None

		### The player.ws attribute will be where we store
		### the object which is the ws connection to each player.
		self.ws = None


	def jmessage(self, message, awaiting= None):
		egress =  {"type": "message", "message": message, "awaiting": awaiting, }
		self.ws.send(json.dumps(egress))


	def receivemessage(self):
		ingress = self.ws.receive()
		if json.loads(ingress)['message'] == 'reset':
			raise resetException()

		actualmessage = json.loads(ingress)['message']
		return actualmessage


	def allmoveablenodes(self):
		answer = []
		for nodename in self.board.nodes:
			node = self.board.nodes[nodename]
			if node.stone != self.color:
				adjacent = False
				for neighbor in node.neighbors:
					if neighbor.stone == self.color:
						adjacent = True
				if adjacent:
					answer.append(nodename)
		return answer

	def allsoftmoveablenodes(self):
		answer = []
		for nodename in self.board.nodes:
			node = self.board.nodes[nodename]
			if node.stone == None:
				adjacent = False
				for neighbor in node.neighbors:
					if neighbor.stone == self.color:
						adjacent = True
				if adjacent:
					answer.append(nodename)
		return answer

	def allhardmoveablenodes(self):
		answer = []
		for nodename in self.board.nodes:
			node = self.board.nodes[nodename]
			if node.stone == self.enemy:
				adjacent = False
				for neighbor in node.neighbors:
					if neighbor.stone == self.color:
						adjacent = True
				if adjacent:
					answer.append(nodename)
		return answer


	def allblinkablenodes(self):
		answer = []
		for nodename in self.board.nodes:
			if self.board.nodes[nodename].stone != self.color:
				answer.append(nodename)
		return answer



	def taketurn(self, canmove=True, candash=True, canspell=True, cansummer=True):
		self.board.update()

		actions = []
		spelllist = []

		if canmove:
			actions.append('move')
			if ('Field_of_Flowers' in [s.name for s in self.charged_spells]):
				moveoptions = self.allblinkablenodes()
			else:
				moveoptions = self.allmoveablenodes()
		else:
			moveoptions = []
			if (candash & canspell & (self.totalstones > 2)):
				if 'Autumn' not in [s.name for s in self.opp.charged_spells]:
					actions.append('dash')
			summer_active = False
			if ('Summer' in [s.name for s in self.charged_spells]) and cansummer:
				summer_active = True

			if (canspell) or (not canspell and summer_active):
				self.board.update()
				for spell in self.charged_spells:
					if not spell.static:
						if spell.ischarm:
							if 'Winter' not in [s.name for s in self.opp.charged_spells]:
								if spell.name == 'Frost':
									if candash:
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

		self.jmessage("\nSelect an action:")


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
			self.jmessage("Invalid action!")
			self.taketurn(canmove, candash, canspell, cansummer)
			return None

		elif action in shortcuts:
			self.move(action, standardmove=True)
			self.taketurn(False, candash, canspell, cansummer)
			return None

		elif action == 'move':
			self.move(standardmove=True)
			self.taketurn(False, candash, canspell, cansummer)
			return None

		elif action == 'dash':
			if ('Heat_Shimmer' in [s.name for s in self.charged_spells]):
				self.dash(True)
				self.taketurn(canmove, False, canspell, cansummer)
				return None
			else:
				self.dash()
				self.taketurn(canmove, False, canspell, cansummer)
				return None

		elif action in spelllist:
			self.board.spelldict[action].cast(self)
			if canspell:
				self.taketurn(False, False, False, cansummer)
				return None
			else:
				self.taketurn(False, False, False, False)
				return None


		elif action == 'pass':
			return None

	def bot_triggers(self):
		### Put any beginning-of-turn triggers here,
		### like Inferno, which should set the global
		### variables gameover = True and winner = self.enemy

		if 'Inferno' in [spell.name for spell in self.charged_spells]:
			self.jmessage("DEATH BY INFERNO!")
			if self.opp.ishuman:
				self.opp.jmessage("DEATH BY INFERNO!")
			self.board.gameover = True
			self.board.winner = self.enemy


	def eot_triggers(self):
		### Put code in here for every specific spell
		### that causes end-of-turn triggers.
		### It must come BEFORE the end-game code below!

		### Check whether someone is up by 3 or more.

		### Check whether the countdown == 0.


		### INSERT SPELL-SPECIFIC EOT EFFECTS HERE
	

		if 'Inferno' in [spell.name for spell in self.charged_spells]:
			self.jmessage("INFERNO TRIGGER!")
			if self.opp.ishuman:
				self.opp.jmessage("INFERNO TRIGGER!")
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
			if self.countdown == 0:
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



	def move(self, preloaded = False, standardmove = False):
		### If the user clicked on a node while they had 'move' action available,
		### we call this move function with preloaded == the node they clicked.

		### standardmove is True iff this is the player's standard move for the turn.
		if not preloaded:
			if ('Field_of_Flowers' in [s.name for s in self.charged_spells]):
				moveoptions = self.allblinkablenodes()
			else:
				moveoptions = self.allmoveablenodes()

			egress =  {"type": "message", "message": "Where would you like to move? ", 
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

		if node.stone == self.color:
			self.jmessage("Invalid move-- you already have a stone there!")
			self.move(standardmove=standardmove)
			return None

		elif not adjacent:
			if not (standardmove and ("Field_of_Flowers" in [spell.name for spell in self.charged_spells])):
				self.jmessage("Invalid move-- that's not adjacent to you!")
				self.move(standardmove=standardmove)
				return None
			else:
				if node.stone == None:
					node.stone = self.color

					egress =  {"type": "new_stone_animation", "color": self.color, "node": node.name}

					self.ws.send(json.dumps(egress))
					if self.opp.ishuman:
						self.opp.ws.send(json.dumps(egress))

					self.board.last_play = node.name
					self.board.last_player = self.color
					self.board.update()
				else:
					if (standardmove and ("Gravity" in [spell.name for spell in self.opp.charged_spells])):
						self.jmessage("You can only make soft moves under Gravity.")
						self.move(standardmove=standardmove)
						return None
					self.pushenemy(node)


		elif node.stone == None:

			node.stone = self.color

			egress =  {"type": "new_stone_animation", "color": self.color, "node": node.name}
			self.ws.send(json.dumps(egress))
			if self.opp.ishuman:
				self.opp.ws.send(json.dumps(egress))

			self.board.last_play = node.name
			self.board.last_player = self.color
			self.board.update()

		elif node.stone == self.enemy:
			if (standardmove and ("Gravity" in [spell.name for spell in self.opp.charged_spells])):
				self.jmessage("You can only make soft moves under Gravity.")
				self.move(standardmove=standardmove)
				return None
			self.pushenemy(node)



	def softmove(self):
		moveoptions = self.allsoftmoveablenodes()
			
		egress =  {"type": "message", "message": "Where would you like to soft move? ", 
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

			egress =  {"type": "new_stone_animation", "color": self.color, "node": node.name}
			self.ws.send(json.dumps(egress))
			if self.opp.ishuman:
				self.opp.ws.send(json.dumps(egress))
				
			self.board.last_play = nodename
			self.board.last_player = self.color
			self.board.update()

		elif node.stone == self.color:
			self.jmessage("Invalid move-- you already have a stone there!")
			self.softmove()
			return None

		elif not adjacent:
			self.jmessage("Invalid move-- that's not adjacent to you!")
			self.softmove()
			return None

		elif node.stone == self.enemy:
			self.jmessage("Invalid move-- that's not a soft move!")
			self.softmove()
			return None

	def hardmove(self):
		moveoptions = self.allhardmoveablenodes()
			
		egress =  {"type": "message", "message": "Where would you like to hard move? ", 
		"awaiting": "node", "moveoptions": moveoptions}

		self.ws.send(json.dumps(egress))

		nodename = self.receivemessage()
		node = self.board.nodes[nodename]
		adjacent = False
		for neighbor in node.neighbors:
			if neighbor.stone == self.color:
				adjacent = True

		if not adjacent:
			self.jmessage("Invalid move-- that's not adjacent to you!")
			self.hardmove()
			return None

		elif node.stone == self.color:
			self.jmessage("Invalid move-- you already have a stone there!")
			self.hardmove()
			return None

		elif node.stone != self.enemy:
			self.jmessage("Invalid move-- that's not a hard move!")
			self.hardmove()
			return None

		else:
			self.pushenemy(node)

	def dash(self, shimmer=False):
		if shimmer:
			while True:
				self.jmessage("Select a stone to sacrifice. ", "node")
			
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
						self.board.update()
						break
			self.move()
			self.board.update()

		else:
			while True:
				self.jmessage("Select your first stone to sacrifice. ", "node")
				
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
						self.board.update()
						break

			while True:
				self.jmessage("Select your second stone to sacrifice. ", "node")
				
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
						self.board.update()
						break
			self.move()
			self.board.update()

	def pushenemy(self, node):
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

			self.jmessage("Where would you like to push the enemy stone? ", "node")
			
			push = self.receivemessage()
			if push not in deduped_pushingoptionnames:
				self.jmessage("Invalid option!")
				continue
			self.board.nodes[push].stone = self.enemy
			self.jmessage("Enemy stone pushed to " + push)

			egress =  {"type": "push_animation", "pushed_color": self.enemy, "starting_node": node.name, "ending_node": push}

			self.ws.send(json.dumps(egress))
			if self.opp.ishuman:
				self.opp.ws.send(json.dumps(egress))

			self.board.update()
			break






			