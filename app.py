### Sigil Online


import json
import time
import math

from flask import Flask, render_template, redirect, url_for, request, flash
from werkzeug.security import generate_password_hash, check_password_hash
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, login_user, login_required, logout_user, current_user, UserMixin
from flask_sock import Sock
from random import randint, randrange
from threading import Thread
from simple_websocket import ConnectionClosed
from datetime import datetime
from pytz import timezone
from sqlalchemy import func

from game import Board, Player, resetException, redwinsException, bluewinsException
from singleplayergame import SPBoard, AIPlayer
from nn_ai_player import NNAIPlayer
from ai.mcts_ai_player import MCTSAIPlayer
from ai.sigil_net import SigilNet
from ai.sigil_net_hard import SigilNetHard
from notation import GameRecorder
import os


class invalidCheckException(Exception):
	pass



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
    name = db.Column(db.String(100))
    elo = db.Column(db.Integer)
    ladder_game_count = db.Column(db.Integer)


login_manager = LoginManager()
login_manager.login_view = 'login'
login_manager.init_app(app)

@login_manager.user_loader
def load_user(user_id):
    # since the user_id is just the primary key of our user table, use it in the query for the user
    return User.query.get(int(user_id))


@app.route('/')
def home():
	return render_template('index.html', current_user_name=getattr(current_user, 'name', ''))

tutorialcount = 0

@app.route('/tutorial')
def tutorialAndRules():
	global tutorialcount
	tutorialcount += 1
	return render_template('tutorial.html', current_user_name=getattr(current_user, 'name', ''))

singleplayercount = 0

@app.route('/single-player')
def singlePlayer():
	global singleplayercount
	singleplayercount += 1
	difficulty = request.args.get('difficulty', 'easy')
	load_id = request.args.get('load', '')
	return render_template('single-player.html', current_user_name=getattr(current_user, 'name', ''), difficulty=difficulty, load_id=load_id)

@app.route('/single-player-menu')
def singlePlayerMenu():
	saves = _list_saves()
	return render_template('single-player-menu.html', current_user_name=getattr(current_user, 'name', ''), saves=saves)

@app.route('/api/saves')
def api_saves():
	return json.dumps(_list_saves())

@app.route('/private-match')
def privatematch():
	return render_template('private-match.html', current_user_name=getattr(current_user, 'name', ''))

@app.route('/ladder-match')
def laddermatch():
	cleanup_queue()
	return render_template('ladder-match.html', current_user_name=getattr(current_user, 'name', ''))

@app.route('/private-game/<gamename>')
def privategameboard(gamename):
	return render_template('two-player.html', privategamename=gamename, elo='', current_user_name=getattr(current_user, 'name', ''))

# If privategamename is empty, it's a ladder game
@app.route('/ladder-game')
@login_required
def laddergame():
	return render_template('two-player.html', privategamename='', check=current_user.password[8:16], elo=current_user.elo, current_user_name=current_user.name)

@app.route('/profile')
@login_required
def profile():
    return render_template('profile.html', current_user_name=current_user.name, elo=current_user.elo, ladder_game_count=current_user.ladder_game_count)

@app.route('/login')
def login():
    return render_template('login.html', current_user_name=getattr(current_user, 'name', ''))

@app.route('/login', methods=['POST'])
def login_post():
    # login code goes here
    email = request.form.get('email')
    password = request.form.get('password')
    remember = True if request.form.get('remember') else False

    user = User.query.filter(func.lower(User.email) == func.lower(email)).first()

    # check if the user actually exists
    # take the user-supplied password, hash it, and compare it to the hashed password in the database
    if not user or not check_password_hash(user.password, password):
        flash('Please check your login details and try again.')
        return render_template('login.html', email=email, password=password, remember=remember, current_user_name=getattr(current_user, 'name', ''))

    # if the above check passes, then we know the user has the right credentials
    login_user(user, remember=remember)
    return redirect(url_for('profile'))

@app.route('/signup')
def signup():
    return render_template('signup.html', current_user_name=getattr(current_user, 'name', ''))

