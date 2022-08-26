### Sigil Online


import json
import time

from flask import Flask, render_template
from flask_sock import Sock
from random import randint, randrange
from threading import Thread

from game import Board, Player, resetException
from singleplayergame import SPBoard, AIPlayer





##############  GAME LOOP  ##############

### First we set up the objects.  This is my hack-y way of passing
### everyone as parameters to everyone else: doing it
### in two layers, using the board.addplayers method

playercount = 0
playerlist = []

chattercount = 0
chatterlist = []

# createdgames is a dict with keys = gamename, values = [gamepwd, player_websocket, is_started]
createdgames = {}



app = Flask(__name__)
sock = Sock(app)
# ping every 2 seconds
app.config['SOCK_SERVER_OPTIONS'] = {'ping_interval': 2}

# v2
@app.route('/v2')
def homeV2():
	return render_template('v2/index.html')

@app.route('/v2/tutorial-and-rules')
def tutorialAndRulesV2():
	return render_template('v2/tutorial-and-rules.html')

@app.route('/v2/single-player')
def singlePlayerV2():
	return render_template('v2/single-player.html')

@app.route('/v2/private-match')
def privatematchV2():
	return render_template('v2/private-match.html')

@app.route('/v2/private-game/<gamename>')
def privategameboardV2(gamename):
	return render_template('v2/two-player.html', privategamename= gamename)

# v1
@app.route('/')
def home():
	return render_template('home.html')

@app.route('/gameboard')
def gameboard():
	return render_template('gameboard.html', privategamename="''")

@app.route('/singleplayergameboard')
def singleplayergameboard():
	return render_template('singleplayergameboard.html')

@app.route('/tutorial')
def tutorial():
	return render_template('tutorial.html')

@app.route('/tutorialpartone')
def tutorialpartone():
	return render_template('tutorialpartone.html')

@app.route('/tutorialparttwo')
def tutorialparttwo():
	return render_template('tutorialparttwo.html')

@app.route('/tutorialpartthree')
def tutorialpartthree():
	return render_template('tutorialpartthree.html')

@app.route('/tutorialbasicspells')
def tutorialbasicspells():
	return render_template('tutorialbasicspells.html')

@app.route('/tutorialadvancedspells')
def tutorialadvancedspells():
	return render_template('tutorialadvancedspells.html')

@app.route('/singleplayer')
def singleplayer():
	return render_template('singleplayer.html')

@app.route('/laddermatch')
def laddermatch():
	return render_template('laddermatch.html')

@app.route('/privatematch')
def privatematch():
	return render_template('privatematch.html')

@sock.route('/api/creategame')
def creategame(ws):
	global createdgames
	ingress = ws.receive()
	gamename = json.loads(ingress)['gamename']
	gamepwd = json.loads(ingress)['gamepwd']
	if (gamename in createdgames) or (gamename == ""):
		# ws will close as this function exits
		egress =  {"type": "nameconflict"}
		ws.send(json.dumps(egress))
	else:
		createdgames[gamename] = [gamepwd, ws, False]
		egress =  {"type": "success"}
		ws.send(json.dumps(egress))
		while True:
			time.sleep(1)

@sock.route('/api/joingame')
def joingame(ws):
	# ws will close as this function exits
	global createdgames
	ingress = ws.receive()
	gamename = json.loads(ingress)['gamename']
	gamepwd = json.loads(ingress)['gamepwd']
	if (gamename in createdgames) and (createdgames[gamename][0] == gamepwd) and (createdgames[gamename][2] == False):
		egress =  {"type": "startprivategame", "gamename": gamename + str(randrange(100000000))}
		createdgames[gamename][1].send(json.dumps(egress))
		ws.send(json.dumps(egress))
		createdgames[gamename][2] = True
	else:
		egress =  {"type": "notfound"}
		ws.send(json.dumps(egress))

@app.route('/privategameboard/<gamename>')
def privategameboard(gamename):
	return render_template('gameboard.html', privategamename= "'" + gamename + "'")



