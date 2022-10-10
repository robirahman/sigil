### Sigil Online


import json
import time

from flask import Flask, render_template, redirect, url_for, request, flash
from werkzeug.security import generate_password_hash, check_password_hash
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, login_user, login_required, logout_user, current_user, UserMixin
from flask_sock import Sock
from random import randint, randrange
from threading import Thread
from simple_websocket import ConnectionClosed

from game import Board, Player, resetException
from singleplayergame import SPBoard, AIPlayer







app = Flask(__name__)
sock = Sock(app)
# ping every 2 seconds
app.config['SOCK_SERVER_OPTIONS'] = {'ping_interval': 2}
app.config['SECRET_KEY'] = 'such-high-entropy-wow47830874dh3'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///db.sqlite'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)


class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True) # primary keys are required by SQLAlchemy
    email = db.Column(db.String(100), unique=True)
    password = db.Column(db.String(100))
    name = db.Column(db.String(1000))


login_manager = LoginManager()
login_manager.login_view = 'login'
login_manager.init_app(app)

@login_manager.user_loader
def load_user(user_id):
    # since the user_id is just the primary key of our user table, use it in the query for the user
    return User.query.get(int(user_id))

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

@app.route('/profile')
@login_required
def profile():
    return render_template('profile.html', name=current_user.name)

@app.route('/login')
def login():
    return render_template('login.html')

@app.route('/login', methods=['POST'])
def login_post():
    # login code goes here
    email = request.form.get('email')
    password = request.form.get('password')
    remember = True if request.form.get('remember') else False

    user = User.query.filter_by(email=email).first()

    # check if the user actually exists
    # take the user-supplied password, hash it, and compare it to the hashed password in the database
    if not user or not check_password_hash(user.password, password):
        flash('Please check your login details and try again.')
        return redirect(url_for('login')) # if the user doesn't exist or password is wrong, reload the page

    # if the above check passes, then we know the user has the right credentials
    login_user(user, remember=remember)
    return redirect(url_for('profile'))

@app.route('/signup')
def signup():
    return render_template('signup.html')

@app.route('/signup', methods=['POST'])
def signup_post():
    # code to validate and add user to database goes here
    email = request.form.get('email')
    name = request.form.get('name')
    password = request.form.get('password')

    user = User.query.filter_by(email=email).first() # if this returns a user, then the email already exists in database

    if user: # if a user is found, we want to redirect back to signup page so user can try again
        flash('Email address already exists')
        return redirect(url_for('signup'))

    # create a new user with the form data. Hash the password so the plaintext version isn't saved.
    new_user = User(email=email, name=name, password=generate_password_hash(password, method='sha256'))

    # add the new user to the database
    db.session.add(new_user)
    db.session.commit()

    return redirect(url_for('login'))

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('home'))

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





# createdgames is a dict with keys = gamename, values = [player_websocket, is_started]
createdgames = {}



@sock.route('/api/creategame')
def creategame(ws):
	global createdgames
	ingress = ws.receive()
	gamename = json.loads(ingress)['gamename']
	if (gamename in createdgames) or (gamename == ""):
		# ws will close as this function exits
		egress =  {"type": "nameconflict"}
		ws.send(json.dumps(egress))
	else:
		createdgames[gamename] = [ws, False]
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
	if (gamename in createdgames) and (createdgames[gamename][1] == False):
		egress =  {"type": "startprivategame", "gamename": gamename + str(randrange(100000000))}
		createdgames[gamename][0].send(json.dumps(egress))
		ws.send(json.dumps(egress))
		createdgames[gamename][1] = True
	else:
		egress =  {"type": "notfound"}
		ws.send(json.dumps(egress))

@app.route('/privategameboard/<gamename>')
def privategameboard(gamename):
	return render_template('gameboard.html', privategamename= "'" + gamename + "'")


def countdown_timer(red, blue):
	try:
		while True:
			time.sleep(1)
			if red.timer_running:
				red.timer -= 1
				if red.timer == 0:
					red.board.gameover = True
					red.board.winner = 'blue'
					red.board.end_game()
					break
				egress =  {"type": "red_timer", "seconds": red.timer}
				red.ws.send(json.dumps(egress))
				blue.ws.send(json.dumps(egress))
			elif blue.timer_running:
				blue.timer -= 1
				if blue.timer == 0:
					blue.board.gameover = True
					blue.board.winner = 'red'
					blue.board.end_game()
					break
				egress =  {"type": "blue_timer", "seconds": blue.timer}
				red.ws.send(json.dumps(egress))
				blue.ws.send(json.dumps(egress))
	except:
		### determine which player disconnected
		try:
			red.jmessage("Opponent disconnected. You Win!")
		except:
			try:
				blue.jmessage("Opponent disconnected. You Win!")
			except:
				### both are disconnected
				pass