@app.route('/signup', methods=['POST'])
def signup_post():
    # code to validate and add user to database goes here
    email = request.form.get('email').strip()
    name = request.form.get('name').strip()
    password = request.form.get('password')
    if (email == '' or name == '' or password == ''):
        flash('Fields must not be empty')
        return render_template('signup.html', email=email, name=name, password=password, current_user_name=getattr(current_user, 'name', ''))

    user = User.query.filter_by(email=email).first() # if this returns a user, then the email already exists in database

    if user: # if a user is found, we want to redirect back to signup page so user can try again
        flash('Email address already exists')
        return render_template('signup.html', email=email, name=name, password=password, current_user_name=getattr(current_user, 'name', ''))

    user = User.query.filter_by(name=name).first() # if this returns a user, then the name already exists in database

    if user: # if a user is found, we want to redirect back to signup page so user can try again
        flash('That name is already taken')
        return render_template('signup.html', email=email, name=name, password=password, current_user_name=getattr(current_user, 'name', ''))

    # create a new user with the form data. Hash the password so the plaintext version isn't saved.
    new_user = User(email=email, name=name, password=generate_password_hash(password, method='sha256'), elo=1000, ladder_game_count=0)

    # add the new user to the database
    db.session.add(new_user)
    db.session.commit()

    return redirect(url_for('login'))

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('home'))

@app.route('/api/leaderboard')
def leaderboard():
	leaderUsers = User.query.filter(User.ladder_game_count > 0).order_by(User.elo.desc()).limit(15).all()

	leaderboard = []
	for leaderUser in leaderUsers:
		leaderboard.append({
			'name': leaderUser.name,
			'elo': leaderUser.elo
		})

	return json.dumps(leaderboard)


@app.route('/api/currentladderstats')
def currentladderstats():
	global laddergamesinprogress
	global waiting_player_ws

	currentladderstats = {
		'laddergamesinprogress': laddergamesinprogress,
		'waiting_player': waiting_player_ws != None
	}

	return json.dumps(currentladderstats)



# createdgames is a dict with keys = gamename, values = [player_websocket]
createdgames = {}
privategamecount = 0



@sock.route('/api/creategame')
def creategame(ws):
	global createdgames
	ingress = ws.receive()
	gamename = json.loads(ingress)['gamename'].upper()
	if (gamename in createdgames) or (gamename == ""):
		# ws will close as this function exits
		egress =  {"type": "nameconflict"}
		ws.send(json.dumps(egress))
	else:
		createdgames[gamename] = [ws]
		egress =  {"type": "success"}
		ws.send(json.dumps(egress))
		while True:
			time.sleep(1)
			# make sure the player is still there. If not, allow thread to die.
			try:
				egress =  {"type": "ping"}
				ws.send(json.dumps(egress))
			except:
				### disconnected
				break

@sock.route('/api/joingame')
def joingame(ws):
	# ws will close as this function exits
	global createdgames
	global privategamecount
	ingress = ws.receive()
	gamename = json.loads(ingress)['gamename'].upper()
	if (gamename in createdgames):
		egress =  {"type": "startprivategame", "gamename": gamename + str(randrange(100000000))}
		createdgames[gamename][0].send(json.dumps(egress))
		ws.send(json.dumps(egress))
		createdgames.pop(gamename, None)
		privategamecount += 1
	else:
		egress =  {"type": "notfound"}
		ws.send(json.dumps(egress))



# Periodically ping both players considering a rematch private game so that if one disconnects, the other is told.
def rematch_game_ping(wslist):
	while True:
		try:
			egress =  {"type": "ping"}
			for ws in wslist:
				ws.send(json.dumps(egress))
			time.sleep(3)
		except:
			for ws in wslist:
				try:
					egress = {"type": "opponentdisconnected"}
					ws.send(json.dumps(egress))
				except:
					pass
			break

rematchwslistbygamename = {}

@sock.route('/api/rematch/<privategamename>')
def rematch(ws, privategamename):
	# ws will close as this function exits
	global rematchwslistbygamename
	global privategamecount

	rematchwslistbygamename[privategamename] = rematchwslistbygamename.get(privategamename, [])
	rematchwslistbygamename[privategamename].append(ws)
	time.sleep(3)
	rematchwslist = rematchwslistbygamename[privategamename]

	if (len(rematchwslist) < 2):
		for rematchws in rematchwslist:
			egress = {"type": "opponentdisconnected"}
			rematchws.send(json.dumps(egress))
		return

	rematch_game_ping_thread = Thread(target=rematch_game_ping, kwargs={"wslist": rematchwslist})
	rematch_game_ping_thread.start()

	while True:
		ingress = ws.receive()
		msgtype = json.loads(ingress)['type']

		if (msgtype == 'offerrematch'):
			for rematchws in rematchwslist:
				if rematchws != ws:
					egress =  {"type": "offeredrematch"}
					rematchws.send(json.dumps(egress))
		elif (msgtype == 'acceptrematch'):
			egress =  {"type": "startprivategame", "gamename": privategamename}
			for rematchws in rematchwslist:
				rematchws.send(json.dumps(egress))
				rematchws.close()
			privategamecount += 1
			break
		elif (msgtype == 'disconnect'):
			for rematchws in rematchwslist:
				rematchws.close()
			break
		else:
			raise 'Error: Socket /api/rematch/' + privategamename + ' received message with unknown type: ' + msgtype



