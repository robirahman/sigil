
import json


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
		player.jmessage(pname + " casts " + self.name)
		player.opp.jmessage(pname + " casts " + self.name)
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
				player.jmessage("You get to keep {} stones in ".format(refills)
							   + self.name + ".")
			elif refills == 1:
				player.jmessage("You get to keep 1 stone in " + self.name + ".")

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
			
		self.board.update()
		self.resolve(player)

		### Update the score on board
		self.board.update(True)

		if not self.ischarm:
			if player.lock == self:
				player.springlock = self
				pname = player.color[0].upper() + player.color[1:]
				player.jmessage(self.name + " is Springlocked for " + pname)
				player.opp.jmessage(self.name + " is Springlocked for " + pname)
			else:
				player.lock = self
				player.springlock = None
			player.countdown -= 1

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

		self.text = "<b>Sprout</b><br /><span style='color:BlueViolet;'>Charm</span><br />Make 1 soft move."


	def resolve(self, player):
		player.softmove()


class Spreading_Ivy(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Spreading Ivy</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Make 2 soft moves."

	def resolve(self, player):
		for i in range(2):
			player.softmove()


class Creeping_Vines(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Creeping Vines</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Make 4 soft moves."

	def resolve(self, player):
		for i in range(4):
			player.softmove()


class Spark(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "<b>Spark</b><br /><span style='color:BlueViolet;'>Charm</span><br />Make 1 hard move."


	def resolve(self, player):
		player.hardmove()


class Searing_Wind(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Searing Wind</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Destroy all enemy stones<br />which are touching you."

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


class Flame_Front(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Flame Front</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Make 4 hard moves."

	def resolve(self, player):
		for i in range(4):
			player.hardmove()



class Frost(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "<b>Frost</b><br /><span style='color:BlueViolet;'>Charm</span><br />Make 1 move if you did<br />not dash this turn."


	def resolve(self, player):
		player.move()


class Hail_Storm(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Hail Storm</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Destroy 1 enemy stone in each spell."

	def resolve(self, player):

		egress = {"type": "selecting"}
		player.ws.send(json.dumps(egress))

		hailablespells = []
		### We will use the notation of board.positions to refer to spells.
		### That is, 1,2,3 are the majors, 4,5,6 are the minors, 7,8,9 charms.

		for i in range(1,10):
			innernodelist = player.board.positions[i]
			for node in innernodelist:
				if node.stone == player.enemy:
					hailablespells.append(i)
					break

		while len(hailablespells) > 0:
			player.jmessage("Select an enemy stone to destroy, or press Done if you are done selecting.", "node")

			actualmessage = player.receivemessage()

			if actualmessage == 'doneselecting':
				break

			elif actualmessage in player.board.nodes:
				node = player.board.nodes[actualmessage]

				if node.stone != player.enemy:
					player.jmessage("Invalid selection")
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
						continue

				player.jmessage("Invalid selection")
				continue
				
			else:
				continue

		egress = {"type": "doneselecting"}
		player.ws.send(json.dumps(egress))


class Ice_Mirror(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Ice Mirror</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Choose 2 enemy stones touching each other.<br />Convert them to your color."

	def resolve(self, player):

		egress = {"type": "selectingNoButton"}
		player.ws.send(json.dumps(egress))

		while True:
			player.jmessage("Select an enemy stone to convert.", "node")

			actualmessage = player.receivemessage()

			if actualmessage in player.board.nodes:
				node = player.board.nodes[actualmessage]

				if node.stone != player.enemy:
					player.jmessage("Invalid selection")
					continue

				validstone = False

				for neighbor in node.neighbors:
					if neighbor.stone == player.enemy:
						validstone = True

				if validstone:
					node.stone = player.color
					player.board.update()
					break

				else:
					player.jmessage("Invalid selection")
					continue

			else:
				continue

		while True:
			player.jmessage("Select an adjacent enemy stone to convert.", "node")

			actualmessage = player.receivemessage()

			if actualmessage in player.board.nodes:
				node2 = player.board.nodes[actualmessage]

				if node2.stone != player.enemy:
					player.jmessage("Invalid selection")
					continue

				validstone = False
				for neighbor in node2.neighbors:
					if neighbor == node:
						validstone = True

				if not validstone:
					player.jmessage("Invalid selection")
					continue

				else:
					node2.stone = player.color
					player.board.update()
					break

			else:
				continue


class Blink(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "<b>Blink</b><br /><span style='color:BlueViolet;'>Charm</span><br />Make 1 blink move,<br />then sacrifice a stone."


	def resolve(self, player):
		
		while True:
			player.jmessage("Where would you like to blink?", "node")

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
					player.board.update()
					break

		while True:
			player.jmessage("Select a stone to sacrifice.", "node")

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


class Meteor(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Meteor</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Make 1 blink move, then destroy<br />1 enemy stone touching it."

	def resolve(self, player):
		while True:
			player.jmessage("Where would you like to blink?", "node")

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
				player.jmessage("Select an enemy stone to destroy.", "node")

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


class Starfall(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Starfall</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Make 2 soft blink moves that<br />touch each other, then<br />destroy all enemy stones<br />touching them."

	def resolve(self, player):
		while True:
			player.jmessage("Where would you like to blink?", "node")

			actualmessage = player.receivemessage()

			if actualmessage in player.board.nodes:
				node = player.board.nodes[actualmessage]
				if node.stone != None:
					player.jmessage("Invalid option")
					continue

				else:
					node.stone = player.color
					player.board.update()
					break

			else:
				continue

		while True:
			player.jmessage("Where would you like to blink?", "node")

			actualmessage = player.receivemessage()

			if actualmessage in player.board.nodes:
				node2 = player.board.nodes[actualmessage]
				if node2.stone != None:
					player.jmessage("Invalid option")
					continue
				is_adjacent = False
				for neighbor in node.neighbors:
					if neighbor == node2:
						is_adjacent = True
				if is_adjacent == False:
					player.jmessage("Invalid option")
					continue
				else:
					node2.stone = player.color
					player.board.update()
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


class Summer(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True
		self.static = True

		self.text = "<b>Summer</b><br /><span style='color:BlueViolet;'>Static Charm</span><br />You may cast 2 spells<br />on your turn."



class Field_of_Flowers(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.static = True

		self.text = "<b>Field of Flowers</b><br /><span style='color:BlueViolet;'>Static Sorcery</span><br />Your first move each<br />turn is a blink move."


class Heat_Shimmer(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.static = True

		self.text = "<b>Heat Shimmer</b><br /><span style='color:BlueViolet;'>Static Ritual</span><br />Your dash only requires<br />1 sacrifice."





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