@sock.route('/api/game')
def playgame(ws):
	global playerlist
	global playercount
	playerlist.append(ws)
	playercount += 1
	if playercount %2 == 1:
		egress =  {"type": "message", "message": "Waiting for opponent to join...", "awaiting": None, }
		ws.send(json.dumps(egress))
		while True:
			time.sleep(1)
	else:
		opp_ws = playerlist[-2]
		board = Board()
		red = Player(board, 'red')
		blue = Player(board, 'blue')
		board.addplayers(red, blue)
		red.opp = blue
		blue.opp = red
		whoisred = randint(1,2)
		if whoisred == 1:
			red.ws = ws
			blue.ws = opp_ws
		else:
			red.ws = opp_ws
			blue.ws = ws


		red.jmessage("You are RED this game.")
		blue.jmessage("You are BLUE this game.")


		### spellsetup is a JSON dictionary with keys "ritual2", "charm3", etc.,
		### and values "Searing_Wind", "Creeping_Vines", etc.
		egress = { "type": "spellsetup" }

		egress["ritual1"] = board.spells[0].name
		egress["ritual2"] = board.spells[1].name
		egress["ritual3"] = board.spells[2].name
		egress["sorcery1"] = board.spells[3].name
		egress["sorcery2"] = board.spells[4].name
		egress["sorcery3"] = board.spells[5].name
		egress["charm1"] = board.spells[6].name
		egress["charm2"] = board.spells[7].name
		egress["charm3"] = board.spells[8].name

		red.ws.send(json.dumps(egress))
		blue.ws.send(json.dumps(egress))

		egress = { "type": "spelltextsetup" }

		egress["ritual1"] = board.spells[0].text
		egress["ritual2"] = board.spells[1].text
		egress["ritual3"] = board.spells[2].text
		egress["sorcery1"] = board.spells[3].text
		egress["sorcery2"] = board.spells[4].text
		egress["sorcery3"] = board.spells[5].text
		egress["charm1"] = board.spells[6].text
		egress["charm2"] = board.spells[7].text
		egress["charm3"] = board.spells[8].text

		red.ws.send(json.dumps(egress))
		blue.ws.send(json.dumps(egress))


		board.nodes['a1'].stone = 'red'
		board.nodes['b1'].stone = 'blue'
		board.update()
		time.sleep(3)


		while True:
			### First take a snapshot of the board,
			### which we will revert to in case of a reset exception.
			board.take_snapshot()

			board.turncounter += 1

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

privategamedict = {}

@sock.route('/api/privategame/<privategamename>')
def playprivategame(ws, privategamename):
	global privategamedict
	if privategamename not in privategamedict:
		privategamedict[privategamename] = ws
		while True:
			time.sleep(1)
	else:
		opp_ws = privategamedict[privategamename]
		board = Board()
		red = Player(board, 'red')
		blue = Player(board, 'blue')
		board.addplayers(red, blue)
		red.opp = blue
		blue.opp = red
		whoisred = randint(1,2)
		if whoisred == 1:
			red.ws = ws
			blue.ws = opp_ws
		else:
			red.ws = opp_ws
			blue.ws = ws


		red.jmessage("You are RED this game.")
		blue.jmessage("You are BLUE this game.")


		### spellsetup is a JSON dictionary with keys "ritual2", "charm3", etc.,
		### and values "Searing_Wind", "Creeping_Vines", etc.
		egress = { "type": "spellsetup" }

		egress["ritual1"] = board.spells[0].name
		egress["ritual2"] = board.spells[1].name
		egress["ritual3"] = board.spells[2].name
		egress["sorcery1"] = board.spells[3].name
		egress["sorcery2"] = board.spells[4].name
		egress["sorcery3"] = board.spells[5].name
		egress["charm1"] = board.spells[6].name
		egress["charm2"] = board.spells[7].name
		egress["charm3"] = board.spells[8].name

		red.ws.send(json.dumps(egress))
		blue.ws.send(json.dumps(egress))

		egress = { "type": "spelltextsetup" }

		egress["ritual1"] = board.spells[0].text
		egress["ritual2"] = board.spells[1].text
		egress["ritual3"] = board.spells[2].text
		egress["sorcery1"] = board.spells[3].text
		egress["sorcery2"] = board.spells[4].text
		egress["sorcery3"] = board.spells[5].text
		egress["charm1"] = board.spells[6].text
		egress["charm2"] = board.spells[7].text
		egress["charm3"] = board.spells[8].text

		red.ws.send(json.dumps(egress))
		blue.ws.send(json.dumps(egress))


		board.nodes['a1'].stone = 'red'
		board.nodes['b1'].stone = 'blue'
		board.update()
		time.sleep(3)


		while True:
			### First take a snapshot of the board,
			### which we will revert to in case of a reset exception.
			board.take_snapshot()

			board.turncounter += 1

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



