### Sigil Online


import json
import time

from flask import Flask, render_template
from flask_sock import Sock
from random import randint

from game import Board, Player, resetException
			




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


app = Flask(__name__)
sock = Sock(app)

totalplayers = 0
whoisred = randint(1,2)
whoisblue = 3 - whoisred
redjoined = False
bluejoined = False

@app.route('/')
def home():
    return render_template('home.html')

@app.route('/gameboard')
def gameboard():
    return render_template('gameboard.html')

@app.route('/tutorial')
def tutorial():
    return render_template('tutorial.html')

@app.route('/privatematch')
def privatematch():
    return render_template('privatematch.html')

@sock.route('/api/game')
def playgame(ws):
	global totalplayers
	global redjoined
	global bluejoined
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

			board.turncounter += 1
			board.currentplayerhasmoved = False

			if board.turncounter % 2 == 1:
				activeplayer = red
				board.whoseturn = 'red'
			else:
				activeplayer = blue
				board.whoseturn = 'blue'

			
			try:
				if board.whoseturn == 'red':
					message = "Red Turn " + str((board.turncounter // 2) + 1)
				elif board.whoseturn == 'blue':
					message = "Blue Turn " + str(board.turncounter // 2)

				egress = { "type": "whoseturndisplay", "color": board.whoseturn, "message": message }
				red.ws.send(json.dumps(egress))
				blue.ws.send(json.dumps(egress))

				activeplayer.bot_triggers()
				if board.gameover:
					board.end_game()
					break

				if board.whoseturn == 'red':
					red.taketurn()
				else:
					blue.taketurn()

				activeplayer.eot_triggers()
				board.update(True)
				if board.gameover:
					board.end_game()
					break

			except resetException:
				### Reset all attributes of the game & board
				### to the way they were in board.snapshot , 
				### then we restart the turn loop.
				red.jmessage("Resetting Turn")
				blue.jmessage("Resetting Turn")

				snapshot = board.snapshot

				board.turncounter = snapshot["turncounter"]
				board.currentplayerhasmoved = snapshot["currentplayerhasmoved"]
				board.gameover = snapshot["gameover"]
				board.winner = snapshot["winner"]
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