def record_elo(winner, loser):
	global laddergamesinprogress

	if winner.board.elo_recorded:
		return

	winner.board.elo_recorded = True
	laddergamesinprogress -= 1

	winner_data = User.query.filter_by(name=winner.username).first()
	loser_data = User.query.filter_by(name=loser.username).first()

	winner_elo = winner_data.elo
	loser_elo = loser_data.elo

	exponent = (winner_elo - loser_elo)/400
	scaling_factor = 1/(1 + 10**exponent)
	points_decimal = 32*scaling_factor
	points = int(math.ceil(points_decimal))


	winner_data.elo += points
	loser_data.elo -= points

	winner_data.ladder_game_count += 1
	loser_data.ladder_game_count += 1

	db.session.commit()



def countdown_timer(red, blue):
	while True:
		try:
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
		except redwinsException:
			record_elo(red, blue)
			break
		except bluewinsException:
			record_elo(blue, red)
			break
		except:
			time.sleep(.1)
			if red.board.elo_recorded:
				break
			else:
				### determine which player disconnected
				try:
					red.jmessage("Opponent disconnected.")
					egress = { "type": "game_over" }
					egress["winner"] = 'red'
					red.ws.send(json.dumps(egress))
					record_elo(red, blue)
					break
				except:
					try:
						blue.jmessage("Opponent disconnected.")
						egress = { "type": "game_over" }
						egress["winner"] = 'blue'
						blue.ws.send(json.dumps(egress))
						record_elo(blue, red)
						break
					except:
						### both are disconnected
						break


### Websocket object for the waiting player, if there is one
waiting_player_ws = None
waiting_chatter_ws = None


### Checks that waiting_player has both websockets working. If not, sets them both to None.
def cleanup_queue():
	global waiting_player_ws
	global waiting_chatter_ws

	try:
		if waiting_player_ws and waiting_chatter_ws:
			egress =  {"type": "message", "message": "Searching for an opponent...", "awaiting": None, }
			waiting_player_ws.send(json.dumps(egress))

		else:
			waiting_player_ws = None
			waiting_chatter_ws = None

	except:
		waiting_player_ws = None
		waiting_chatter_ws = None


laddergamecount = 0
laddergamesinprogress = 0