@sock.route('/api/singleplayergame')
def playsingleplayergame(ws):
	board = SPBoard()
	humancolor = randint(1,2)
	if humancolor == 1:
		human = Player(board, 'red')
		ai = AIPlayer(board, 'blue')
		board.addplayers(human, ai)
		human.opp = ai
		ai.opp = human
		human.ws = ws
		human.jmessage("You are RED this game.")
		red = human
		blue = ai

	else:
		human = Player(board, 'blue')
		ai = AIPlayer(board, 'red')
		board.addplayers(human, ai)
		human.opp = ai
		ai.opp = human
		human.ws = ws
		human.jmessage("You are BLUE this game.")
		blue = human
		red = ai


	### spellsetup is a JSON dictionary with keys "ritual2", "charm3", etc.,
	### and values "Searing_Wind", "Creeping_Vines", etc.
	egress = { "type": "spellsetup" }

	egress["ritual1"] = board.spells[0].name
	egress["ritual2"] = board.spells[1].name
	egress["ritual3"] = board.spells[2].name
	egress["sorcery1"] = board.spells[3].name
	egress["sorcery2"] = board.spells[4].name
	egress["sorcery3"] = board.spells[5].name
	egress["charm1"] = board.spells[6].name
	egress["charm2"] = board.spells[7].name
	egress["charm3"] = board.spells[8].name

	human.ws.send(json.dumps(egress))

	egress = { "type": "spelltextsetup" }

	egress["ritual1"] = board.spells[0].text
	egress["ritual2"] = board.spells[1].text
	egress["ritual3"] = board.spells[2].text
	egress["sorcery1"] = board.spells[3].text
	egress["sorcery2"] = board.spells[4].text
	egress["sorcery3"] = board.spells[5].text
	egress["charm1"] = board.spells[6].text
	egress["charm2"] = board.spells[7].text
	egress["charm3"] = board.spells[8].text

	human.ws.send(json.dumps(egress))


	board.nodes['a1'].stone = 'red'
	board.nodes['b1'].stone = 'blue'
	board.update()
	time.sleep(3)


	while True:
		### First take a snapshot of the board,
		### which we will revert to in case of a reset exception.
		board.take_snapshot()

		board.turncounter += 1

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
			human.ws.send(json.dumps(egress))

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
			human.jmessage("Resetting Turn")

			snapshot = board.snapshot

			board.turncounter = snapshot["turncounter"]
			board.gameover = snapshot["gameover"]
			board.winner = snapshot["winner"]
			board.score = snapshot["score"]

			egress = {"type": "doneselecting"}
			human.ws.send(json.dumps(egress))


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


def opp_chat_listen(ws, opp_ws):
	while True:
		ingress = opp_ws.receive()
		message = json.loads(ingress)['message']
		egress = {"type": "chatmessage", "player": "Me:", "message": message }
		opp_ws.send(json.dumps(egress))
		egress = {"type": "chatmessage", "player": "Opp:", "message": message }
		ws.send(json.dumps(egress))



@sock.route('/api/chat')
def chat(ws):
	global chatterlist
	global chattercount
	chatterlist.append(ws)
	chattercount += 1
	if chattercount %2 == 1:
		while True:
			time.sleep(1)
	else:
		opp_ws = chatterlist[-2]

		t = Thread(target=opp_chat_listen, args=(ws, opp_ws))
		t.start()

		while True:
			ingress = ws.receive()
			message = json.loads(ingress)['message']
			egress = {"type": "chatmessage", "player": "Me:", "message": message }
			ws.send(json.dumps(egress))
			egress = {"type": "chatmessage", "player": "Opp:", "message": message }
			opp_ws.send(json.dumps(egress))

		t.join()



privatechatdict = {}

@sock.route('/api/privatechat/<privatechatname>')
def privatechat(ws, privatechatname):
	global privatechatdict
	if privatechatname not in privatechatdict:
		privatechatdict[privatechatname] = ws
		while True:
			time.sleep(1)
	else:
		opp_ws = privatechatdict[privatechatname]

		t = Thread(target=opp_chat_listen, args=(ws, opp_ws))
		t.start()

		while True:
			ingress = ws.receive()
			message = json.loads(ingress)['message']
			egress = {"type": "chatmessage", "player": "Me:", "message": message }
			ws.send(json.dumps(egress))
			egress = {"type": "chatmessage", "player": "Opp:", "message": message }
			opp_ws.send(json.dumps(egress))

		t.join()


if __name__ == "__main__":
	app.run(host='0.0.0.0')
