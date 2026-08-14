
import json
import time

from notation import NODE_ORDER, POSITIONS


class Spell():
	def __init__(self, board, position, name):
		self.board = board

		### position is a list of the node objects
		### which constitute this spell.
		self.position = position

		self.name = name

		### True iff it's a charm
		self.ischarm = False

		### True iff it's static
		self.static = False

		### The 'charged' attribute will equal 'red' or 'blue'
		### if one of them has the spell fully charged, and None otherwise
		self.charged = None


	def cast(self, player):
		### sacrifice all stones in it, and refill appropriate
		### number based on mana
		pname = player.color[0].upper() + player.color[1:]
		if player.ishuman:
			player.jmessage(pname + " casts " + self.name)
		if player.opp.ishuman:
			player.opp.jmessage(pname + " casts " + self.name)
		if not player.ishuman:
			time.sleep(1)
		if self.ischarm:
			for node in self.position:
				if node.stone == 'X':
					continue  # never clobber a wall
				node.stone = None
				if (player.board.last_play == node.name):
					player.board.last_play = None
					player.board.last_player = None

		else:
			for node in self.position:
				if node.stone == 'X':
					continue  # never clobber a wall
				node.stone = None
				if (player.board.last_play == node.name):
					player.board.last_play = None
					player.board.last_player = None

			refills = player.mana

			if refills > 1:
				if player.ishuman:
					player.jmessage("You get to keep {} stones in ".format(refills)
							   + self.name + ".")
			elif refills == 1:
				if player.ishuman:
					player.jmessage("You get to keep 1 stone in " + self.name + ".")

			if player.ishuman:
				while refills > 0:
					player.jmessage("Select a stone to keep: ", "node")

					egress = { "type": "chooserefills", "playercolor": player.color }

					for node in self.position:
						if node.stone == None:
							egress[node.name] = "True"

					player.ws.send(json.dumps(egress))

					keep = player.receivemessage()
					
					if self.board.nodes[keep] not in self.position:
						player.jmessage("That's not a node in your spell!")

					elif self.board.nodes[keep].stone != None:
						player.jmessage("You already kept that stone!")
						continue
					else:
						refills -= 1
						self.board.nodes[keep].stone = player.color
						self.board.update()

				egress = { "type": "donerefilling" , "playercolor": player.color}
				player.ws.send(json.dumps(egress))

			else:

				if len(self.position) == 3:
					refill_priority = [self.position[2], self.position[1], self.position[0]]
				else:
					refill_priority = [self.position[2], self.position[3], self.position[4], self.position[0], self.position[1]]
				for node in refill_priority:
					if node.stone == 'X':
						continue  # never place on a wall
					if refills > 0:
						node.stone = player.color
						refills -= 1
					else:
						break
				self.board.update()
				time.sleep(1)
						
			
		self.board.update()
		self.resolve(player)

		self.board.update()

		if not self.ischarm:
			if player.lock == self:
				player.springlock = self
				pname = player.color[0].upper() + player.color[1:]
				if player.ishuman:
					player.jmessage(self.name + " is Springlocked for " + pname)
				if player.opp.ishuman:
					player.opp.jmessage(self.name + " is Springlocked for " + pname)
			else:
				player.lock = self
				player.springlock = None
			player.spellcounter += 1

	def resolve(self, player):
		### The actual effect!!!
		### Overwrite this in the specific spell classes.
		pass

	def update_charge(self):

		### Sets the 'charged' attribute to correctly reflect
		### the current board state.  Must be called every time
		### the board state changes.

		### A spell whose position contains a permanently destroyed node
		### (a wall) can never be charged or cast again.
		if any(node.stone == 'X' for node in self.position):
			self.charged = None
			return None

		firststone = self.position[0].stone
		if len(self.position) == 1:
			self.charged = firststone
			return None
		else:
			for node in self.position[1:]:
				if node.stone != firststone:
					self.charged = None
					return None
			self.charged = firststone









###############################################################################################
#####  ACTUAL SPELLS HERE


