
import json
import time


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
				node.stone = None
				if (player.board.last_play == node.name):
					player.board.last_play = None
					player.board.last_player = None

		else:
			for node in self.position:
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

		self.text = "Make 1 move into each 3-node and 5-node spell, including this one."

	def resolve(self, player):
		# Positions 1..6 INCLUDING Erupt's own slot. Skip a spell that has no
		# legal target (per-spell, not a whole-spell abort).
		for i in range(1, 7):
			options = _move_options_in_spells(player, [i])
			if not options:
				continue
			if player.ishuman:
				egress = {"type": "message",
				          "message": "Make 1 move into this 3-node or 5-node spell ({}/6).".format(i),
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
		for i in range(2):
			enemies = [n for n in player.board.nodes
			           if player.board.nodes[n].stone == player.enemy]
			if not enemies:
				return
			if player.ishuman:
				player.jmessage("Choose an enemy stone to destroy ({} of 2).".format(i + 1), "node")
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





# class Winter(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)
# 		self.ischarm = True
# 		self.static = True

# 		self.text = "<b>Winter</b><br /><span style='color:BlueViolet;'>Static Charm</span><br />Your opponent cannot cast charms.<br />(Static charms still work.)"


# class Spring(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)
# 		self.ischarm = True
# 		self.static = True

# 		self.text = "<b>Spring</b><br /><span style='color:BlueViolet;'>Static Charm</span><br />You may cast your locked spells 1<br />additional time. (Then they are<br />Spring-locked until your lock moves.)"



# class Autumn(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)
# 		self.ischarm = True
# 		self.static = True

# 		self.text = "<b>Autumn</b><br /><span style='color:BlueViolet;'>Static Charm</span><br />Your opponent cannot dash."








# class Gust(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)
# 		self.ischarm = True

# 		self.text = "<b>Gust</b><br /><span style='color:BlueViolet;'>Charm</span><br />Relocate all enemy stones<br />which are touching you<br />into any empty nodes."


# 	def resolve(self, player):
# 		gustingstonecount = 0
# 		for name in player.board.nodes:
# 			node = player.board.nodes[name]
# 			if node.stone == player.enemy:
# 				already_gusted = False
# 				for neighbor in node.neighbors:
# 					if neighbor.stone == player.color:
# 						if not already_gusted:
# 							gustingstonecount += 1
# 							already_gusted = True
# 						node.stone = None
# 						if (player.board.last_play == node.name):
# 							player.board.last_play = None
# 							player.board.last_player = None
							
# 		player.board.update()

# 		while gustingstonecount > 0:
# 			player.jmessage("Where would you like to Gust the enemy stone?", "node")

# 			actualmessage = player.receivemessage()

# 			if actualmessage in player.board.nodes:
# 				node = player.board.nodes[actualmessage]
# 				if node.stone != None:
# 					player.jmessage("Invalid selection")
# 					continue

# 				gustingstonecount -= 1
# 				node.stone = player.enemy
# 				player.board.update()

# 			else:
# 				continue












# class Thunder(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)

# 		self.text = "<b>Thunder</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Destroy 2 enemy stones that<br />are touching each other."

# 	def resolve(self, player):

# 		egress = {"type": "selectingNoButton"}
# 		player.ws.send(json.dumps(egress))

# 		while True:
# 			player.jmessage("Select an enemy stone to destroy.", "node")

# 			actualmessage = player.receivemessage()

# 			if actualmessage in player.board.nodes:
# 				node = player.board.nodes[actualmessage]

# 				if node.stone != player.enemy:
# 					player.jmessage("Invalid selection")
# 					continue

# 				validstone = False

# 				for neighbor in node.neighbors:
# 					if neighbor.stone == player.enemy:
# 						validstone = True

# 				if validstone:
# 					node.stone = None
# 					player.board.update()
# 					break

# 				else:
# 					player.jmessage("Invalid selection")
# 					continue

# 			else:
# 				continue

# 		while True:
# 			player.jmessage("Select an adjacent enemy stone to destroy.", "node")

# 			actualmessage = player.receivemessage()

# 			if actualmessage in player.board.nodes:
# 				node2 = player.board.nodes[actualmessage]

# 				if node2.stone != player.enemy:
# 					player.jmessage("Invalid selection")
# 					continue

# 				validstone = False
# 				for neighbor in node2.neighbors:
# 					if neighbor == node:
# 						validstone = True

# 				if not validstone:
# 					player.jmessage("Invalid selection")
# 					continue

# 				else:
# 					node2.stone = None
# 					player.board.update()
# 					break

# 			else:
# 				continue
# class Eclipse(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)
# 		self.ischarm = True

# 		self.text = "<b>Eclipse</b><br /><span style='color:BlueViolet;'>Charm</span><br />Make 1 move that finishes<br />filling a spell with your stones."


# 	def resolve(self, player):
		
# 		while True:
# 			player.jmessage("Where would you like to move?", "node")

# 			actualmessage = player.receivemessage()

# 			if actualmessage in player.board.nodes:
# 				node = player.board.nodes[actualmessage]

# 				if node.stone == player.color:
# 					player.jmessage("Invalid option")
# 					continue

# 				adjacent = False
# 				for neighbor in node.neighbors:
# 					if neighbor.stone == player.color:
# 						adjacent = True
# 				if not adjacent:
# 					player.jmessage("Invalid option")
# 					continue

# 				spell = None
# 				for s in player.board.spells:
# 					for n in s.position:
# 						if node == n:
# 							spell = s
# 				if spell == None:
# 					player.jmessage("Invalid option")
# 					continue
# 				not_controlled_count = 0
# 				for n in spell.position:
# 					if n.stone != player.color:
# 						not_controlled_count += 1
# 				if not_controlled_count != 1:
# 					player.jmessage("Invalid option")
# 					continue

# 				if node.stone == None:
# 					node.stone = player.color
# 					player.board.last_play = node.name
# 					player.board.last_player = player.color
# 					player.board.update()
# 					break
# 				else:
# 					player.pushenemy(node)
# 					break


# class Full_Moon(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)

# 		self.text = "<b>Full Moon</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Make 2 moves that finish<br />filling a spell with your stones."


# 	def resolve(self, player):
		
# 		while True:
# 			player.jmessage("Where would you like to move?", "node")

# 			actualmessage = player.receivemessage()

# 			if actualmessage in player.board.nodes:
# 				node = player.board.nodes[actualmessage]

# 				if node.stone == player.color:
# 					player.jmessage("Invalid option")
# 					continue

# 				adjacent = False
# 				for neighbor in node.neighbors:
# 					if neighbor.stone == player.color:
# 						adjacent = True
# 				if not adjacent:
# 					player.jmessage("Invalid option")
# 					continue

# 				spell = None
# 				for s in player.board.spells:
# 					for n in s.position:
# 						if node == n:
# 							spell = s
# 				if spell == None:
# 					player.jmessage("Invalid option")
# 					continue
# 				not_controlled_count = 0
# 				for n in spell.position:
# 					if n.stone != player.color:
# 						not_controlled_count += 1
# 				if not_controlled_count != 2:
# 					player.jmessage("Invalid option")
# 					continue

# 				if node.stone == None:
# 					node.stone = player.color
# 					player.board.last_play = node.name
# 					player.board.last_player = player.color
# 					player.board.update()
# 					break
# 				else:
# 					player.pushenemy(node)
# 					break
# 		while True:
# 			player.jmessage("Where would you like to move?", "node")

# 			actualmessage = player.receivemessage()

# 			if actualmessage in player.board.nodes:
# 				node = player.board.nodes[actualmessage]

# 				if node not in spell.position:
# 					player.jmessage("Invalid option")
# 					continue

# 				if node.stone == player.color:
# 					player.jmessage("Invalid option")
# 					continue

# 				if node.stone == None:
# 					node.stone = player.color
# 					player.board.last_play = node.name
# 					player.board.last_player = player.color
# 					player.board.update()
# 					break
# 				else:
# 					player.pushenemy(node)
# 					break

# class Gather(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)

# 		self.text = "<b>Gather</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Make 3 moves into locked spells."


# 	def resolve(self, player):

# 		egress = {"type": "selecting"}
# 		player.ws.send(json.dumps(egress))

# 		moves_remaining = 3
# 		while moves_remaining > 0:
# 			player.jmessage("Move into a locked spell, or press Done.", "node")

# 			actualmessage = player.receivemessage()

# 			if actualmessage == 'doneselecting':
# 				break

# 			elif actualmessage in player.board.nodes:
# 				node = player.board.nodes[actualmessage]

# 				adjacent = False
# 				for neighbor in node.neighbors:
# 					if neighbor.stone == player.color:
# 						adjacent = True
# 				if not adjacent:
# 					player.jmessage("Invalid option")
# 					continue

# 				if node.stone == player.color:
# 					player.jmessage("Invalid option")
# 					continue

# 				locknodes = []
# 				if player.lock != None:
# 					locknodes += player.lock.position
# 				if player.opp.lock != None:
# 					locknodes += player.opp.lock.position

# 				if node not in locknodes:
# 					player.jmessage("You must move in a locked spell.")
# 					continue
# 				if node.stone == None:
# 					moves_remaining -= 1
# 					node.stone = player.color
# 					player.board.last_play = node.name
# 					player.board.last_player = player.color
# 					player.board.update()
# 					continue
# 				if node.stone == player.enemy:
# 					moves_remaining -= 1
# 					player.pushenemy(node)
# 					continue

# 		egress = {"type": "doneselecting"}
# 		player.ws.send(json.dumps(egress))


# class Scatter(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)

# 		self.text = "<b>Scatter</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Make 1 soft blink move<br />into each charm."


# 	def resolve(self, player):
# 		charms = player.board.positions[7] + player.board.positions[8] + player.board.positions[9]
# 		for node in charms:
# 			if node.stone == None:
# 				node.stone = player.color



# class Gravity(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)
# 		self.static = True

# 		self.text = "<b>Gravity</b><br /><span style='color:BlueViolet;'>Static Sorcery</span><br />Your opponent's standard move<br />each turn must be soft."





# class Fury(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)

# 		self.text = "<b>Fury</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Make 2 hard moves."

# 	def resolve(self, player):
# 		for i in range(2):
# 			player.hardmove()







# class Syzygy(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)

# 		self.text = "<b>Syzygy</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Make 3 blink moves into the Sorcery<br />across the board from Syzygy, then<br />1 into the Charm."

# 	def resolve(self, player):
# 		myposition = self.name[-1:]
# 		if myposition == '1':
# 			sorcerynodes = player.board.positions[5]
# 			charmnode = player.board.positions[8][0]
# 		elif myposition == '2':
# 			sorcerynodes = player.board.positions[6]
# 			charmnode = player.board.positions[9][0]
# 		elif myposition == '3':
# 			sorcerynodes = player.board.positions[4]
# 			charmnode = player.board.positions[7][0]

# 		while True:
# 			sorcery_full = True
# 			for node in sorcerynodes:
# 				if (node.stone != player.color):
# 					sorcery_full = False
# 			if sorcery_full:
# 				break
# 			else:
# 				player.jmessage("Blink into the sorcery.", "node")

# 				actualmessage = player.receivemessage()

# 				if actualmessage in player.board.nodes:
# 					node = player.board.nodes[actualmessage]
# 					if node not in sorcerynodes:
# 						player.jmessage("Invalid selection")
# 						continue
# 					if node.stone == player.color:
# 						continue
# 					if node.stone == None:
# 						node.stone = player.color
# 						player.board.update()
# 						continue
# 					if node.stone == player.opp.color:
# 						player.pushenemy(node)
# 						continue
# 		if charmnode.stone == player.color:
# 			return
# 		else:
# 			while True:
# 				player.jmessage("Blink into the charm.", "node")

# 				actualmessage = player.receivemessage()

# 				if actualmessage in player.board.nodes:
# 					node = player.board.nodes[actualmessage]
# 					if node != charmnode:
# 						player.jmessage("Invalid selection")
# 						continue
# 					if node.stone == None:
# 						node.stone = player.color
# 						player.board.update()
# 						return
# 					if node.stone == player.opp.color:
# 						player.pushenemy(node)
# 						return





# class Tempest(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)

# 		self.text = "<b>Tempest</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Destroy all connected groups<br />of enemy stones that are not<br />connected to mana."

# 	def resolve(self, player):

# 		safe_enemies = []
# 		for nodename in ['a1', 'b1', 'c1']:
# 			if player.board.nodes[nodename].stone == player.opp.color:
# 				safe_enemies.append(nodename)
# 		while True:
# 			new_safe_enemies = []
# 			for nodename in safe_enemies:
# 				neighbors = player.board.nodes[nodename].neighbors
# 				for neighbor in neighbors:
# 					if (neighbor.stone == player.opp.color) and (neighbor.name not in safe_enemies):
# 						new_safe_enemies.append(neighbor.name)
# 			if len(new_safe_enemies) == 0:
# 				break
# 			for new_safe_enemy in new_safe_enemies:
# 				if new_safe_enemy not in safe_enemies:
# 					safe_enemies.append(new_safe_enemy)
# 		for nodename in player.board.nodes:
# 			if player.board.nodes[nodename].stone == player.opp.color:
# 				if nodename not in safe_enemies:
# 					player.board.nodes[nodename].stone = None
# 		player.board.update()

# class Harvest(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)

# 		self.text = "<b>Harvest</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Make 5 moves into locked spells<br />or into Harvest."


# 	def resolve(self, player):

# 		egress = {"type": "selecting"}
# 		player.ws.send(json.dumps(egress))

# 		moves_remaining = 5
# 		while moves_remaining > 0:
# 			player.jmessage("Move into a locked spell or Harvest, or press Done.", "node")

# 			actualmessage = player.receivemessage()

# 			if actualmessage == 'doneselecting':
# 				break

# 			elif actualmessage in player.board.nodes:
# 				node = player.board.nodes[actualmessage]

# 				adjacent = False
# 				for neighbor in node.neighbors:
# 					if neighbor.stone == player.color:
# 						adjacent = True
# 				if not adjacent:
# 					player.jmessage("Invalid option")
# 					continue

# 				if node.stone == player.color:
# 					player.jmessage("Invalid option")
# 					continue

# 				allowednodes = []
# 				if player.lock != None:
# 					allowednodes += player.lock.position
# 				if player.opp.lock != None:
# 					allowednodes += player.opp.lock.position
# 				allowednodes += self.position

# 				if node not in allowednodes:
# 					player.jmessage("Invalid selection")
# 					continue
# 				if node.stone == None:
# 					moves_remaining -= 1
# 					node.stone = player.color
# 					player.board.last_play = node.name
# 					player.board.last_player = player.color
# 					player.board.update()
# 					continue
# 				if node.stone == player.enemy:
# 					moves_remaining -= 1
# 					player.pushenemy(node)
# 					continue

# 		egress = {"type": "doneselecting"}
# 		player.ws.send(json.dumps(egress))


# class Blossom(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)

# 		self.text = "<b>Blossom</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Make 1 soft blink move into<br />each other Ritual and Sorcery."

# 	def resolve(self, player):

# 		blossomablespells = []

# 		for spell in player.board.spells[:6]:
# 			if spell != self:
# 				for node in spell.position:
# 					if node.stone == None:
# 						blossomablespells.append(spell)
# 						break
# 		while len(blossomablespells) > 0:
# 			player.jmessage("Make a soft blink.", "node")

# 			actualmessage = player.receivemessage()

# 			if actualmessage in player.board.nodes:
# 				node = player.board.nodes[actualmessage]

# 				if node.stone != None:
# 					player.jmessage("Invalid option")
# 					continue

# 				for spell in blossomablespells:
# 					if node in spell.position:
# 						node.stone = player.color
# 						blossomablespells.remove(spell)
# 						player.board.update()

		



# class Inferno(Spell):
# 	def __init__(self, board, position, name):
# 		super().__init__(board, position, name)

# 		self.static = True

# 		self.text = "<b>Inferno</b><br /><span style='color:BlueViolet;'>Static Ritual</span><br />At the end of your turn, destroy all<br />enemy stones which are touching you.<br />At the start of your turn,<br />you lose the game."




######################################################################################
#####  ACTUAL SPELLS FINISHED
