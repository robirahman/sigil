### Sigil Online




import json
import time

from flask import Flask, render_template
from flask_sock import Sock
from random import randint

import spellgenerator


import json

class resetException(Exception):
	pass

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



########################################################
########################################################
########################################################
########################################################
########################################################

#####  ACTUAL SPELLS HERE


class Sprout(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "<b>Sprout</b><br /><span style='color:BlueViolet;'>Charm</span><br />Make 1 soft move."


	def resolve(self, player):
		player.softmove()


class Stomp(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "<b>Stomp</b><br /><span style='color:BlueViolet;'>Charm</span><br />Make 1 hard move."


	def resolve(self, player):
		player.hardmove()


class Frost(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "<b>Frost</b><br /><span style='color:BlueViolet;'>Charm</span><br />Make 1 move into a Sorcery."


	def resolve(self, player):
		player.move(sorcery_only=True)

class Spark(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "<b>Spark</b><br /><span style='color:BlueViolet;'>Charm</span><br />Make 1 move into a Ritual."


	def resolve(self, player):
		player.move(ritual_only=True)



class Apex(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "<b>Apex</b><br /><span style='color:BlueViolet;'>Charm</span><br />Make 1 move into a spell where<br />you control all but 1 node."


	def resolve(self, player):
		
		while True:
			player.jmessage("Where would you like to move?", "node")

			actualmessage = player.receivemessage()

			if actualmessage in player.board.nodes:
				node = player.board.nodes[actualmessage]

				if node.stone == player.color:
					player.jmessage("Invalid option")
					continue

				adjacent = False
				for neighbor in node.neighbors:
					if neighbor.stone == player.color:
						adjacent = True
				if not adjacent:
					player.jmessage("Invalid option")
					continue

				spell = None
				for s in player.board.spells:
					for n in s.position:
						if node == n:
							spell = s
				if spell == None:
					player.jmessage("Invalid option")
					continue
				not_controlled_count = 0
				for n in spell.position:
					if n.stone != player.color:
						not_controlled_count += 1
				if not_controlled_count != 1:
					player.jmessage("Invalid option")
					continue

				if node.stone == None:
					node.stone = player.color
					player.board.last_play = node.name
					player.board.last_player = player.color
					player.board.update()
					break
				else:
					player.pushenemy(node)
					break



class Summer(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True
		self.static = True

		self.text = "<b>Summer</b><br /><span style='color:BlueViolet;'>Static Charm</span><br />You may cast an additional<br />spell on your turn."



class Winter(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True
		self.static = True

		self.text = "<b>Winter</b><br /><span style='color:BlueViolet;'>Static Charm</span><br />Your opponent cannot cast charms.<br />(Static charms still work.)"


class Spring(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True
		self.static = True

		self.text = "<b>Spring</b><br /><span style='color:BlueViolet;'>Static Charm</span><br />You may cast your locked spells 1<br />additional time. (Then they are<br />Spring-locked until your lock moves.)"



class Autumn(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True
		self.static = True

		self.text = "<b>Autumn</b><br /><span style='color:BlueViolet;'>Static Charm</span><br />Your opponent cannot dash."




class Blink(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "<b>Blink</b><br /><span style='color:BlueViolet;'>Charm</span><br />Put a stone into any empty node,<br />then sacrifice a stone."


	def resolve(self, player):
		
		while True:
			player.jmessage("Where would you like to Blink?", "node")

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
					break

			else:
				continue




class Gust(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.ischarm = True

		self.text = "<b>Gust</b><br /><span style='color:BlueViolet;'>Charm</span><br />Relocate all enemy stones<br />which are touching you<br />into any empty nodes."


	def resolve(self, player):
		gustingstonecount = 0
		for name in player.board.nodes:
			node = player.board.nodes[name]
			if node.stone == player.enemy:
				already_gusted = False
				for neighbor in node.neighbors:
					if neighbor.stone == player.color:
						if not already_gusted:
							gustingstonecount += 1
							already_gusted = True
						node.stone = None
						if (player.board.last_play == node.name):
							player.board.last_play = None
							player.board.last_player = None
							
		player.board.update()

		while gustingstonecount > 0:
			player.jmessage("Where would you like to Gust the enemy stone?", "node")

			actualmessage = player.receivemessage()

			if actualmessage in player.board.nodes:
				node = player.board.nodes[actualmessage]
				if node.stone != None:
					player.jmessage("Invalid selection")
					continue

				gustingstonecount -= 1
				node.stone = player.enemy
				player.board.update()

			else:
				continue





class Grow(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Grow</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Make 2 soft moves."

	def resolve(self, player):
		for i in range(2):
			player.softmove()


class Fire(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Fire</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Destroy all enemy stones<br />which are touching you."

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


class Ice(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Ice</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Destroy up to 1 enemy stone<br />in each spell."

	def resolve(self, player):

		egress = {"type": "selecting"}
		player.ws.send(json.dumps(egress))

		iceablespells = []
		### We will use the notation of board.positions to refer to spells.
		### That is, 1,2,3 are the majors, 4,5,6 are the minors, 7,8,9 charms.

		for i in range(1,10):
			innernodelist = player.board.positions[i]
			for node in innernodelist:
				if node.stone == player.enemy:
					iceablespells.append(i)
					break

		while len(iceablespells) > 0:
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

				for spellnum in iceablespells:
					if node in player.board.positions[spellnum]:
						node.stone = None
						if (player.board.last_play == node.name):
							player.board.last_play = None
							player.board.last_player = None
						iceablespells.remove(spellnum)
						player.board.update()
						continue

				player.jmessage("Invalid selection")
				continue
				
			else:
				continue

		egress = {"type": "doneselecting"}
		player.ws.send(json.dumps(egress))



class Meteor(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Meteor</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Make 1 soft blink move,<br />then destroy 1 enemy<br />stone touching it."

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

				else:
					continue


class Thunder(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Thunder</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Destroy 2 enemy stones that<br />are touching each other."

	def resolve(self, player):

		egress = {"type": "selectingNoButton"}
		player.ws.send(json.dumps(egress))

		while True:
			player.jmessage("Select an enemy stone to destroy.", "node")

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
					node.stone = None
					player.board.update()
					break

				else:
					player.jmessage("Invalid selection")
					continue

			else:
				continue

		while True:
			player.jmessage("Select an adjacent enemy stone to destroy.", "node")

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
					node2.stone = None
					player.board.update()
					break

			else:
				continue


class Eclipse(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Eclipse</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Make 2 moves into a spell where<br />you control all but 2 nodes."


	def resolve(self, player):
		
		while True:
			player.jmessage("Where would you like to move?", "node")

			actualmessage = player.receivemessage()

			if actualmessage in player.board.nodes:
				node = player.board.nodes[actualmessage]

				if node.stone == player.color:
					player.jmessage("Invalid option")
					continue

				adjacent = False
				for neighbor in node.neighbors:
					if neighbor.stone == player.color:
						adjacent = True
				if not adjacent:
					player.jmessage("Invalid option")
					continue

				spell = None
				for s in player.board.spells:
					for n in s.position:
						if node == n:
							spell = s
				if spell == None:
					player.jmessage("Invalid option")
					continue
				not_controlled_count = 0
				for n in spell.position:
					if n.stone != player.color:
						not_controlled_count += 1
				if not_controlled_count != 2:
					player.jmessage("Invalid option")
					continue

				if node.stone == None:
					node.stone = player.color
					player.board.last_play = node.name
					player.board.last_player = player.color
					player.board.update()
					break
				else:
					player.pushenemy(node)
					break
		while True:
			player.jmessage("Where would you like to move?", "node")

			actualmessage = player.receivemessage()

			if actualmessage in player.board.nodes:
				node = player.board.nodes[actualmessage]

				if node not in spell.position:
					player.jmessage("Invalid option")
					continue

				if node.stone == player.color:
					player.jmessage("Invalid option")
					continue

				if node.stone == None:
					node.stone = player.color
					player.board.last_play = node.name
					player.board.last_player = player.color
					player.board.update()
					break
				else:
					player.pushenemy(node)
					break

class Gather(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Gather</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Make 3 moves into locked spells."


	def resolve(self, player):

		egress = {"type": "selecting"}
		player.ws.send(json.dumps(egress))

		moves_remaining = 3
		while moves_remaining > 0:
			player.jmessage("Move into a locked spell, or press Done.", "node")

			actualmessage = player.receivemessage()

			if actualmessage == 'doneselecting':
				break

			elif actualmessage in player.board.nodes:
				node = player.board.nodes[actualmessage]

				adjacent = False
				for neighbor in node.neighbors:
					if neighbor.stone == player.color:
						adjacent = True
				if not adjacent:
					player.jmessage("Invalid option")
					continue

				if node.stone == player.color:
					player.jmessage("Invalid option")
					continue

				locknodes = []
				if player.lock != None:
					locknodes += player.lock.position
				if player.opp.lock != None:
					locknodes += player.opp.lock.position

				if node not in locknodes:
					player.jmessage("You must move in a locked spell.")
					continue
				if node.stone == None:
					moves_remaining -= 1
					node.stone = player.color
					player.board.last_play = node.name
					player.board.last_player = player.color
					player.board.update()
					continue
				if node.stone == player.enemy:
					moves_remaining -= 1
					player.pushenemy(node)
					continue

		egress = {"type": "doneselecting"}
		player.ws.send(json.dumps(egress))


class Scatter(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Scatter</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Make 1 soft blink move<br />into each charm."


	def resolve(self, player):
		charms = player.board.positions[7] + player.board.positions[8] + player.board.positions[9]
		for node in charms:
			if node.stone == None:
				node.stone = player.color



class Levity(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.static = True

		self.text = "<b>Levity</b><br /><span style='color:BlueViolet;'>Static Sorcery</span><br />Your standard move each<br />turn is a blink move."


class Gravity(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)
		self.static = True

		self.text = "<b>Gravity</b><br /><span style='color:BlueViolet;'>Static Sorcery</span><br />Your opponent's standard move<br />each turn must be soft."



class Flourish(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Flourish</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Make 4 soft moves."

	def resolve(self, player):
		for i in range(4):
			player.softmove()


class Erupt(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Erupt</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Make 4 moves into Rituals."

	def resolve(self, player):
		for i in range(4):
			player.move(ritual_only=True)


class Fury(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Fury</b><br /><span style='color:BlueViolet;'>Sorcery</span><br />Make 2 hard moves."

	def resolve(self, player):
		for i in range(2):
			player.hardmove()

class Onslaught(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Onslaught</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Make 4 hard moves."

	def resolve(self, player):
		for i in range(4):
			player.hardmove()


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

		adjacent_enemy_count = 0
		for neighbor in neighbor_union:
			if neighbor.stone == player.opp.color:
				adjacent_enemy_count += 1
		if adjacent_enemy_count <3:
			for neighbor in neighbor_union:
				if neighbor.stone == player.opp.color:
					neighbor.stone = None
			player.board.update()

		if adjacent_enemy_count >= 3:
			num_destroyed = 0
			while num_destroyed <2:
				player.jmessage("Select an enemy stone to destroy.", "node")

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					enemy_node = player.board.nodes[actualmessage]
					if enemy_node.stone != player.opp.color:
						continue
					is_adjacent = False
					for neighbor in neighbor_union:
						if neighbor == enemy_node:
							is_adjacent = True
					if is_adjacent == False:
						continue

					else:
						enemy_node.stone = None
						num_destroyed += 1
						player.board.update()
						continue

				else:
					continue




class Syzygy(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Syzygy</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Make 3 blink moves into the Sorcery<br />across the board from Syzygy, then<br />1 into the Charm."

	def resolve(self, player):
		myposition = self.name[-1:]
		if myposition == '1':
			sorcerynodes = player.board.positions[5]
			charmnode = player.board.positions[8][0]
		elif myposition == '2':
			sorcerynodes = player.board.positions[6]
			charmnode = player.board.positions[9][0]
		elif myposition == '3':
			sorcerynodes = player.board.positions[4]
			charmnode = player.board.positions[7][0]

		while True:
			sorcery_full = True
			for node in sorcerynodes:
				if (node.stone != player.color):
					sorcery_full = False
			if sorcery_full:
				break
			else:
				player.jmessage("Blink into the sorcery.", "node")

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					node = player.board.nodes[actualmessage]
					if node not in sorcerynodes:
						player.jmessage("Invalid selection")
						continue
					if node.stone == player.color:
						continue
					if node.stone == None:
						node.stone = player.color
						player.board.update()
						continue
					if node.stone == player.opp.color:
						player.pushenemy(node)
						continue
		if charmnode.stone == player.color:
			return
		else:
			while True:
				player.jmessage("Blink into the charm.", "node")

				actualmessage = player.receivemessage()

				if actualmessage in player.board.nodes:
					node = player.board.nodes[actualmessage]
					if node != charmnode:
						player.jmessage("Invalid selection")
						continue
					if node.stone == None:
						node.stone = player.color
						player.board.update()
						return
					if node.stone == player.opp.color:
						player.pushenemy(node)
						return



class Bewitch(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Bewitch</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Choose any 2 enemy stones<br />which are touching each other.<br />Convert them to your color."

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

class Tempest(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Tempest</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Destroy all connected groups<br />of enemy stones that are not<br />connected to mana."

	def resolve(self, player):

		safe_enemies = []
		for nodename in ['a1', 'b1', 'c1']:
			if player.board.nodes[nodename].stone == player.opp.color:
				safe_enemies.append(nodename)
		while True:
			new_safe_enemies = []
			for nodename in safe_enemies:
				neighbors = player.board.nodes[nodename].neighbors
				for neighbor in neighbors:
					if (neighbor.stone == player.opp.color) and (neighbor.name not in safe_enemies):
						new_safe_enemies.append(neighbor.name)
			if len(new_safe_enemies) == 0:
				break
			for new_safe_enemy in new_safe_enemies:
				if new_safe_enemy not in safe_enemies:
					safe_enemies.append(new_safe_enemy)
		for nodename in player.board.nodes:
			if player.board.nodes[nodename].stone == player.opp.color:
				if nodename not in safe_enemies:
					player.board.nodes[nodename].stone = None
		player.board.update()

class Harvest(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Harvest</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Make 5 moves into locked spells<br />or into Harvest."


	def resolve(self, player):

		egress = {"type": "selecting"}
		player.ws.send(json.dumps(egress))

		moves_remaining = 5
		while moves_remaining > 0:
			player.jmessage("Move into a locked spell or Harvest, or press Done.", "node")

			actualmessage = player.receivemessage()

			if actualmessage == 'doneselecting':
				break

			elif actualmessage in player.board.nodes:
				node = player.board.nodes[actualmessage]

				adjacent = False
				for neighbor in node.neighbors:
					if neighbor.stone == player.color:
						adjacent = True
				if not adjacent:
					player.jmessage("Invalid option")
					continue

				if node.stone == player.color:
					player.jmessage("Invalid option")
					continue

				allowednodes = []
				if player.lock != None:
					allowednodes += player.lock.position
				if player.opp.lock != None:
					allowednodes += player.opp.lock.position
				allowednodes += self.position

				if node not in allowednodes:
					player.jmessage("Invalid selection")
					continue
				if node.stone == None:
					moves_remaining -= 1
					node.stone = player.color
					player.board.last_play = node.name
					player.board.last_player = player.color
					player.board.update()
					continue
				if node.stone == player.enemy:
					moves_remaining -= 1
					player.pushenemy(node)
					continue

		egress = {"type": "doneselecting"}
		player.ws.send(json.dumps(egress))


class Blossom(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.text = "<b>Blossom</b><br /><span style='color:BlueViolet;'>Ritual</span><br />Make 1 soft blink move into<br />each other Ritual and Sorcery."

	def resolve(self, player):

		blossomablespells = []

		for spell in player.board.spells[:6]:
			if spell != self:
				for node in spell.position:
					if node.stone == None:
						blossomablespells.append(spell)
						break
		while len(blossomablespells) > 0:
			player.jmessage("Make a soft blink.", "node")

			actualmessage = player.receivemessage()

			if actualmessage in player.board.nodes:
				node = player.board.nodes[actualmessage]

				if node.stone != None:
					player.jmessage("Invalid option")
					continue

				for spell in blossomablespells:
					if node in spell.position:
						node.stone = player.color
						blossomablespells.remove(spell)
						player.board.update()

		


class Nirvana(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.static = True

		self.text = "<b>Nirvana</b><br /><span style='color:BlueViolet;'>Static Ritual</span><br />Once at any time during your turn,<br />you may sacrifice a stone and<br />make 1 move."




class Inferno(Spell):
	def __init__(self, board, position, name):
		super().__init__(board, position, name)

		self.static = True

		self.text = "<b>Inferno</b><br /><span style='color:BlueViolet;'>Static Ritual</span><br />At the end of your turn, destroy all<br />enemy stones which are touching you.<br />At the start of your turn,<br />you lose the game."





	

			
		








#####  ACTUAL SPELLS FINISHED


############################





















# The only core game feature
# not yet implemented is detecting that the game
# is going in a loop (after 5 repeats of the board state)
# and making blue win in this case (after giving red fair warning).
# But I'll save that for another time.



class Node():
	def __init__(self, name):
		self.name = name

		### neighbors is a list of node objects which are adjacent
		self.neighbors = []

		### stone is None when empty, 'red' or 'blue' when filled
		self.stone = None




class Board():
	def __init__(self):
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
		snapshot["turncounter"] = turncounter
		snapshot["gameover"] = gameover
		snapshot["winner"] = winner
		snapshot["score"] = self.score
		snapshot["currentplayerhasmoved"] = currentplayerhasmoved
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
			### score should be a string like 'r1', 'b2' , etc.
			if whoseturn == 'red':
				if currentplayerhasmoved:
					nextmove = 'blue'
				else:
					nextmove = 'red'

			elif whoseturn == 'blue':
				if currentplayerhasmoved:
					nextmove = 'red'
				else:
					nextmove = 'blue'

			if nextmove == 'red':
				if redscore >= bluescore:
					scorenum = min(3, (redscore +1) - bluescore)
					score = 'r' + str(scorenum)
				else:
					scorenum = min(3, bluescore - redscore)
					score = 'b' + str(scorenum)

			elif nextmove == 'blue':
				if bluescore >= redscore:
					scorenum = min(3, (bluescore + 1) - redscore)
					score = 'b' + str(scorenum)
				else:
					scorenum = min(3, redscore - bluescore)
					score = 'r' + str(scorenum)

			self.score = score


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
		elif self.redplayer.countdown == 0:
			redcountdownstring = "Zero Red spells"

		jboard["redcountdown"] = redcountdownstring

		if self.blueplayer.countdown > 1:
			bluecountdownstring = "{} Blue spells".format(self.blueplayer.countdown)
		elif self.blueplayer.countdown == 1:
			bluecountdownstring = "1 Blue spell"
		elif self.blueplayer.countdown == 0:
			bluecountdownstring = "Zero Blue spells"


		jboard["bluecountdown"] = bluecountdownstring

		if update_score:
			jboard["score"] = self.score

		jboard["last_player"] = self.last_player
		jboard["last_play"] = self.last_play
		
		self.redplayer.ws.send(json.dumps(jboard))
		self.blueplayer.ws.send(json.dumps(jboard))


	def end_game(self, winner):
		### Right now this doesn't DO anything special,
		### just prints some silly stuff.
		### But this would be a good place to put any 'store the data'
		### type code.
		self.redplayer.jmessage("Game over-- the winner is " + winner.upper() +
							   " !!!")
		self.blueplayer.jmessage("Game over-- the winner is " + winner.upper() +
								" !!!")
		for i in range(3):
			self.redplayer.jmessage(winner.upper() + " VICTORY")
			self.blueplayer.jmessage(winner.upper() + " VICTORY")

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
		spellnames = spellgenerator.spell_list

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


	def pong(self):
		egress =  {"type": "pong"}
		self.ws.send(json.dumps(egress))

	def receivemessage(self):
		while True:
			ingress = self.ws.receive()
			if json.loads(ingress)['message'] == 'ping':
				self.pong()
				self.opp.pong()
				continue
			else:
				break
			
		if json.loads(ingress)['message'] == 'reset':
			raise resetException()

		actualmessage = json.loads(ingress)['message']
		return actualmessage


	def taketurn(self, canmove=True, candash=True, canspell=True, cansummer=True, canshimmer=True):
		global currentplayerhasmoved
		self.board.update(True)

		actions = []
		spelllist = []
		if canshimmer:
			for nirvanaspell in self.charged_spells:
				if nirvanaspell.name[:-1] == 'Nirvana':
					actions.append(nirvanaspell.name)
					spelllist.append(nirvanaspell.name)

		if canmove:
			actions.append('move')
		else:
			if (candash & canspell & (self.totalstones > 2)):
				if 'Autumn' not in [s.name[:-1] for s in self.opp.charged_spells]:
					actions.append('dash')
			summer_active = False
			if ('Summer' in [s.name[:-1] for s in self.charged_spells]) and cansummer:
				summer_active = True

			if (canspell) or (not canspell and summer_active):
				self.board.update()
				for spell in self.charged_spells:
					if not spell.static:
						if spell.ischarm:
							if 'Winter' not in [s.name[:-1] for s in self.opp.charged_spells]:
								actions.append(spell.name)
								spelllist.append(spell.name)
						else:
							if self.lock == spell and ('Spring' in [s.name[:-1] for s in self.charged_spells]) and self.springlock != spell:
								actions.append(spell.name)
								spelllist.append(spell.name)
							if self.lock != spell:
								actions.append(spell.name)
								spelllist.append(spell.name)
			actions.append('pass')

		self.jmessage("\nSelect an action:")


		egress =  {"type": "message", "message": str(actions), 
		"awaiting": "action", "actionlist": actions}

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
			self.taketurn(canmove, candash, canspell, cansummer, canshimmer)
			return None

		elif action in shortcuts:
			self.move(action, standardmove=True)
			currentplayerhasmoved = True
			self.taketurn(False, candash, canspell, cansummer, canshimmer)
			return None

		elif action == 'move':
			self.move(standardmove=True)
			currentplayerhasmoved = True
			self.taketurn(False, candash, canspell, cansummer, canshimmer)
			return None

		elif action == 'dash':
			self.dash()
			self.taketurn(canmove, False, canspell, cansummer, canshimmer)
			return None

		elif action[:-1] == 'Nirvana':
			while True:
				self.jmessage("Select a stone to sacrifice.", "node")
				message = self.receivemessage()

				if message in self.board.nodes:
					node = self.board.nodes[message]
					if node.stone != self.color:
						continue

					else:
						node.stone = None
						if (self.board.last_play == node.name):
							self.board.last_play = None
							self.board.last_player = None
						break

				else:
					continue
			self.board.update()
			self.move()
			self.taketurn(canmove, candash, canspell, cansummer, False)
			return None

		elif action in spelllist:
			self.board.spelldict[action].cast(self)
			if canspell:
				self.taketurn(False, False, False, cansummer, canshimmer)
				return None
			else:
				self.taketurn(False, False, False, False, canshimmer)
				return None


		elif action == 'pass':
			return None

	def bot_triggers(self, whoseturn):
		### Put any spell-specific BOT triggers here,
		### like Inferno, which should set the global
		### variables gameover = True and winner = self.enemy
		global gameover
		global winner

		if 'Inferno' in [spell.name[:-1] for spell in self.charged_spells]:
			self.jmessage("DEATH BY INFERNO!")
			self.opp.jmessage("DEATH BY INFERNO!")
			gameover = True
			winner = self.enemy


	def eot_triggers(self, whoseturn):
		### Put code in here for every specific spell
		### that causes eot triggers.
		### It must come BEFORE the end-game code below!

		### Check whether someone is up by 3 or more.

		### Check whether the countdown == 0.
		global gameover
		global winner

		### INSERT SPELL-SPECIFIC EOT EFFECTS HERE
	

		if 'Inferno' in [spell.name[:-1] for spell in self.charged_spells]:
			self.jmessage("INFERNO TRIGGER!")
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
			board.update(True)

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
			gameover = True
			winner = 'red'

		elif bluetotal > redtotal + 2:
			gameover = True
			winner = 'blue'

		else:
			if self.countdown == 0:
				gameover = True
				if redtotal > bluetotal:
					winner = 'red'
				elif bluetotal > redtotal:
					winner = 'blue'
				else:
					a = ['red', 'blue']
					a.remove(whoseturn)
					winner = a[0]

		self.board.update()



	def move(self, preloaded = False, standardmove = False, sorcery_only=False, ritual_only=False):
		### If the user clicked on a node while they had 'move' action available,
		### we call this move function with preloaded == the node they clicked.

		### standardmove is True iff this is the player's standard move for the turn.
		if not preloaded:
			self.jmessage("Where would you like to move? ", "node")
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
			self.move(standardmove=standardmove, sorcery_only=sorcery_only, ritual_only=ritual_only)
			return None

		elif not adjacent:
			if not (standardmove and ("Levity" in [spell.name[:-1] for spell in self.charged_spells])):
				self.jmessage("Invalid move-- that's not adjacent to you!")
				self.move(standardmove=standardmove, sorcery_only=sorcery_only, ritual_only=ritual_only)
				return None
			else:
				if node.stone == None:
					node.stone = self.color
					self.board.last_play = node.name
					self.board.last_player = self.color
					self.board.update()
				else:
					if (standardmove and ("Gravity" in [spell.name[:-1] for spell in self.opp.charged_spells])):
						self.jmessage("You can only make soft moves under Gravity.")
						self.move(standardmove=standardmove, sorcery_only=sorcery_only, ritual_only=ritual_only)
						return None
					self.pushenemy(node)


		elif node.stone == None:
			if sorcery_only:
				if node in self.board.positions[4] + self.board.positions[5] + self.board.positions[6]:
					pass
				else:
					self.jmessage("You must move in a Sorcery.")
					self.move(sorcery_only=True)
					return None
			if ritual_only:
				if node in self.board.positions[1] + self.board.positions[2] + self.board.positions[3]:
					pass
				else:
					self.jmessage("You must move in a Ritual.")
					self.move(ritual_only=True)
					return None

			node.stone = self.color
			self.board.last_play = node.name
			self.board.last_player = self.color
			self.board.update()

		elif node.stone == self.enemy:
			if sorcery_only:
				if node in self.board.positions[4] + self.board.positions[5] + self.board.positions[6]:
					pass
				else:
					self.jmessage("You must move in a Sorcery.")
					self.move(sorcery_only=True)
					return None
			if ritual_only:
				if node in self.board.positions[1] + self.board.positions[2] + self.board.positions[3]:
					pass
				else:
					self.jmessage("You must move in a Ritual.")
					self.move(ritual_only=True)
					return None
			if (standardmove and ("Gravity" in [spell.name[:-1] for spell in self.opp.charged_spells])):
				self.jmessage("You can only make soft moves under Gravity.")
				self.move(standardmove=standardmove, sorcery_only=sorcery_only, ritual_only=ritual_only)
				return None
			self.pushenemy(node)



	def softmove(self):
		self.jmessage("Where would you like to soft move? ", "node")
		
		
		nodename = self.receivemessage()
		node = self.board.nodes[nodename]
		adjacent = False
		for neighbor in node.neighbors:
			if neighbor.stone == self.color:
				adjacent = True

		if node.stone == None and adjacent:
			node.stone = self.color
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
		self.jmessage("Where would you like to hard move? ", "node")

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

	def dash(self):
		self.jmessage("Select your first stone to sacrifice. ", "node")
		
		sac1 = self.receivemessage()

		if (self.board.nodes[sac1].stone != self.color):
			self.jmessage("Invalid sacrifice")
			self.dash()
			return None

		self.board.nodes[sac1].stone = None
		if (self.board.last_play == sac1):
			self.board.last_play = None
			self.board.last_player = None
		self.board.update()

		while True:
			self.jmessage("Select your second stone to sacrifice. ", "node")
			
			sac2 = self.receivemessage()

			if (self.board.nodes[sac2].stone != self.color):
				self.jmessage("Invalid sacrifice")
				continue
			else:
				break
	
		self.board.nodes[sac2].stone = None
		if (self.board.last_play == sac2):
			self.board.last_play = None
			self.board.last_player = None
		self.board.update()
			
		self.move()

		### Update the new score
		self.board.update(True)

	def pushenemy(self, node):
		node.stone = self.color
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
			self.board.nodes[pushingoptionnames[0]].stone = self.enemy
			self.board.update()
			return None

		while True:
			egress = {"type": "pushingoptions", }
			for nodename in pushingoptionnames:
				egress[nodename] = self.enemy

			self.ws.send(json.dumps(egress))

			self.jmessage("Where would you like to push the enemy stone? ", "node")
			
			push = self.receivemessage()
			if push not in pushingoptionnames:
				self.jmessage("Invalid option!")
				continue
			self.board.nodes[push].stone = self.enemy
			self.board.update()
			self.jmessage("Enemy stone pushed to " + push)
			break
			



##############  GAME LOOP  ##############

### First we set up the objects.  This is my hack-y way of passing
### everyone as parameters to everyone else: doing it
### in two layers, using the board.addplayers method


board = Board()
red = Player(board, 'red')
blue = Player(board, 'blue')
board.addplayers(red, blue)
red.opp = blue
blue.opp = red

turncounter = 0
whoseturn = None
currentplayerhasmoved = False
gameover = False
winner = None

app = Flask(__name__)
sock = Sock(app)

totalplayers = 0
whoisred = randint(1,2)
whoisblue = 3 - whoisred
redjoined = False
bluejoined = False

@app.route('/')
def index():
    return render_template('index.html')

@sock.route('/api/game')
def playgame(ws):
	global totalplayers
	global redjoined
	global bluejoined
	global turncounter
	global whoseturn
	global currentplayerhasmoved
	global gameover
	global winner
	totalplayers += 1
	if totalplayers == whoisred:
		red.ws = ws
		red.jmessage("You are RED this game.")


		### spellsetup is a JSON dictionary with keys "major2", "charm3", etc.,
		### and values "Flourish2", "Sprout3", etc.
		egress = { "type": "spellsetup" }

		egress["major1"] = board.spells[0].name
		egress["major2"] = board.spells[1].name
		egress["major3"] = board.spells[2].name
		egress["minor1"] = board.spells[3].name
		egress["minor2"] = board.spells[4].name
		egress["minor3"] = board.spells[5].name
		egress["charm1"] = board.spells[6].name
		egress["charm2"] = board.spells[7].name
		egress["charm3"] = board.spells[8].name
		
		red.ws.send(json.dumps(egress))

		egress = { "type": "spelltextsetup" }

		egress["major1"] = board.spells[0].text
		egress["major2"] = board.spells[1].text
		egress["major3"] = board.spells[2].text
		egress["minor1"] = board.spells[3].text
		egress["minor2"] = board.spells[4].text
		egress["minor3"] = board.spells[5].text
		egress["charm1"] = board.spells[6].text
		egress["charm2"] = board.spells[7].text
		egress["charm3"] = board.spells[8].text
		
		red.ws.send(json.dumps(egress))

		while True:
			ingress = red.ws.receive()
			message = json.loads(ingress)['message']
			if message == 'ping':
				red.pong()
				continue
			elif message == 'joinedgame':
				redjoined = True
				break
				
		if not bluejoined:
			red.jmessage("Waiting for opponent to join...")
		while True:
			red.pong()
			time.sleep(1)


	elif totalplayers == whoisblue:
		blue.ws = ws
		blue.jmessage("You are BLUE this game.")


		### spellsetup is a JSON dictionary with keys "major2", "charm3", etc.,
		### and values "Flourish2", "Sprout3", etc.
		egress = { "type": "spellsetup" }

		egress["major1"] = board.spells[0].name
		egress["major2"] = board.spells[1].name
		egress["major3"] = board.spells[2].name
		egress["minor1"] = board.spells[3].name
		egress["minor2"] = board.spells[4].name
		egress["minor3"] = board.spells[5].name
		egress["charm1"] = board.spells[6].name
		egress["charm2"] = board.spells[7].name
		egress["charm3"] = board.spells[8].name
		
		blue.ws.send(json.dumps(egress))


		egress = { "type": "spelltextsetup" }

		egress["major1"] = board.spells[0].text
		egress["major2"] = board.spells[1].text
		egress["major3"] = board.spells[2].text
		egress["minor1"] = board.spells[3].text
		egress["minor2"] = board.spells[4].text
		egress["minor3"] = board.spells[5].text
		egress["charm1"] = board.spells[6].text
		egress["charm2"] = board.spells[7].text
		egress["charm3"] = board.spells[8].text
		
		blue.ws.send(json.dumps(egress))

		while True:
			ingress = blue.ws.receive()
			message = json.loads(ingress)['message']
			if message == 'ping':
				blue.pong()
				continue
			elif message == 'joinedgame':
				bluejoined = True
				break
		alreadymessaged = False
		while True:
			if redjoined:
				break
			else:
				if not alreadymessaged:
					blue.jmessage("Waiting for opponent to join...")
					alreadymessaged = True
				time.sleep(.1)

		red.jmessage("Ready to play!")
		blue.jmessage("Ready to play!")
		board.nodes['a1'].stone = 'red'
		board.nodes['b1'].stone = 'blue'
		board.update()
		time.sleep(3)


		while True:
			### First take a snapshot of the board,
			### which we will revert to in case of a reset exception.
			board.take_snapshot()

			turncounter += 1
			currentplayerhasmoved = False

			if turncounter % 2 == 1:
				activeplayer = red
				whoseturn = 'red'
			else:
				activeplayer = blue
				whoseturn = 'blue'

			
			try:
				if whoseturn == 'red':
					message = "Red Turn " + str((turncounter // 2) + 1)
				elif whoseturn == 'blue':
					message = "Blue Turn " + str(turncounter // 2)

				egress = { "type": "whoseturndisplay", "color": whoseturn, "message": message }
				red.ws.send(json.dumps(egress))
				blue.ws.send(json.dumps(egress))

				activeplayer.bot_triggers(whoseturn)
				if gameover:
					board.end_game(winner)
					break

				if whoseturn == 'red':
					red.taketurn()
				else:
					blue.taketurn()

				activeplayer.eot_triggers(whoseturn)
				board.update(True)
				if gameover:
					board.end_game(winner)
					break

			except resetException:
				### Reset all attributes of the game & board
				### to the way they were in board.snapshot , 
				### then we restart the turn loop.
				red.jmessage("Resetting Turn")
				blue.jmessage("Resetting Turn")

				snapshot = board.snapshot

				turncounter = snapshot["turncounter"]
				currentplayerhasmoved = snapshot["currentplayerhasmoved"]
				gameover = snapshot["gameover"]
				winner = snapshot["winner"]
				board.score = snapshot["score"]

				egress = {"type": "doneselecting"}
				red.ws.send(json.dumps(egress))
				blue.ws.send(json.dumps(egress))


				for nodename in board.nodes:
					board.nodes[nodename].stone = snapshot[nodename]
				if snapshot["redlock"]:
					red.lock = board.spelldict[snapshot["redlock"]]
				else:
					red.lock = None
				
				if snapshot["bluelock"]:
					blue.lock = board.spelldict[snapshot["bluelock"]]
				else:
					blue.lock = None

				red.countdown = snapshot["redcountdown"]
				blue.countdown = snapshot["bluecountdown"]
				board.last_play = snapshot["last_play"]
				board.last_player = snapshot["last_player"]

				board.update(True)

				continue




totalchatters = 0
redchatws = None
bluechatws = None

@sock.route('/api/chat')
def chat(ws):

	global totalchatters
	global redchatws
	global bluechatws
	totalchatters += 1
	if totalchatters == 1:
		redchatws = ws
		while True:
			ingress = redchatws.receive()
			message = json.loads(ingress)['message']
			if message == "ping":
				egress =  {"type": "pong"}
				redchatws.send(json.dumps(egress))
				continue
			else:
				egress = {"type": "chatmessage", "player": "Red:", "message": message }
				redchatws.send(json.dumps(egress))
				if totalchatters == 2:
					bluechatws.send(json.dumps(egress))

				
			

	elif totalchatters == 2:
		bluechatws = ws
		while True:
			ingress = bluechatws.receive()
			message = json.loads(ingress)['message']

			if message == "ping":
				egress =  {"type": "pong"}
				bluechatws.send(json.dumps(egress))
				continue

			else:
				egress = {"type": "chatmessage", "player": "Blue:", "message": message }
				
				redchatws.send(json.dumps(egress))
				bluechatws.send(json.dumps(egress))