@sock.route('/api/game')
def playgame(ws):
	global waiting_player_ws
	global laddergamecount
	global laddergamesinprogress

	cleanup_queue()
	
	if not waiting_player_ws:
		egress =  {"type": "message", "message": "Searching for an opponent...", "awaiting": None, }
		ws.send(json.dumps(egress))
		waiting_player_ws = ws
		while True:
			# make sure the player is still there. If not, an exception will be raised and the thread will terminate.
			egress =  {"type": "ping"}
			ws.send(json.dumps(egress))
			time.sleep(1)
	else:
		laddergamecount += 1
		laddergamesinprogress += 1
		opp_ws = waiting_player_ws
		waiting_player_ws = None
		board = Board()
		board.ladder_match = True
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

		egress = { "type": "username_request" }

		red.ws.send(json.dumps(egress))
		ingress = red.ws.receive()
		red_username = json.loads(ingress)['message']
		red.username = red_username

		blue.ws.send(json.dumps(egress))
		ingress = blue.ws.receive()
		blue_username = json.loads(ingress)['message']
		blue.username = blue_username

		egress = { "type": "check_request" }

		red_user = User.query.filter_by(name=red_username).first()
		blue_user = User.query.filter_by(name=blue_username).first()

		red.ws.send(json.dumps(egress))
		ingress = red.ws.receive()
		red_check = json.loads(ingress)['message']
		valid = (red_user.password[8:16] == red_check)
		if not valid:
			red.jmessage("Something went wrong - try again.")
			blue.jmessage("Something went wrong - try again.")
			raise invalidCheckException()

		blue.ws.send(json.dumps(egress))
		ingress = blue.ws.receive()
		blue_check = json.loads(ingress)['message']
		valid = (blue_user.password[8:16] == blue_check)
		if not valid:
			red.jmessage("Something went wrong - try again.")
			blue.jmessage("Something went wrong - try again.")
			raise invalidCheckException()



		red.jmessage(red_username + " versus " + blue_username)
		blue.jmessage(red_username + " versus " + blue_username)

		egress = { "type": "laddersetup" }

		egress["red_name"] = red_user.name
		egress["blue_name"] = blue_user.name
		egress["red_elo"] = red_user.elo
		egress["blue_elo"] = blue_user.elo
		egress["red_timer"] = red.timer
		egress["blue_timer"] = blue.timer

		red.ws.send(json.dumps(egress))
		blue.ws.send(json.dumps(egress))


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

		egress["ritual1"] = { "name": board.spells[0].name.replace("_", " ") , "text": board.spells[0].text }
		egress["ritual2"] = { "name": board.spells[1].name.replace("_", " ") , "text": board.spells[1].text }
		egress["ritual3"] = { "name": board.spells[2].name.replace("_", " ") , "text": board.spells[2].text }
		egress["sorcery1"] = { "name": board.spells[3].name.replace("_", " ") , "text": board.spells[3].text }
		egress["sorcery2"] = { "name": board.spells[4].name.replace("_", " ") , "text": board.spells[4].text }
		egress["sorcery3"] = { "name": board.spells[5].name.replace("_", " ") , "text": board.spells[5].text }
		egress["charm1"] = { "name": board.spells[6].name.replace("_", " ") , "text": board.spells[6].text }
		egress["charm2"] = { "name": board.spells[7].name.replace("_", " ") , "text": board.spells[7].text }
		egress["charm3"] = { "name": board.spells[8].name.replace("_", " ") , "text": board.spells[8].text }

		red.ws.send(json.dumps(egress))
		blue.ws.send(json.dumps(egress))


		board.nodes['a1'].stone = 'red'
		board.nodes['b1'].stone = 'blue'
		board.update()
		time.sleep(3)

		countdown_timer_thread = Thread(target=countdown_timer, args=(red, blue))
		countdown_timer_thread.start()

		reset_this_turn = False

		while True:
			try:
				if not reset_this_turn:
					### First take a snapshot of the board,
					### which we will revert to in case of a reset exception.
					try:
						board.take_snapshot()
					except redwinsException:
						record_elo(red, blue)
						break
					except bluewinsException:
						record_elo(blue, red)
						break

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
					reset_this_turn = False
					if board.gameover:
						board.end_game()
						break

				except redwinsException:
					record_elo(red, blue)
					break

				except bluewinsException:
					record_elo(blue, red)
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
					reset_this_turn = True

					continue

			except:
				### determine which player disconnected
				try:
					red.jmessage("Opponent disconnected.")
					egress = { "type": "game_over" }
					egress["winner"] = 'red'
					red.ws.send(json.dumps(egress))
					record_elo(red, blue)
					break
				except:
					try:
						blue.jmessage("Opponent disconnected.")
						egress = { "type": "game_over" }
						egress["winner"] = 'blue'
						blue.ws.send(json.dumps(egress))
						record_elo(blue, red)
						break
					except:
						### both are disconnected
						break



# Periodically ping both players in a private game so that if one disconnects, the other wins.
def private_game_ping(red, blue):
	while True:
		try:
			time.sleep(3)
			if red.board.gameover:
				break
			egress =  {"type": "ping"}
			red.ws.send(json.dumps(egress))
			blue.ws.send(json.dumps(egress))
		except:
			### determine which player disconnected
			try:
				red.jmessage("Opponent disconnected.")
				egress = { "type": "game_over" }
				egress["winner"] = 'red'
				red.ws.send(json.dumps(egress))
				break
			except:
				try:
					blue.jmessage("Opponent disconnected.")
					egress = { "type": "game_over" }
					egress["winner"] = 'blue'
					blue.ws.send(json.dumps(egress))
					break
				except:
					### both are disconnected
					break




privategamedict = {}

