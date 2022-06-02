### Sigil Online


import json
import time

from flask import Flask, render_template
from flask_sock import Sock
from random import randint
from threading import Thread

from game import Board, Player, resetException
			




##############  GAME LOOP  ##############

### First we set up the objects.  This is my hack-y way of passing
### everyone as parameters to everyone else: doing it
### in two layers, using the board.addplayers method

playercount = 0
playerlist = []

chattercount = 0
chatterlist = []



app = Flask(__name__)
sock = Sock(app)
# ping every 2 seconds
app.config['SOCK_SERVER_OPTIONS'] = {'ping_interval': 2}


@app.route('/')
def home():
    return render_template('home.html')

@app.route('/gameboard')
def gameboard():
    return render_template('gameboard.html')

@app.route('/tutorial')
def tutorial():
    return render_template('tutorial.html')

@app.route('/singleplayer')
def singleplayer():
    return render_template('singleplayer.html')

@app.route('/laddermatch')
def laddermatch():
    return render_template('laddermatch.html')

@app.route('/privatematch')
def privatematch():
    return render_template('privatematch.html')

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


		### spellsetup is a JSON dictionary with keys "major2", "charm3", etc.,
		### and values "Searing_Wind", "Creeping_Vines", etc.
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



def opp_chat_listen(ws, opp_ws):
	while True:
		ingress = opp_ws.receive()
		message = json.loads(ingress)['message']
		if message == "ping":
			egress =  {"type": "pong"}
			opp_ws.send(json.dumps(egress))
			continue
		else:
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
			if message == "ping":
				egress =  {"type": "pong"}
				ws.send(json.dumps(egress))
				continue
			else:
				egress = {"type": "chatmessage", "player": "Me:", "message": message }
				ws.send(json.dumps(egress))
				egress = {"type": "chatmessage", "player": "Opp:", "message": message }
				opp_ws.send(json.dumps(egress))

		t.join()


if __name__ == "__main__":
    app.run(host='0.0.0.0')