class Sprout(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "Make 1 soft move."


	def resolve(self, player):
		if player.ishuman:
			player.softmove()
		else:
			player.softmove(self.position.copy())


class Grow(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Make 2 soft moves."

	def resolve(self, player):
		if player.ishuman:
			for i in range(2):
				player.softmove()
		else:
			for i in range(2):
				player.softmove(self.position.copy())



class Flourish(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Make 4 soft moves."

	def resolve(self, player):
		if player.ishuman:
			for i in range(4):
				player.softmove()
		else:
			for i in range(4):
				player.softmove(self.position.copy())


class Slash(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "Make 1 hard move."


	def resolve(self, player):
		if not player.allhardmoveablenodes():
			if player.ishuman:
				player.jmessage("No legal hard moves")
			return
		player.hardmove()


class Fireblast(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Destroy all enemy stones which are touching you, then sacrifice a stone."

	def resolve(self, player):
		for name in player.board.nodes:
			node = player.board.nodes[name]
			if node.stone == player.enemy:
				for neighbor in node.neighbors:
					if neighbor.stone == player.color:
						node.stone = None
						if (player.board.last_play == node.name):
							player.board.last_play = None
							player.board.last_player = None

		player.board.update()

		### If destruction wiped out the opponent's last stone, the
		### latest-edition rules end the game right now — skip sacrifice.
		if player.board.gameover:
			return

		### Sacrifice cost (latest-edition rules).
		### Skip entirely if the caster has no stones left (the
		### update() above would have already flagged that as a loss).
		has_own_stone = any(
			player.board.nodes[n].stone == player.color
			for n in player.board.nodes
		)
		if not has_own_stone:
			return

		if player.ishuman:
			while True:
				player.jmessage("Sacrifice a stone.", "node")

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					node = player.board.nodes[actualmessage]
					if node.stone != player.color:
						continue
					node.stone = None
					if (player.board.last_play == node.name):
						player.board.last_play = None
						player.board.last_player = None
					player.board.update()
					break
		else:
			### Bot: sacrifice the lowest-priority own stone.
			time.sleep(1)
			for name in reversed(player.priority_order):
				node = player.board.nodes[name]
				if node.stone == player.color:
					node.stone = None
					if (player.board.last_play == node.name):
						player.board.last_play = None
						player.board.last_player = None
					player.board.update()
					time.sleep(1)
					break


class Carnage(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Make 4 hard moves."

	def resolve(self, player):
		for i in range(4):
			if not player.allhardmoveablenodes():
				if player.ishuman:
					player.jmessage("No legal hard moves")
				break
			player.hardmove()



class Surge(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "If you dashed this turn, make 1 move."


	def resolve(self, player):
		player.move()


class Hail_Storm(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Destroy 1 enemy stone in each 3-node and 5-node spell."

	def resolve(self, player):
		if player.ishuman:
			hailablespells = []
			### We will use the notation of board.positions to refer to spells.
			### That is, 1,2,3 are the majors, 4,5,6 are the minors, 7,8,9 charms.

			for i in range(1,7):
				innernodelist = player.board.positions[i]
				for node in innernodelist:
					if node.stone == player.enemy:
						hailablespells.append(i)
						break

			player.jmessage("Select an enemy stone to destroy in each 3-node and 5-node spell.")
			while len(hailablespells) > 0:
				player.jmessage("", "node")

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					node = player.board.nodes[actualmessage]

					if node.stone != player.enemy:
						continue

					validstone = False

					for spellnum in hailablespells:
						if node in player.board.positions[spellnum]:
							node.stone = None
							if (player.board.last_play == node.name):
								player.board.last_play = None
								player.board.last_player = None
							hailablespells.remove(spellnum)
							player.board.update()
		else:
			for i in range(1,7):
				innernodelist = player.board.positions[i]
				for node in innernodelist:
					if node.stone == player.enemy:
						node.stone = None
						if (player.board.last_play == node.name):
								player.board.last_play = None
								player.board.last_player = None
						player.board.update()
						time.sleep(1)
						break



class Bewitch(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Choose 2 enemy stones touching each other. Convert them to your color."

	def resolve(self, player):

		if player.ishuman:

			egress = {"type": "selectingNoButton"}
			player.ws.send(json.dumps(egress))

			while True:
				convert_one_options = {}
				for nodename in self.board.nodes:
					node = self.board.nodes[nodename]
					if node.stone == player.enemy:
						adjacent_to_enemy = False
						for neighbor in node.neighbors:
							if neighbor.stone == player.enemy:
								adjacent_to_enemy = True

						if adjacent_to_enemy:
							convert_one_options[nodename] = player.color

				egress =  {"type": "message", "message": "Choose 2 enemy stones to convert.", 
				"awaiting": "node", "moveoptions": convert_one_options}

				player.ws.send(json.dumps(egress))

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					if actualmessage in convert_one_options:
						node = player.board.nodes[actualmessage]
						node.stone = player.color

						egress =  {"type": "new_stone_animation", "color": player.color, "node": node.name}
						player.ws.send(json.dumps(egress))
						if player.opp.ishuman:
							player.opp.ws.send(json.dumps(egress))

						player.board.update()
						break

					else:
						player.jmessage("Invalid selection")
						continue

				else:
					continue

			while True:
				convert_two_options = {}
				for neighbor in node.neighbors:
					if neighbor.stone == player.enemy:
						convert_two_options[neighbor.name] = player.color

				egress =  {"type": "message", "message": "", "awaiting": "node", "moveoptions": convert_two_options}

				player.ws.send(json.dumps(egress))

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					if actualmessage in convert_two_options:
						node2 = player.board.nodes[actualmessage]
						node2.stone = player.color

						egress =  {"type": "new_stone_animation", "color": player.color, "node": node2.name}
						player.ws.send(json.dumps(egress))
						if player.opp.ishuman:
							player.opp.ws.send(json.dumps(egress))

						player.board.update()
						break

					else:
						player.jmessage("Invalid selection")
						continue
				else:
					continue
		else:
			for name in player.bewitch_priority_order:
				node = player.board.nodes[name]
				if node.stone == player.enemy:
					for neighbor in node.neighbors:
						if neighbor.stone == player.enemy:
							# Potential targets. Make sure they're not surrounded.
							surrounded = True
							for other_neighbor in node.neighbors:
								if other_neighbor.stone != player.enemy:
									surrounded = False
							for other_neighbor in neighbor.neighbors:
								if other_neighbor.stone != player.enemy:
									surrounded = False
							if surrounded:
								continue
							else:
								node.stone = player.color
								egress =  {"type": "new_stone_animation", "color": player.color, "node": node.name}
								player.opp.ws.send(json.dumps(egress))
								player.board.update()
								time.sleep(1)

								neighbor.stone = player.color
								egress =  {"type": "new_stone_animation", "color": player.color, "node": neighbor.name}
								player.opp.ws.send(json.dumps(egress))
								player.board.update()
								time.sleep(1)
								return


class Comet(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "Make 1 blink move, then sacrifice a stone."


	def resolve(self, player):
		
		if player.ishuman:
			while True:
				moveoptions = player.allblinkablenodes()
				egress =  {"type": "message", "message": "Make 1 blink move.", 
				"awaiting": "node", "moveoptions": moveoptions}

				player.ws.send(json.dumps(egress))

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					node = player.board.nodes[actualmessage]
					if node.stone == player.color:
						player.jmessage("Invalid option")
						continue
					if node.stone == player.opp.color:
						player.pushenemy(node)
						break
					else:
						node.stone = player.color

						egress =  {"type": "new_stone_animation", "color": player.color, "node": node.name}
						player.ws.send(json.dumps(egress))
						if player.opp.ishuman:
							player.opp.ws.send(json.dumps(egress))

						player.board.update()
						break

			while True:
				player.jmessage("Sacrifice a stone.", "node")

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					node = player.board.nodes[actualmessage]
					if node.stone != player.color:
						continue

					else:
						node.stone = None
						if (player.board.last_play == node.name):
							player.board.last_play = None
							player.board.last_player = None
						player.board.update()
						break
		else:
			for node in [player.board.nodes['c1'], player.board.nodes['b1'], player.board.nodes['a1']]:
				already_touching = False
				adjacent_enemy_count = 0
				if node.stone == player.color:
					already_touching = True
				else:
					if node.stone == player.enemy:
						adjacent_enemy_count += 1
					for neighbor in node.neighbors:
						if neighbor.stone == player.color:
							already_touching = True
						elif neighbor.stone == player.enemy:
							adjacent_enemy_count += 1
				if (not already_touching) and (adjacent_enemy_count < 2):
					# blink move into the node
					if node.stone == player.enemy:
						player.pushenemy(node)
						break
					else:
						node.stone = player.color
						egress =  {"type": "new_stone_animation", "color": player.color, "node": node.name}
						player.opp.ws.send(json.dumps(egress))
						player.board.update()
						break
			# sacrifice a stone
			time.sleep(1)
			for name in reversed(player.priority_order):
				node = player.board.nodes[name]
				if node.stone == player.color:
					node.stone = None
					if (player.board.last_play == node):
						player.board.last_play = None
						player.board.last_player = None
					player.board.update()
					time.sleep(1)
					break


class Meteor(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Make 1 blink move, then destroy 1 enemy stone touching it."

	def resolve(self, player):
		if player.ishuman:
			while True:
				moveoptions = player.allblinkablenodes()
				egress =  {"type": "message", "message": "Make 1 blink move.", 
				"awaiting": "node", "moveoptions": moveoptions}

				player.ws.send(json.dumps(egress))

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					node = player.board.nodes[actualmessage]
					if node.stone == player.color:
						player.jmessage("Invalid option")
						continue
					if node.stone == player.opp.color:
						player.pushenemy(node)
						break
					else:
						node.stone = player.color

						egress =  {"type": "new_stone_animation", "color": player.color, "node": node.name}
						player.ws.send(json.dumps(egress))
						if player.opp.ishuman:
							player.opp.ws.send(json.dumps(egress))

						player.board.update()
						break

			adjacent_enemy_count = 0
			for neighbor in node.neighbors:
				if neighbor.stone == player.opp.color:
					adjacent_enemy_count += 1
			if adjacent_enemy_count == 0:
				return
			if adjacent_enemy_count == 1:
				for neighbor in node.neighbors:
					if neighbor.stone == player.opp.color:
						neighbor.stone = None
						player.board.update()

			if adjacent_enemy_count > 1:
				while True:
					player.jmessage("Choose an enemy stone to destroy.", "node")

					actualmessage = player.receivemessage()

					if actualmessage in player.board.nodes:
						enemy_node = player.board.nodes[actualmessage]
						if enemy_node.stone != player.opp.color:
							continue
						is_adjacent = False
						for neighbor in node.neighbors:
							if neighbor == enemy_node:
								is_adjacent = True
						if is_adjacent == False:
							continue

						else:
							enemy_node.stone = None
							player.board.update()
							break
		else:
			legalmoves = player.allblinkablenodes()
			chosen_node = None
			for node in legalmoves:
				adjacent_enemy_count = 0
				if node.stone == player.enemy:
					adjacent_enemy_count += 1
				for neighbor in node.neighbors:
					if neighbor.stone == player.enemy:
						adjacent_enemy_count += 1
				if adjacent_enemy_count == 1:
					chosen_node = node
					break
			if chosen_node == None:
				chosen_node = legalmoves[0]

			if chosen_node.stone == player.enemy:
				player.pushenemy(node)
			else:
				node.stone = player.color
				egress =  {"type": "new_stone_animation", "color": player.color, "node": node.name}
				player.opp.ws.send(json.dumps(egress))
				player.board.update()
				time.sleep(1)
			for neighbor in node.neighbors:
				if neighbor.stone == player.enemy:
					neighbor.stone = None
					player.board.update()
					break
			


class Starfall(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Make 2 soft blink moves that touch each other, then destroy all enemy stones touching them."

	def resolve(self, player):
		if player.ishuman:
			while True:
				starfall_one_options = {}
				for nodename in self.board.nodes:
					node = self.board.nodes[nodename]
					if node.stone == None:
						adjacent_to_empty = False
						for neighbor in node.neighbors:
							if neighbor.stone == None:
								adjacent_to_empty = True

						if adjacent_to_empty:
							starfall_one_options[nodename] = player.color

				egress =  {"type": "message", "message": "Make 2 soft blink moves that touch each other.", 
				"awaiting": "node", "moveoptions": starfall_one_options}

				player.ws.send(json.dumps(egress))

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					if actualmessage not in starfall_one_options:
						player.jmessage("Invalid option")
						continue

					else:
						node = player.board.nodes[actualmessage]
						node.stone = player.color

						egress =  {"type": "new_stone_animation", "color": player.color, "node": node.name}
						player.ws.send(json.dumps(egress))
						if player.opp.ishuman:
							player.opp.ws.send(json.dumps(egress))

						player.board.update()
						break

				else:
					continue

			while True:
				starfall_two_options = {}
				for neighbor in node.neighbors:
					if neighbor.stone == None:
						starfall_two_options[neighbor.name] = player.color

				egress =  {"type": "message", "message": "", "awaiting": "node", "moveoptions": starfall_two_options}

				player.ws.send(json.dumps(egress))

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					if actualmessage not in starfall_two_options:
						player.jmessage("Invalid option")
						continue

					else:
						node2 = player.board.nodes[actualmessage]
						node2.stone = player.color

						egress =  {"type": "new_stone_animation", "color": player.color, "node": node2.name}
						player.ws.send(json.dumps(egress))
						if player.opp.ishuman:
							player.opp.ws.send(json.dumps(egress))

						break

				else:
					continue

			neighbor_union = []
			for neighbor in node.neighbors:
				neighbor_union.append(neighbor)
			for neighbor in node2.neighbors:
				new = True
				for already_there in neighbor_union:
					if neighbor == already_there:
						new = False
				if new:
					neighbor_union.append(neighbor)

			for neighbor in neighbor_union:
				if neighbor.stone == player.opp.color:
					neighbor.stone = None
					player.board.update()
		else:
			potential_targets = []
			for name in player.priority_order:
				node = player.board.nodes[name]
				if node.stone == None:
					for neighbor in node.neighbors:
						if neighbor.stone == None:
							# count adjacent enemies to <node, neighbor>
							alreadyvisited = set()
							adjacent_enemy_count = 0
							for first_neighbor in node.neighbors:
								alreadyvisited.add(first_neighbor)
								if first_neighbor.stone == player.enemy:
									adjacent_enemy_count += 1
							for second_neighbor in neighbor.neighbors:
								if second_neighbor in alreadyvisited:
									continue
								else:
									if second_neighbor.stone == player.enemy:
										adjacent_enemy_count += 1
							if adjacent_enemy_count > 1:
								potential_targets.append([adjacent_enemy_count, node, neighbor])
			max_enemies_killed = max([x[0] for x in potential_targets])
			for target in potential_targets:
				if target[0] == max_enemies_killed:
					# drop starfall here
					node = target[1]
					neighbor = target[2]
					node.stone = player.color
					egress =  {"type": "new_stone_animation", "color": player.color, "node": node.name}
					player.opp.ws.send(json.dumps(egress))
					player.board.update()
					time.sleep(1)

					neighbor.stone = player.color
					egress =  {"type": "new_stone_animation", "color": player.color, "node": neighbor.name}
					player.opp.ws.send(json.dumps(egress))
					player.board.update()
					time.sleep(1)

					for first_neighbor in node.neighbors:
						if first_neighbor.stone == player.enemy:
							first_neighbor.stone = None
					for second_neighbor in neighbor.neighbors:
						if second_neighbor.stone == player.enemy:
							second_neighbor.stone = None
					player.board.update()
					break




class Seal_of_Summer(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True
		self.static = True

		self.text = "STATIC: You may cast 2 spells on your turn."



class Seal_of_Wind(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.static = True

		self.text = "STATIC: Your first move each turn is a blink move."


class Seal_of_Lightning(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.static = True

		self.text = "STATIC: Your dash only requires 1 sacrifice."




###############################################################################################
#####  EXPANSION SPELLS: Springtime + Celestial


# Helper: place player.color onto `node`, handling enemy-push and animations.
def _place_into(player, node, record_hard=True):
	if node.stone == player.enemy:
		if record_hard:
			player.board.record('hard_move', node=node.name, pushed_to='pending')
		player.pushenemy(node)
	else:
		node.stone = player.color
		anim = {"type": "new_stone_animation", "color": player.color, "node": node.name}
		if player.ishuman:
			player.ws.send(json.dumps(anim))
		if player.opp.ishuman:
			player.opp.ws.send(json.dumps(anim))
		player.board.last_play = node.name
		player.board.last_player = player.color
		player.board.record('move', node=node.name)
		player.board.update()


# Helper: returns the spell-position index (1..9) containing `node`, or None.
def _spell_index_of(player, node):
	for i in range(1, 10):
		if node in player.board.positions[i]:
			return i
	return None


class Seal_of_Spring(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True
		self.static = True

		self.text = "STATIC: You may cast your locked spells a second time."


class Scatter(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Make 1 soft blink move into each of 2 spells."

	def resolve(self, player):
		used_spells = set()
		for move_num in range(2):
			# Soft blink: any empty node in a spell we haven't placed in yet.
			options = {}
			for i in range(1, 10):
				if i in used_spells:
					continue
				for node in player.board.positions[i]:
					if node.stone is None:
						options[node.name] = player.color
			if not options:
				return  # ends early
			if player.ishuman:
				egress = {"type": "message",
				          "message": "Soft blink into spell {} of 2 (any empty node).".format(move_num + 1),
				          "awaiting": "node", "moveoptions": options}
				player.ws.send(json.dumps(egress))
				while True:
					resp = player.receivemessage()
					if resp not in options:
						continue
					node = player.board.nodes[resp]
					used_spells.add(_spell_index_of(player, node))
					_place_into(player, node, record_hard=False)
					break
			else:
				node_name = next(iter(options))
				node = player.board.nodes[node_name]
				used_spells.add(_spell_index_of(player, node))
				node.stone = player.color
				player.board.update()


class Blossom(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Make 1 soft blink move into each other 3-node and 5-node spell."

	def resolve(self, player):
		my_idx = _spell_index_of(player, self.position[0])
		target_indices = [i for i in range(1, 7) if i != my_idx]
		used_spells = set()
		for _ in target_indices:
			remaining = [i for i in target_indices if i not in used_spells]
			options = {}
			for i in remaining:
				for node in player.board.positions[i]:
					if node.stone is None:
						options[node.name] = player.color
			if not options:
				return  # ends early
			if player.ishuman:
				egress = {"type": "message",
				          "message": "Soft blink into a remaining 3-node or 5-node spell.",
				          "awaiting": "node", "moveoptions": options}
				player.ws.send(json.dumps(egress))
				while True:
					resp = player.receivemessage()
					if resp not in options:
						continue
					node = player.board.nodes[resp]
					used_spells.add(_spell_index_of(player, node))
					_place_into(player, node, record_hard=False)
					break
			else:
				node_name = next(iter(options))
				node = player.board.nodes[node_name]
				used_spells.add(_spell_index_of(player, node))
				node.stone = player.color
				player.board.update()


# Builds {node_name -> color} for nodes within `spell_indices` that are legal
# soft-or-hard move targets (adjacency to player.color required).
def _move_options_in_spells(player, spell_indices):
	options = {}
	for idx in spell_indices:
		for node in player.board.positions[idx]:
			if node.stone == player.color:
				continue
			if any(nb.stone == player.color for nb in node.neighbors):
				options[node.name] = player.color
	return options


class Azimuth(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "Make 1 move into a spell where you control all but 1 node."

	def resolve(self, player):
		qualifying = []
		for i in range(1, 10):
			uncontrolled = sum(1 for n in player.board.positions[i] if n.stone != player.color)
			if uncontrolled == 1:
				qualifying.append(i)
		if not qualifying:
			return
		options = _move_options_in_spells(player, qualifying)
		if not options:
			return
		if player.ishuman:
			egress = {"type": "message",
			          "message": "Move into a spell where you control all but 1 node.",
			          "awaiting": "node", "moveoptions": options}
			player.ws.send(json.dumps(egress))
			while True:
				resp = player.receivemessage()
				if resp not in options:
					continue
				_place_into(player, player.board.nodes[resp])
				break
		else:
			node_name = next(iter(options))
			_place_into(player, player.board.nodes[node_name])


class Eclipse(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Make 2 moves into a spell where you control all but 2 nodes."

	def resolve(self, player):
		candidates = []
		for i in range(1, 10):
			uncontrolled = sum(1 for n in player.board.positions[i] if n.stone != player.color)
			if uncontrolled == 2:
				candidates.append(i)
		if not candidates:
			return
		options = _move_options_in_spells(player, candidates)
		if not options:
			return
		chosen_spell = None
		if player.ishuman:
			egress = {"type": "message",
			          "message": "Make 2 moves into a spell. Pick the first.",
			          "awaiting": "node", "moveoptions": options}
			player.ws.send(json.dumps(egress))
			while True:
				resp = player.receivemessage()
				if resp not in options:
					continue
				node = player.board.nodes[resp]
				chosen_spell = _spell_index_of(player, node)
				_place_into(player, node)
				break
		else:
			node_name = next(iter(options))
			node = player.board.nodes[node_name]
			chosen_spell = _spell_index_of(player, node)
			_place_into(player, node)
		if chosen_spell is None:
			return
		options2 = _move_options_in_spells(player, [chosen_spell])
		if not options2:
			return  # ends early
		if player.ishuman:
			egress = {"type": "message",
			          "message": "Make the second move into the same spell.",
			          "awaiting": "node", "moveoptions": options2}
			player.ws.send(json.dumps(egress))
			while True:
				resp = player.receivemessage()
				if resp not in options2:
					continue
				_place_into(player, player.board.nodes[resp])
				break
		else:
			node_name = next(iter(options2))
			_place_into(player, player.board.nodes[node_name])


# Maps a 5-node ritual position to its "opposite" 1-node and 3-node positions.
SYZYGY_OPPOSITE = {1: (8, 5), 2: (9, 6), 3: (7, 4)}


class Syzygy(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Make 1 blink move into the 1-node spell opposite Syzygy, then 3 into the 3-node spell."

	def resolve(self, player):
		my_idx = _spell_index_of(player, self.position[0])
		if my_idx not in SYZYGY_OPPOSITE:
			return
		charm_idx, sorcery_idx = SYZYGY_OPPOSITE[my_idx]
		charm_node = player.board.positions[charm_idx][0]
		sorcery_nodes = player.board.positions[sorcery_idx]

		# Step 1: 1 blink move into the opposite 1-node spell.
		if charm_node.stone != player.color:
			if player.ishuman:
				opts = {charm_node.name: player.color}
				egress = {"type": "message", "message": "Blink into the opposite 1-node spell.",
				          "awaiting": "node", "moveoptions": opts}
				player.ws.send(json.dumps(egress))
				while True:
					resp = player.receivemessage()
					if resp != charm_node.name:
						continue
					_place_into(player, charm_node)
					break
			else:
				_place_into(player, charm_node)

		# Step 2: up to 3 blink moves into the opposite 3-node spell.
		for move in range(3):
			opts = {n.name: player.color for n in sorcery_nodes if n.stone != player.color}
			if not opts:
				return
			if player.ishuman:
				egress = {"type": "message",
				          "message": "Blink into the opposite 3-node spell ({}/3).".format(move + 1),
				          "awaiting": "node", "moveoptions": opts}
				player.ws.send(json.dumps(egress))
				while True:
					resp = player.receivemessage()
					if resp not in opts:
						continue
					_place_into(player, player.board.nodes[resp])
					break
			else:
				node_name = next(iter(opts))
				_place_into(player, player.board.nodes[node_name])


###############################################################################################
#####  EXPANSION SPELLS: Inferno + Tempest + Tsunami


class Charge(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "Make 1 move into a 3-node or 5-node spell."

	def resolve(self, player):
		# Any soft-or-hard move into positions 1..6. No "control all but N"
		# constraint, unlike Azimuth.
		options = _move_options_in_spells(player, list(range(1, 7)))
		if not options:
			if player.ishuman:
				player.jmessage("No legal move into a 3-node or 5-node spell.")
			return
		if player.ishuman:
			egress = {"type": "message",
			          "message": "Make 1 move into a 3-node or 5-node spell.",
			          "awaiting": "node", "moveoptions": options}
			player.ws.send(json.dumps(egress))
			while True:
				resp = player.receivemessage()
				if resp not in options:
					continue
				_place_into(player, player.board.nodes[resp])
				break
		else:
			node_name = next(iter(options))
			_place_into(player, player.board.nodes[node_name])


class Fury(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Sacrifice 1 stone, then make 3 hard moves."

	def resolve(self, player):
		# Sacrifice 1 own stone.
		has_own = any(player.board.nodes[n].stone == player.color
		              for n in player.board.nodes)
		if has_own:
			if player.ishuman:
				while True:
					player.jmessage("Sacrifice a stone.", "node")
					resp = player.receivemessage()
					if resp not in player.board.nodes:
						continue
					node = player.board.nodes[resp]
					if node.stone != player.color:
						continue
					node.stone = None
					if player.board.last_play == node.name:
						player.board.last_play = None
						player.board.last_player = None
					player.board.update()
					break
			else:
				time.sleep(1)
				for name in reversed(player.priority_order):
					node = player.board.nodes[name]
					if node.stone == player.color:
						node.stone = None
						if player.board.last_play == node.name:
							player.board.last_play = None
							player.board.last_player = None
						player.board.update()
						break
		if player.board.gameover:
			return
		# Then 3 hard moves.
		for i in range(3):
			if not player.allhardmoveablenodes():
				if player.ishuman:
					player.jmessage("No legal hard moves")
				break
			player.hardmove()
			if player.board.gameover:
				return


class Erupt(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Make 2 moves into every spell, except Erupt, in which you have a stone."

	def resolve(self, player):
		# Up to 2 regular (hard or soft, never blink) moves into every 3- or
		# 5-node spell (positions 1..6) in which the caster already has a
		# stone, EXCEPT Erupt's own slot. Moves may be made in any order; a
		# spell where you hold k of its N nodes allows min(2, N-k) moves,
		# further limited by reachability.
		own = set(n.name for n in self.position)
		eligible = []
		for i in range(1, 7):
			nodes_i = player.board.positions[i]
			if set(n.name for n in nodes_i) == own:
				continue  # skip Erupt's own slot
			if any(n.stone == player.color for n in nodes_i):
				eligible.append(i)
		moves_left = {i: 2 for i in eligible}
		while True:
			# Union of legal move targets across eligible spells that still
			# have moves remaining, so the caster picks order freely.
			options = {}
			node_to_spell = {}
			for i in eligible:
				if moves_left[i] <= 0:
					continue
				for name in _move_options_in_spells(player, [i]):
					options[name] = player.color
					node_to_spell[name] = i
			if not options:
				return
			if player.ishuman:
				egress = {"type": "message",
				          "message": "Erupt: make a move into a 3- or 5-node spell where you have a stone.",
				          "awaiting": "node", "moveoptions": options}
				player.ws.send(json.dumps(egress))
				resp = None
				while resp not in options:
					resp = player.receivemessage()
			else:
				resp = next(iter(options))
			_place_into(player, player.board.nodes[resp])
			moves_left[node_to_spell[resp]] -= 1
			if player.board.gameover:
				return


class Gust(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "Pick up every enemy stone touching you, then place them on any empty nodes."

	def resolve(self, player):
		# Gust's own charm node was already cleared by cast(). Pick up every
		# enemy stone adjacent to one of our surviving stones.
		picked = []
		for name in player.board.nodes:
			node = player.board.nodes[name]
			if node.stone != player.enemy:
				continue
			if any(nb.stone == player.color for nb in node.neighbors):
				picked.append(node)
		if not picked:
			if player.ishuman:
				player.jmessage("No enemy stones touch you; Gust fizzles.")
			return
		for node in picked:
			node.stone = None
			if player.board.last_play == node.name:
				player.board.last_play = None
				player.board.last_player = None
		player.board.update()
		# Place them one at a time onto any empty node. The game may end
		# mid-relocation if these were the enemy's last stones — guard first.
		for i in range(len(picked)):
			if player.board.gameover:
				return
			empties = {n: player.enemy for n in player.board.nodes
			           if player.board.nodes[n].stone is None}
			if not empties:
				return
			if player.ishuman:
				egress = {"type": "message",
				          "message": "Place enemy stone {} of {} on an empty node.".format(i + 1, len(picked)),
				          "awaiting": "node", "moveoptions": empties}
				player.ws.send(json.dumps(egress))
				dest = None
				while dest is None:
					resp = player.receivemessage()
					if resp in empties:
						dest = player.board.nodes[resp]
			else:
				time.sleep(1)
				dest = player.board.nodes[next(iter(empties))]
			dest.stone = player.enemy
			anim = {"type": "new_stone_animation", "color": player.enemy, "node": dest.name}
			if player.ishuman:
				player.ws.send(json.dumps(anim))
			if player.opp.ishuman:
				player.opp.ws.send(json.dumps(anim))
			player.board.update()


class Storm_Front(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Destroy any 2 enemy stones."

	def resolve(self, player):
		_destroy_chosen(player, 2)


# BFS the enemy stones into contiguous groups (over node adjacency).
def _enemy_stone_groups(player):
	enemy = player.enemy
	visited = set()
	groups = []
	for name in player.board.nodes:
		start = player.board.nodes[name]
		if name in visited or start.stone != enemy:
			continue
		group = []
		stack = [start]
		visited.add(name)
		while stack:
			node = stack.pop()
			group.append(node)
			for nb in node.neighbors:
				if nb.name not in visited and nb.stone == enemy:
					visited.add(nb.name)
					stack.append(nb)
		groups.append(group)
	return groups


class Hurricane(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Destroy the smallest contiguous group of enemy stones."

	def resolve(self, player):
		groups = _enemy_stone_groups(player)
		if not groups:
			return
		min_size = min(len(g) for g in groups)
		smallest = [g for g in groups if len(g) == min_size]
		if len(smallest) == 1 or not player.ishuman:
			chosen = smallest[0]
		else:
			opts = {node.name: player.enemy for g in smallest for node in g}
			player.jmessage("Tie: choose a stone in the group to destroy.", "node")
			chosen = None
			while chosen is None:
				resp = player.receivemessage()
				if resp not in opts:
					continue
				for g in smallest:
					if any(node.name == resp for node in g):
						chosen = g
						break
		for node in chosen:
			node.stone = None
			if player.board.last_play == node.name:
				player.board.last_play = None
				player.board.last_player = None
		player.board.update()


class Splash(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "If you did not dash this turn, make 1 move."

	def resolve(self, player):
		player.move()


# Make `soft_count` soft moves, then `hard_count` hard moves (Torrent [1,1],
# Flood [2,2]). Soft-then-hard order is mandatory.
def _soft_hard_chain(player, spell, soft_count, hard_count):
	for _ in range(soft_count):
		if not player.allsoftmoveablenodes():
			break
		if player.ishuman:
			player.softmove()
		else:
			player.softmove(spell.position.copy())
		if player.board.gameover:
			return
	for _ in range(hard_count):
		if not player.allhardmoveablenodes():
			if player.ishuman:
				player.jmessage("No legal hard moves")
			break
		player.hardmove()
		if player.board.gameover:
			return


class Torrent(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Make 1 soft move, then 1 hard move."

	def resolve(self, player):
		_soft_hard_chain(player, self, 1, 1)


class Flood(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Make 2 soft moves, then 2 hard moves."

	def resolve(self, player):
		_soft_hard_chain(player, self, 2, 2)


###############################################################################################
#####  EXPANSION SPELLS: Gloom + Covenant


# Helper: destroy every enemy stone touching 2+ empty nodes. Membership is
# computed against the pre-destruction board, then applied simultaneously.
def _destroy_exposed(player):
	doomed = []
	for name in player.board.nodes:
		node = player.board.nodes[name]
		if node.stone != player.enemy:
			continue
		empties = sum(1 for nb in node.neighbors if nb.stone is None)
		if empties >= 2:
			doomed.append(node)
	for node in doomed:
		node.stone = None
		if player.board.last_play == node.name:
			player.board.last_play = None
			player.board.last_player = None
	player.board.update()


# Helper: caster destroys `count` enemy stones of their choice (one at a time).
# The AI fallback greedily destroys the first available enemy stone.
def _destroy_chosen(player, count):
	for i in range(count):
		enemies = [n for n in player.board.nodes
		           if player.board.nodes[n].stone == player.enemy]
		if not enemies:
			return
		if player.ishuman:
			player.jmessage("Choose an enemy stone to destroy ({} of {}).".format(i + 1, count), "node")
			node = None
			while node is None:
				resp = player.receivemessage()
				if resp not in player.board.nodes:
					continue
				cand = player.board.nodes[resp]
				if cand.stone == player.enemy:
					node = cand
		else:
			time.sleep(1)
			node = player.board.nodes[enemies[0]]
		node.stone = None
		if player.board.last_play == node.name:
			player.board.last_play = None
			player.board.last_player = None
		player.board.update()
		if player.board.gameover:
			return


class Decay(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Destroy all enemy stones touching 2 or more empty nodes."

	def resolve(self, player):
		_destroy_exposed(player)


class Corrupt(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "Choose up to 3 enemy stones touching your stones. Convert them to your color, then sacrifice a stone."

	def resolve(self, player):
		### Eligible targets: enemy stones touching one of the caster's stones.
		### Computed ONCE, against the board as it stands when Corrupt is cast,
		### so conversions cannot chain — a stone that only touches a freshly
		### converted stone (and no original caster stone) is never eligible.
		eligible = []
		for nodename in player.board.nodes:
			node = player.board.nodes[nodename]
			if node.stone == player.enemy and any(
					nb.stone == player.color for nb in node.neighbors):
				eligible.append(nodename)

		converted = []

		if player.ishuman:
			while len(converted) < 3:
				remaining = {n: player.color for n in eligible
				             if n not in converted
				             and player.board.nodes[n].stone == player.enemy}
				if not remaining:
					break
				egress = {"type": "message",
				          "message": "Choose up to 3 enemy stones to convert "
				                     "({} of 3), or End Turn to finish.".format(len(converted) + 1),
				          "awaiting": "node", "moveoptions": remaining,
				          "actionlist": ["pass"]}
				player.ws.send(json.dumps(egress))

				actualmessage = player.receivemessage()
				### "End Turn"/pass or any non-option finishes the selection.
				if actualmessage not in remaining:
					break
				node = player.board.nodes[actualmessage]
				node.stone = player.color
				converted.append(actualmessage)

				anim = {"type": "new_stone_animation", "color": player.color, "node": node.name}
				player.ws.send(json.dumps(anim))
				if player.opp.ishuman:
					player.opp.ws.send(json.dumps(anim))

				player.board.update()
				if player.board.gameover:
					return
		else:
			### Bot: greedily convert the first (up to 3) eligible stones.
			for nodename in eligible:
				if len(converted) >= 3:
					break
				node = player.board.nodes[nodename]
				if node.stone != player.enemy:
					continue
				node.stone = player.color
				converted.append(nodename)
				anim = {"type": "new_stone_animation", "color": player.color, "node": node.name}
				if player.opp.ishuman:
					player.opp.ws.send(json.dumps(anim))
				player.board.update()
				time.sleep(1)
				if player.board.gameover:
					return

		### Sacrifice cost. Mirrors Fireblast: paid regardless of how many
		### stones were converted, but skipped if converting the enemy's last
		### stone already ended the game, or the caster has no stones left.
		player.board.update()
		if player.board.gameover:
			return
		has_own_stone = any(
			player.board.nodes[n].stone == player.color
			for n in player.board.nodes
		)
		if not has_own_stone:
			return

		if player.ishuman:
			while True:
				player.jmessage("Sacrifice a stone.", "node")

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					node = player.board.nodes[actualmessage]
					if node.stone != player.color:
						continue
					node.stone = None
					if (player.board.last_play == node.name):
						player.board.last_play = None
						player.board.last_player = None
					player.board.update()
					break
		else:
			### Bot: sacrifice the lowest-priority own stone.
			time.sleep(1)
			for name in reversed(player.priority_order):
				node = player.board.nodes[name]
				if node.stone == player.color:
					node.stone = None
					if (player.board.last_play == node.name):
						player.board.last_play = None
						player.board.last_player = None
					player.board.update()
					time.sleep(1)
					break


class Lurk(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "Make 1 move into a 1-node spell or a node outside of a spell."

	def resolve(self, player):
		# Any soft-or-hard move onto a node that is NOT part of a 3- or 5-node
		# spell (positions 1..6). 1-node spells and non-spell nodes are allowed.
		big = set()
		for i in range(1, 7):
			for node in player.board.positions[i]:
				big.add(node.name)
		options = {}
		for name in player.board.nodes:
			if name in big:
				continue
			node = player.board.nodes[name]
			if node.stone == player.color:
				continue
			if any(nb.stone == player.color for nb in node.neighbors):
				options[name] = player.color
		if not options:
			if player.ishuman:
				player.jmessage("No legal move outside 3- and 5-node spells.")
			return
		if player.ishuman:
			egress = {"type": "message",
			          "message": "Make 1 move (not into a 3- or 5-node spell).",
			          "awaiting": "node", "moveoptions": options}
			player.ws.send(json.dumps(egress))
			while True:
				resp = player.receivemessage()
				if resp not in options:
					continue
				_place_into(player, player.board.nodes[resp])
				break
		else:
			node_name = next(iter(options))
			_place_into(player, player.board.nodes[node_name])


class Seal_of_Winter(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True
		self.static = True

		self.text = "STATIC: Your opponent cannot cast 1-node spells (charms)."


class Seal_of_Stone(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.static = True

		self.text = "STATIC: Your opponent's first move each turn must be soft."


class Seal_of_Destruction(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.static = True

		self.text = ("STATIC: If filled at the end of your turn, destroy all enemy "
		             "stones touching you. If filled at the start of your turn, you lose.")


class Fissure(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.text = ("Choose a target node. It is permanently destroyed: its stone is "
			"removed and it becomes an impassable void that stones cannot move into, "
			"retreat into, or be pushed through, disabling any spell that includes it. "
			"Also destroy all enemy stones on adjacent nodes.")

	def resolve(self, player):
		if player.ishuman:
			player.jmessage("Choose a target node for Fissure.", "node")
			target_name = None
			while target_name is None:
				resp = player.receivemessage()
				### A node already destroyed (a wall) is not a legal target.
				if resp in player.board.nodes and player.board.nodes[resp].stone != 'X':
					target_name = resp
		else:
			time.sleep(1)
			### Greedy: pick the target with the greatest net stone-count
			### advantage. Target term: +1 enemy / 0 empty / -1 own. Blast
			### term: +1 per adjacent enemy stone (also destroyed).
			best_score = None
			best_target = 'a1'
			for node_name in player.board.nodes:
				node = player.board.nodes[node_name]
				if node.stone == 'X':
					continue
				if node.stone == player.enemy:
					score = 1
				elif node.stone == player.color:
					score = -1
				else:
					score = 0
				for nb in node.neighbors:
					if nb.stone == player.enemy:
						score += 1
				if best_score is None or score > best_score:
					best_score = score
					best_target = node_name
			target_name = best_target

		node = player.board.nodes[target_name]
		### Adjacent nodes: destroy enemy stones only (revert to normal empty).
		for nb in node.neighbors:
			if nb.stone == player.enemy:
				nb.stone = None
				if player.board.last_play == nb.name:
					player.board.last_play = None
					player.board.last_player = None
		### Target node: permanently destroyed (a wall), regardless of occupant.
		node.stone = 'X'
		if player.board.last_play == target_name:
			player.board.last_play = None
			player.board.last_player = None

		### Ambush: the blast also destroys enemy-of-caster snares on the
		### target and adjacent nodes, just as it destroys enemy stones
		### there. The caster's own snares in the radius survive (a wall
		### over your own snare leaves it intact-but-inert).
		for sn in [target_name] + [nb.name for nb in node.neighbors]:
			if player.board.snares.get(sn) == player.enemy:
				del player.board.snares[sn]

		player.board.update()


class Rock_Slide(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.text = "Push any enemy stones adjacent to you 1 space. (Order is chosen by the casting player.) If a stone is pushed to an occupied space, the stone previously occupying that space is crushed."

	def resolve(self, player):
		safety = 0
		while safety < 50:
			safety += 1
			adjacent_enemy_nodes = []
			for node_name in player.board.nodes:
				node = player.board.nodes[node_name]
				if node.stone == player.enemy:
					has_caster_nb = any(nb.stone == player.color for nb in node.neighbors)
					if has_caster_nb:
						adjacent_enemy_nodes.append(node_name)

			if not adjacent_enemy_nodes:
				break

			if player.ishuman:
				player.jmessage("Choose an adjacent enemy stone to push.", "node")
				chosen_from = None
				while chosen_from is None:
					resp = player.receivemessage()
					if resp in adjacent_enemy_nodes:
						chosen_from = resp

				player.jmessage(f"Choose where to push the stone at {chosen_from}.", "node")
				target_to = None
				node = player.board.nodes[chosen_from]
				valid_neighbors = [nb.name for nb in node.neighbors]
				while target_to is None:
					resp = player.receivemessage()
					if resp in valid_neighbors:
						target_to = resp
			else:
				time.sleep(1)
				best_from = None
				best_to = None
				best_score = -9999
				for source in adjacent_enemy_nodes:
					stone_color = player.board.nodes[source].stone
					neighbors = [nb.name for nb in player.board.nodes[source].neighbors]
					for nb_name in neighbors:
						occ = player.board.nodes[nb_name].stone
						score = 0
						if occ is None:
							score = 10
						elif occ == player.enemy:
							if stone_color == player.color:
								score = 5
							else:
								score = 20
						elif occ == player.color:
							if stone_color == player.color:
								score = -50
							else:
								score = -100
						if score > best_score:
							best_score = score
							best_from = source
							best_to = nb_name
				if best_from is not None:
					chosen_from = best_from
					target_to = best_to
				else:
					chosen_from = adjacent_enemy_nodes[0]
					target_to = player.board.nodes[chosen_from].neighbors[0].name

			stone_color = player.board.nodes[chosen_from].stone
			occupant = player.board.nodes[target_to].stone

			player.board.nodes[chosen_from].stone = None
			if occupant is not None:
				if player.ishuman:
					player.jmessage("Stone crushed!")
				if player.opp.ishuman:
					player.opp.jmessage("Stone crushed!")

			player.board.nodes[target_to].stone = stone_color

			player.board.update()
			if player.board.gameover:
				break


class Bulwark(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True
		self.static = True
		self.text = "STATIC: Stones in your locked spell cannot be targeted by enemy hard moves."


class _ScheduleMovesSpell(Spell):
	### Providence base: schedule 1 extra move at the beginning of each of
	### the caster's next TURNS turns. Pending stones count toward the
	### caster's stone count asymmetrically (defense only) in the ±3-lead
	### check, but SYMMETRICALLY in the sixth-spell count (2026-08 playtest
	### ruling) — see Board.pending_stones / eot_triggers.
	TURNS = 1

	def resolve(self, player):
		sched = self.board.pending_moves[player.color]
		while len(sched) < self.TURNS:
			sched.append(0)
		for i in range(self.TURNS):
			sched[i] += 1
		if self.TURNS == 1:
			effect = "1 extra move at the beginning of your next turn"
			opp_effect = "1 extra move at the beginning of their next turn"
		else:
			effect = ("1 extra move at the beginning of each of your next {} turns"
			          .format(self.TURNS))
			opp_effect = ("1 extra move at the beginning of each of their next {} turns"
			              .format(self.TURNS))
		if player.ishuman:
			player.jmessage("You will make " + effect + ".")
		if player.opp.ishuman:
			pname = player.color[0].upper() + player.color[1:]
			player.opp.jmessage(pname + " will make " + opp_effect + ".")
		self.board.update()


class Dividend(_ScheduleMovesSpell):
	TURNS = 1

	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True
		self.text = "Make 1 extra move at the beginning of your next turn."


class Annuity(_ScheduleMovesSpell):
	TURNS = 2

	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.text = "Make 1 extra move at the beginning of each of your next 2 turns."


class Endowment(_ScheduleMovesSpell):
	TURNS = 4

	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.text = "Make 1 extra move at the beginning of each of your next 4 turns."


class _ScheduleBurnsSpell(Spell):
	### Aftershock base: schedule 1 burn (destroy 1 enemy stone touching
	### you, your choice) at the beginning of each of the caster's next
	### TURNS turns. The CAST only schedules — the burn PROMPT runs at
	### start of turn in Player.taketurn. Burns are not score/win
	### material; fizzled burns are lost. Burns ignore Bulwark
	### (destruction convention, like Fireblast).
	TURNS = 1

	def resolve(self, player):
		sched = self.board.pending_burns[player.color]
		while len(sched) < self.TURNS:
			sched.append(0)
		for i in range(self.TURNS):
			sched[i] += 1
		if self.TURNS == 1:
			effect = "destroy 1 enemy stone touching you at the beginning of your next turn"
			opp_effect = "destroy 1 of your stones touching them at the beginning of their next turn"
		else:
			effect = ("destroy 1 enemy stone touching you at the beginning of each of "
			          "your next {} turns".format(self.TURNS))
			opp_effect = ("destroy 1 of your stones touching them at the beginning of each of "
			              "their next {} turns".format(self.TURNS))
		if player.ishuman:
			player.jmessage("You will " + effect + ".")
		if player.opp.ishuman:
			pname = player.color[0].upper() + player.color[1:]
			player.opp.jmessage(pname + " will " + opp_effect + ".")
		self.board.update()


class Ember(_ScheduleBurnsSpell):
	TURNS = 1

	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True
		self.text = "Destroy 1 enemy stone touching your stones at the beginning of your next turn."


class Smolder(_ScheduleBurnsSpell):
	TURNS = 2

	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.text = "Destroy 1 enemy stone touching your stones at the beginning of each of your next 2 turns."


class Conflagration(_ScheduleBurnsSpell):
	TURNS = 4

	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.text = "Destroy 1 enemy stone touching your stones at the beginning of each of your next 4 turns."


### Ambush placement ranking — mirror of SimBoard._snare_candidates on
### Node-object boards: empty, snare-free, non-wall nodes ranked by
### likelihood an enemy stone comes to rest there (2 per adjacent enemy
### stone, +2 inside a sigil the enemy is charging, +1 on a mana node).
### Descending score, NODE_ORDER tiebreak via stable sort.
_POSITION_OF_NODE = {}
for _pos, _pnodes in POSITIONS.items():
	for _n in _pnodes:
		_POSITION_OF_NODE[_n] = _pos


def _rank_snare_nodes(board, color, enemy):
	out = []
	for name in NODE_ORDER:
		node = board.nodes[name]
		if node.stone is not None or name in board.snares:
			continue
		score = 2 * sum(1 for nb in node.neighbors if nb.stone == enemy)
		if name in ('a1', 'b1', 'c1'):
			score += 1
		pos = _POSITION_OF_NODE.get(name)
		if pos is not None:
			pnodes = [board.nodes[x] for x in POSITIONS[pos]]
			if (any(x.stone == enemy for x in pnodes)
					and not any(x.stone == color for x in pnodes)):
				score += 2
		out.append((score, name))
	out.sort(key=lambda t: -t[0])   # stable => NODE_ORDER tiebreak
	return out


class _PlaceSnaresSpell(Spell):
	### Ambush base: place snares on up to COUNT empty, snare-free,
	### non-wall nodes. A snare destroys the first enemy-of-owner stone
	### that comes to rest on it (stone destroyed, snare consumed — the
	### consumption itself lives in board.update()); the owner's own
	### stones coexist with it, and nothing else removes it except
	### Fissure's blast. Snares count toward the owner's stone count
	### defensively (like Providence phantoms), never toward the owner's
	### own win claims.
	COUNT = 1

	def resolve(self, player):
		placed = 0
		if player.ishuman:
			while placed < self.COUNT:
				eligible = {n: player.color for n in NODE_ORDER
				            if player.board.nodes[n].stone is None
				            and n not in player.board.snares}
				if not eligible:
					break
				egress = {"type": "message",
				          "message": "Place a snare on an empty node "
				                     "({} of {}), or End Turn to stop.".format(placed + 1, self.COUNT),
				          "awaiting": "node", "moveoptions": eligible,
				          "actionlist": ["pass"]}
				player.ws.send(json.dumps(egress))

				actualmessage = player.receivemessage()
				### "End Turn"/pass or any non-option stops placement early
				### ("up to N" — remaining snares are declined, not owed).
				if actualmessage not in eligible:
					break
				player.board.snares[actualmessage] = player.color
				player.board.record('snare', node=actualmessage)
				placed += 1
				player.board.update()
		else:
			### Bot: greedy top-N by the shared ranking, stopping at zero
			### score (don't waste snares on dead corners).
			time.sleep(1)
			for score, nodename in _rank_snare_nodes(player.board, player.color, player.enemy):
				if placed >= self.COUNT or score <= 0:
					break
				player.board.snares[nodename] = player.color
				player.board.record('snare', node=nodename)
				placed += 1
			player.board.update()


class Tripwire(_PlaceSnaresSpell):
	COUNT = 1

	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True
		self.text = ("Place a snare on an empty node. The next enemy stone that comes to rest "
			"there is destroyed. Your own stones may stand on your snares. Snares count toward "
			"your stone count while they remain, but cannot win you the game.")


class Deadfall(_PlaceSnaresSpell):
	COUNT = 2

	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.text = ("Place snares on up to 2 empty nodes. The next enemy stone that comes to rest "
			"on a snare is destroyed. Your own stones may stand on your snares. Snares count toward "
			"your stone count while they remain, but cannot win you the game.")


class Minefield(_PlaceSnaresSpell):
	COUNT = 4

	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.text = ("Place snares on up to 4 empty nodes. The next enemy stone that comes to rest "
			"on a snare is destroyed. Your own stones may stand on your snares. Snares count toward "
			"your stone count while they remain, but cannot win you the game.")