@sock.route('/api/privategame/<privategamename>')
def playprivategame(ws, privategamename):
	global privategamedict
	if privategamename not in privategamedict:
		privategamedict[privategamename] = ws
		while True:
			# make sure the player is still there. If not, an exception will be raised and the thread will terminate.
			egress =  {"type": "ping"}
			ws.send(json.dumps(egress))
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

		egress["ritual1"] = { "name": board.spells[0].name.replace("_", " ") , "text": board.spells[0].text }
		egress["ritual2"] = { "name": board.spells[1].name.replace("_", " ") , "text": board.spells[1].text }
		egress["ritual3"] = { "name": board.spells[2].name.replace("_", " ") , "text": board.spells[2].text }
		egress["sorcery1"] = { "name": board.spells[3].name.replace("_", " ") , "text": board.spells[3].text }
		egress["sorcery2"] = { "name": board.spells[4].name.replace("_", " ") , "text": board.spells[4].text }
		egress["sorcery3"] = { "name": board.spells[5].name.replace("_", " ") , "text": board.spells[5].text }
		egress["charm1"] = { "name": board.spells[6].name.replace("_", " ") , "text": board.spells[6].text }
		egress["charm2"] = { "name": board.spells[7].name.replace("_", " ") , "text": board.spells[7].text }
		egress["charm3"] = { "name": board.spells[8].name.replace("_", " ") , "text": board.spells[8].text }

		red.ws.send(json.dumps(egress))
		blue.ws.send(json.dumps(egress))


		board.nodes['a1'].stone = 'red'
		board.nodes['b1'].stone = 'blue'
		board.update()
		time.sleep(3)

		private_game_ping_thread = Thread(target=private_game_ping, args=(red, blue))
		private_game_ping_thread.start()

		reset_this_turn = False

		while True:
			try:
				if not reset_this_turn:
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
					reset_this_turn = False
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
					reset_this_turn = True

					continue
			except:
				if board.gameover:
					break
				### determine which player disconnected
				try:
					red.jmessage("Opponent disconnected.")
					egress = { "type": "game_over" }
					egress["winner"] = 'red'
					red.ws.send(json.dumps(egress))
					board.gameover = True
					break
				except:
					try:
						blue.jmessage("Opponent disconnected.")
						egress = { "type": "game_over" }
						egress["winner"] = 'blue'
						blue.ws.send(json.dumps(egress))
						board.gameover = True
						break
					except:
						### both are disconnected
						break



_APP_DIR = os.path.dirname(os.path.abspath(__file__))

def _save_sgn(recorder):
	games_dir = os.path.join(_APP_DIR, 'games')
	os.makedirs(games_dir, exist_ok=True)
	from datetime import datetime as dt
	timestamp = dt.now().strftime('%Y%m%d_%H%M%S_%f')
	filepath = os.path.join(games_dir, f'game_{timestamp}.sgn')
	with open(filepath, 'w') as f:
		f.write(recorder.to_sgn())

def _save_game_state(board, recorder, human_color, difficulty, save_id):
	"""Auto-save the current game state so it can be resumed later."""
	from notation import board_to_sfn
	saves_dir = os.path.join(_APP_DIR, 'saves')
	os.makedirs(saves_dir, exist_ok=True)
	filepath = os.path.join(saves_dir, f'{save_id}.json')
	data = {
		'sfn': board_to_sfn(board),
		'human_color': human_color,
		'difficulty': difficulty,
		'sgn_so_far': recorder.to_sgn(),
		'finished': board.gameover,
	}
	with open(filepath, 'w') as f:
		json.dump(data, f)

def _delete_save(save_id):
	filepath = os.path.join(_APP_DIR, 'saves', f'{save_id}.json')
	if os.path.exists(filepath):
		os.remove(filepath)

def _list_saves():
	saves_dir = os.path.join(_APP_DIR, 'saves')
	if not os.path.isdir(saves_dir):
		return []
	saves = []
	for fname in sorted(os.listdir(saves_dir), reverse=True):
		if not fname.endswith('.json'):
			continue
		try:
			with open(os.path.join(saves_dir, fname)) as f:
				data = json.load(f)
			if data.get('finished'):
				continue
			from notation import sfn_to_dict
			state = sfn_to_dict(data['sfn'])
			saves.append({
				'id': fname[:-5],
				'human_color': data['human_color'],
				'difficulty': data['difficulty'],
				'turn': state['turncounter'],
				'score': state['score'],
			})
		except Exception:
			continue
	return saves