### Websocket objects for the waiting player, if there is one
waiting_player_ws = None
waiting_chatter_ws = None


### Checks that waiting_player has both websockets working. If not, sets them both to None.
def cleanup_queue():
	global waiting_player_ws
	global waiting_chatter_ws

	try:
		if waiting_player_ws and waiting_chatter_ws:
			egress =  {"type": "message", "message": "Waiting for opponent to join...", "awaiting": None, }
			waiting_player_ws.send(json.dumps(egress))

			egress = {"type": "chatmessage", "player": "", "message": "Looking for opponent..." }
			waiting_chatter_ws.send(json.dumps(egress))
		else:
			waiting_player_ws = None
			waiting_chatter_ws = None

	except:
		waiting_player_ws = None
		waiting_chatter_ws = None




@sock.route('/api/game')
def playgame(ws):
	global waiting_player_ws

	cleanup_queue()
	
	if not waiting_player_ws:
		egress =  {"type": "message", "message": "Waiting for opponent to join...", "awaiting": None, }
		ws.send(json.dumps(egress))
		waiting_player_ws = ws
		while True:
			time.sleep(1)
	else:
		opp_ws = waiting_player_ws
		waiting_player_ws = None
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

		try:
			red.jmessage("You are RED this game.")
			blue.jmessage("You are BLUE this game.")


			### spellsetup is a JSON dictionary with keys "ritual2", "charm3", etc.,
			### and values "Fireblast", "Flourish", etc.
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

			countdown_timer_thread = Thread(target=countdown_timer, args=(red, blue))
			countdown_timer_thread.start()


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

					red.spellcounter = snapshot["redspellcounter"]
					blue.spellcounter = snapshot["bluespellcounter"]
					board.last_play = snapshot["last_play"]
					board.last_player = snapshot["last_player"]

					board.update(True)

					continue

		except:
			### determine which player disconnected
			try:
				red.jmessage("Opponent disconnected. You Win!")
			except:
				try:
					blue.jmessage("Opponent disconnected. You Win!")
				except:
					### both are disconnected
					pass




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

		try:
			red.jmessage("You are RED this game.")
			blue.jmessage("You are BLUE this game.")


			### spellsetup is a JSON dictionary with keys "ritual2", "charm3", etc.,
			### and values "Fireblast", "Flourish", etc.
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

					red.spellcounter = snapshot["redspellcounter"]
					blue.spellcounter = snapshot["bluespellcounter"]
					board.last_play = snapshot["last_play"]
					board.last_player = snapshot["last_player"]

					board.update(True)

					continue
		except:
			### determine which player disconnected
			try:
				red.jmessage("Opponent disconnected. You Win!")
			except:
				try:
					blue.jmessage("Opponent disconnected. You Win!")
				except:
					### both are disconnected
					pass



@sock.route('/api/singleplayergame')
def playsingleplayergame(ws):
	try:
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
		### and values "Fireblast", "Flourish", etc.
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

				red.spellcounter = snapshot["redspellcounter"]
				blue.spellcounter = snapshot["bluespellcounter"]
				board.last_play = snapshot["last_play"]
				board.last_player = snapshot["last_player"]

				board.update(True)

				continue
	except:
		pass


def opp_chat_listen(ws, opp_ws):
	try:
		while True:
			ingress = opp_ws.receive()
			message = json.loads(ingress)['message']
			egress = {"type": "chatmessage", "player": "Me:", "message": message }
			opp_ws.send(json.dumps(egress))
			egress = {"type": "chatmessage", "player": "Opp:", "message": message }
			ws.send(json.dumps(egress))
	except:
		pass



@sock.route('/api/chat')
def chat(ws):
	global waiting_chatter_ws

	# wait for cleanup_queue from /api/game to complete
	time.sleep(.1)

	try:
		if not waiting_chatter_ws:
			waiting_chatter_ws = ws
			while True:
				time.sleep(1)
		else:
			opp_ws = waiting_chatter_ws
			waiting_chatter_ws = None

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
	except:
		pass



privatechatdict = {}

@sock.route('/api/privatechat/<privatechatname>')
def privatechat(ws, privatechatname):
	global privatechatdict

	try:
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
	except:
		pass


if __name__ == "__main__":
	app.run(host='0.0.0.0')