def _load_save(save_id):
	filepath = os.path.join(_APP_DIR, 'saves', f'{save_id}.json')
	with open(filepath) as f:
		return json.load(f)

@sock.route('/api/singleplayergame')
def playsingleplayergame(ws):
	_run_singleplayer_game(ws, ai_class=AIPlayer, difficulty='easy')

@sock.route('/api/singleplayergame_medium')
def playsingleplayergame_medium(ws):
	_run_singleplayer_game(ws, ai_class=MCTSAIPlayer, difficulty='medium',
						   ai_kwargs={'net_class': SigilNet})

@sock.route('/api/singleplayergame_hard')
def playsingleplayergame_hard(ws):
	_run_singleplayer_game(ws, ai_class=MCTSAIPlayer, difficulty='hard',
						   ai_kwargs={'net_class': SigilNetHard})

@sock.route('/api/singleplayergame_load')
def playsingleplayergame_load(ws):
	# First message from client tells us which save to load
	ingress = ws.receive()
	msg = json.loads(ingress)
	save_id = msg.get('message', '')
	try:
		save_data = _load_save(save_id)
	except Exception:
		ws.send(json.dumps({"type": "message", "message": "Failed to load save."}))
		return
	difficulty = save_data.get('difficulty', 'easy')
	if difficulty == 'hard':
		ai_class = MCTSAIPlayer
		ai_kwargs = {'net_class': SigilNetHard}
	elif difficulty == 'medium':
		ai_class = MCTSAIPlayer
		ai_kwargs = {'net_class': SigilNet}
	else:
		ai_class = AIPlayer
		ai_kwargs = {}
	_run_singleplayer_game(ws, ai_class=ai_class, difficulty=difficulty,
						   ai_kwargs=ai_kwargs,
						   load_save=save_data, save_id=save_id)

def _run_singleplayer_game(ws, ai_class=AIPlayer, difficulty='easy',
						   ai_kwargs=None, load_save=None, save_id=None):
	from notation import sfn_to_dict
	import uuid

	if save_id is None:
		save_id = str(uuid.uuid4())[:8]

	board = SPBoard()

	if load_save is not None:
		# Restore from save
		human_color = load_save['human_color']
		humancolor = 1 if human_color == 'red' else 2
	else:
		humancolor = randint(1,2)

	if ai_kwargs is None:
		ai_kwargs = {}

	if humancolor == 1:
		human = Player(board, 'red')
		ai = ai_class(board, 'blue', **ai_kwargs)
		board.addplayers(human, ai)
		human.opp = ai
		ai.opp = human
		human.ws = ws
		human.jmessage("You are RED this game.")
		red = human
		blue = ai

	else:
		human = Player(board, 'blue')
		ai = ai_class(board, 'red', **ai_kwargs)
		board.addplayers(human, ai)
		human.opp = ai
		ai.opp = human
		human.ws = ws
		human.jmessage("You are BLUE this game.")
		blue = human
		red = ai


	human_color = human.color

	### If loading a saved game, restore the board state from SFN
	if load_save is not None:
		state = sfn_to_dict(load_save['sfn'])
		board.set_spells_from_names(state['spell_names'])
		for nodename in board.nodes:
			board.nodes[nodename].stone = state['stones'][nodename]
		board.turncounter = state['turncounter']
		board.whoseturn = state['turn']
		board.score = state['score']
		red.spellcounter = state['red_spellcounter']
		blue.spellcounter = state['blue_spellcounter']
		if state['red_lock']:
			red.lock = board.spelldict[state['red_lock']]
		if state['blue_lock']:
			blue.lock = board.spelldict[state['blue_lock']]
		if state['red_springlock']:
			red.springlock = board.spelldict[state['red_springlock']]
		if state['blue_springlock']:
			blue.springlock = board.spelldict[state['blue_springlock']]
		board.update()
		human.jmessage("Resuming saved game...")

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

	egress["ritual1"] = { "name": board.spells[0].name.replace("_", " ") , "text": board.spells[0].text }
	egress["ritual2"] = { "name": board.spells[1].name.replace("_", " ") , "text": board.spells[1].text }
	egress["ritual3"] = { "name": board.spells[2].name.replace("_", " ") , "text": board.spells[2].text }
	egress["sorcery1"] = { "name": board.spells[3].name.replace("_", " ") , "text": board.spells[3].text }
	egress["sorcery2"] = { "name": board.spells[4].name.replace("_", " ") , "text": board.spells[4].text }
	egress["sorcery3"] = { "name": board.spells[5].name.replace("_", " ") , "text": board.spells[5].text }
	egress["charm1"] = { "name": board.spells[6].name.replace("_", " ") , "text": board.spells[6].text }
	egress["charm2"] = { "name": board.spells[7].name.replace("_", " ") , "text": board.spells[7].text }
	egress["charm3"] = { "name": board.spells[8].name.replace("_", " ") , "text": board.spells[8].text }

	human.ws.send(json.dumps(egress))


	spell_names = [board.spells[i].name for i in range(9)]
	red_name = 'Human' if human.color == 'red' else 'AI'
	blue_name = 'Human' if human.color == 'blue' else 'AI'
	recorder = GameRecorder(spell_names, red_name=red_name, blue_name=blue_name)
	board.recorder = recorder

	if load_save is None:
		board.nodes['a1'].stone = 'red'
		board.nodes['b1'].stone = 'blue'
		board.update()

	time.sleep(3)

	reset_this_turn = False
	game_saved = False

	try:
		while True:
			if not reset_this_turn:
				### First take a snapshot of the board,
				### which we will revert to in case of a reset exception.
				board.take_snapshot()
				### Auto-save the game state so it can be resumed if disconnected
				try:
					_save_game_state(board, recorder, human_color, difficulty, save_id)
				except Exception:
					pass

			board.turncounter += 1

			if board.turncounter % 2 == 1:
				activeplayer = red
				board.whoseturn = 'red'
			else:
				activeplayer = blue
				board.whoseturn = 'blue'


			try:
				if board.whoseturn == 'red':
					turn_num = (board.turncounter // 2) + 1
					message = "Red Turn " + str(turn_num)
				elif board.whoseturn == 'blue':
					turn_num = board.turncounter // 2
					message = "Blue Turn " + str(turn_num)

				board.start_turn_recording(board.whoseturn, turn_num)

				egress = { "type": "whoseturndisplay", "color": board.whoseturn, "message": message }
				human.ws.send(json.dumps(egress))

				activeplayer.bot_triggers()
				if board.gameover:
					board.end_game_recording()
					_save_sgn(recorder)
					_delete_save(save_id)
					game_saved = True
					break

				if board.whoseturn == 'red':
					red.taketurn()
				else:
					blue.taketurn()

				activeplayer.eot_triggers()
				board.update(True)
				reset_this_turn = False
				if board.gameover:
					board.end_game_recording()
					_save_sgn(recorder)
					_delete_save(save_id)
					game_saved = True
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
				reset_this_turn = True

				continue
	except Exception:
		pass
	finally:
		if board.gameover:
			try:
				board.end_game()
				time.sleep(1)
			except Exception:
				pass
		if not game_saved:
			try:
				recorder.end_game(board.winner)
				_save_sgn(recorder)
			except Exception:
				pass


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
	global waiting_chatter_ws

	# wait for cleanup_queue from /api/game to complete
	time.sleep(.1)

	if not waiting_chatter_ws:
		waiting_chatter_ws = ws
		for i in range(5000):
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



privatechatdict = {}

@sock.route('/api/privatechat/<privatechatname>')
def privatechat(ws, privatechatname):
	global privatechatdict

	if privatechatname not in privatechatdict:
		privatechatdict[privatechatname] = ws
		for i in range(5000):
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




def metrics_recorder():
	while True:
		time.sleep(3600)
		eastern = timezone('US/Eastern')
		now = datetime.now(eastern)
		# Format is dd/mm/YY H:M:S
		timestamp_string = now.strftime("%d/%m/%Y %H:%M:%S")
		metrics_file = open("metrics.txt", "a")
		# format is:
		#timestamp,tutorial,singleplayer,privategame,laddergame
		metrics_file.write(timestamp_string + "," + str(tutorialcount) + "," + str(singleplayercount) + "," + str(privategamecount) + "," + str(laddergamecount) + "\n")
		metrics_file.close()
		

metrics_file = open("metrics.txt", "a")
metrics_file.write("REBOOT" + "\n")
metrics_file.close()

metrics_thread = Thread(target=metrics_recorder)
metrics_thread.start()


if __name__ == "__main__":
	app.run(host='0.0.0.0')
