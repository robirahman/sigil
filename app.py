### Sigil Online


import json
import time
import math

import uuid

from flask import Flask, render_template, redirect, url_for, request, flash
from werkzeug.security import generate_password_hash, check_password_hash
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, login_user, login_required, logout_user, current_user, UserMixin
from flask_sock import Sock
from random import randint, randrange
from threading import Thread, Event, Lock
from simple_websocket import ConnectionClosed
from datetime import datetime
from pytz import timezone
from sqlalchemy import func

from game import Board, Player, resetException, redwinsException, bluewinsException
from singleplayergame import SPBoard, AIPlayer
from ai.nn_ai_player import NNAIPlayer
from ai.mcts_ai_player import MCTSAIPlayer
from ai.sigil_net import SigilNet
from ai.sigil_net_hard import SigilNetHard
from notation import GameRecorder, board_to_sfn, sfn_to_dict
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
	# Legacy bookmark shim: /single-player?load=<id> -> /single-player/<id>
	load_id = request.args.get('load', '')
	if load_id:
		return redirect(url_for('singlePlayerGame', save_id=load_id))
	difficulty = request.args.get('difficulty', 'easy')
	variant = request.args.get('variant', 'standard')
	if variant not in ('standard', 'competitive'):
		variant = 'standard'
	save_id = uuid.uuid4().hex[:8]
	return redirect(url_for('singlePlayerGame', save_id=save_id,
							difficulty=difficulty, variant=variant))

@app.route('/single-player/<save_id>')
def singlePlayerGame(save_id):
	global singleplayercount
	# Canonical per-game URL. If a save exists, resume it; otherwise start fresh.
	if _save_exists(save_id):
		try:
			save_data = _load_save(save_id)
		except Exception:
			save_data = None
		if save_data and not save_data.get('finished') and save_data.get('mode', 'single_player') == 'single_player':
			difficulty = save_data.get('difficulty', 'easy')
			try:
				variant = sfn_to_dict(save_data['sfn']).get('variant', 'standard')
			except Exception:
				variant = 'standard'
			return render_template('single-player.html',
								   current_user_name=getattr(current_user, 'name', ''),
								   difficulty=difficulty, save_id=save_id,
								   load_id=save_id, variant=variant)
	# No save yet — fresh game using this id.
	difficulty = request.args.get('difficulty', 'easy')
	variant = request.args.get('variant', 'standard')
	if variant not in ('standard', 'competitive'):
		variant = 'standard'
	return render_template('single-player.html',
						   current_user_name=getattr(current_user, 'name', ''),
						   difficulty=difficulty, save_id=save_id,
						   load_id='', variant=variant)

@app.route('/single-player-menu')
def singlePlayerMenu():
	saves = _list_saves()
	return render_template('single-player-menu.html', current_user_name=getattr(current_user, 'name', ''), saves=saves)

@app.route('/api/saves')
def api_saves():
	return json.dumps(_list_saves())

@app.route('/local-1v1')
def local1v1():
	# Mint a canonical per-game URL. Imports are pre-saved server-side
	# so the per-game URL hydrates them on first load.
	import_sfn = request.args.get('sfn', '')
	variant = request.args.get('variant', 'standard')
	if variant not in ('standard', 'competitive'):
		variant = 'standard'
	game_id = uuid.uuid4().hex[:8]
	if import_sfn:
		try:
			imported_variant = sfn_to_dict(import_sfn).get('variant') or variant
		except Exception:
			imported_variant = variant
		_save_local1v1_sfn(game_id, import_sfn, imported_variant)
		return redirect(url_for('local1v1Game', game_id=game_id))
	return redirect(url_for('local1v1Game', game_id=game_id, variant=variant))

@app.route('/local-1v1/<game_id>')
def local1v1Game(game_id):
	variant = request.args.get('variant', 'standard')
	if variant not in ('standard', 'competitive'):
		variant = 'standard'
	if _save_exists(game_id):
		try:
			save_data = _load_save(game_id)
		except Exception:
			save_data = None
		if save_data and save_data.get('mode') == 'local_1v1' and not save_data.get('finished'):
			try:
				variant = sfn_to_dict(save_data['sfn']).get('variant', variant)
			except Exception:
				pass
	return render_template('local-1v1.html', current_user_name=getattr(current_user, 'name', ''),
						   game_mode='local1v1', game_id=game_id, import_sfn='', variant=variant)

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

# Resumable per-game URL for ladder. The id is minted at match time; the
# client lands here via history.replaceState after the WS sends `assigned_id`,
# so reloading the tab brings the player back into the same game.
@app.route('/ladder-game/<game_id>')
@login_required
def ladderGameById(game_id):
	return render_template('two-player.html', privategamename='', game_id=game_id,
						   check=current_user.password[8:16], elo=current_user.elo,
						   current_user_name=current_user.name)

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
	"""Tick once per second for the active player's clock. With the
	reconnect-aware game loop, this thread no longer ends the game on
	WS errors — it just skips failed sends and keeps ticking. If the
	disconnected player's clock runs out, end_game fires and the loop
	exits normally."""
	while True:
		time.sleep(1)
		if red.board.gameover:
			break
		try:
			if red.timer_running:
				red.timer -= 1
				if red.timer == 0:
					red.board.gameover = True
					red.board.winner = 'blue'
					try:
						red.board.end_game()
					except (redwinsException, bluewinsException):
						pass
					except Exception:
						pass
					try:
						record_elo(blue, red)
					except Exception:
						pass
					break
				egress = {"type": "red_timer", "seconds": red.timer}
			elif blue.timer_running:
				blue.timer -= 1
				if blue.timer == 0:
					blue.board.gameover = True
					blue.board.winner = 'red'
					try:
						blue.board.end_game()
					except (redwinsException, bluewinsException):
						pass
					except Exception:
						pass
					try:
						record_elo(red, blue)
					except Exception:
						pass
					break
				egress = {"type": "blue_timer", "seconds": blue.timer}
			else:
				continue
			for player_ws in (red.ws, blue.ws):
				try:
					player_ws.send(json.dumps(egress))
				except Exception:
					pass
		except redwinsException:
			record_elo(red, blue)
			break
		except bluewinsException:
			record_elo(blue, red)
			break
		except Exception:
			# Unexpected error; back off briefly and keep ticking.
			time.sleep(0.5)


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
		ws.send(json.dumps({"type": "message", "message": "Searching for an opponent...", "awaiting": None}))
		waiting_player_ws = ws
		try:
			while True:
				ws.send(json.dumps({"type": "ping"}))
				time.sleep(1)
		except Exception:
			if waiting_player_ws is ws:
				waiting_player_ws = None
		return

	laddergamecount += 1
	laddergamesinprogress += 1
	opp_ws = waiting_player_ws
	waiting_player_ws = None
	_run_ladder_game(ws, opp_ws)


@sock.route('/api/laddergame/<game_id>')
@login_required
def playladdergame_reconnect(ws, game_id):
	"""Reconnect into a ladder game after a tab reload."""
	session = multiplayer_sessions.get(game_id)
	if not session or session.mode != 'ladder':
		try:
			ws.send(json.dumps({"type": "message", "message": "Ladder game not found or already ended."}))
		except Exception:
			pass
		return
	# Only allow the two original players to reclaim a slot.
	requesting_name = current_user.name
	if requesting_name == session.red.username:
		role = 'red'
	elif requesting_name == session.blue.username:
		role = 'blue'
	else:
		try:
			ws.send(json.dumps({"type": "message", "message": "You are not a player in this game."}))
		except Exception:
			pass
		return
	# Confirm that the slot is actually waiting for a reconnect.
	target = session.red if role == 'red' else session.blue
	if _ws_alive(target.ws):
		try:
			ws.send(json.dumps({"type": "message", "message": "You are already connected in another tab."}))
		except Exception:
			pass
		return
	session.request_reconnect(role, ws)
	_hold_reconnect_ws_open(session, ws)


def _run_ladder_game(ws, opp_ws):
	board = Board()
	board.ladder_match = True
	red = Player(board, 'red')
	blue = Player(board, 'blue')
	board.addplayers(red, blue)
	red.opp = blue
	blue.opp = red
	whoisred = randint(1, 2)
	if whoisred == 1:
		red.ws = ws
		blue.ws = opp_ws
	else:
		red.ws = opp_ws
		blue.ws = ws

	red.jmessage("You are RED this game.")
	blue.jmessage("You are BLUE this game.")

	egress = {"type": "username_request"}
	red.ws.send(json.dumps(egress))
	red.username = json.loads(red.ws.receive())['message']
	blue.ws.send(json.dumps(egress))
	blue.username = json.loads(blue.ws.receive())['message']

	red_user = User.query.filter_by(name=red.username).first()
	blue_user = User.query.filter_by(name=blue.username).first()

	egress = {"type": "check_request"}
	red.ws.send(json.dumps(egress))
	red_check = json.loads(red.ws.receive())['message']
	if red_user.password[8:16] != red_check:
		red.jmessage("Something went wrong - try again.")
		blue.jmessage("Something went wrong - try again.")
		raise invalidCheckException()
	blue.ws.send(json.dumps(egress))
	blue_check = json.loads(blue.ws.receive())['message']
	if blue_user.password[8:16] != blue_check:
		red.jmessage("Something went wrong - try again.")
		blue.jmessage("Something went wrong - try again.")
		raise invalidCheckException()

	game_id = uuid.uuid4().hex[:8]
	session = MultiplayerSession(
		game_id=game_id, board=board, red=red, blue=blue, mode='ladder',
	)
	multiplayer_sessions[game_id] = session

	# Tell both clients the canonical URL so a reload comes back to the same game.
	for p in (red, blue):
		try:
			p.ws.send(json.dumps({"type": "assigned_id", "game_id": game_id, "mode": "ladder-game"}))
		except Exception:
			pass

	red.jmessage(red.username + " versus " + blue.username)
	blue.jmessage(red.username + " versus " + blue.username)

	egress = {
		"type": "laddersetup",
		"red_name": red_user.name,
		"blue_name": blue_user.name,
		"red_elo": red_user.elo,
		"blue_elo": blue_user.elo,
		"red_timer": red.timer,
		"blue_timer": blue.timer,
	}
	red.ws.send(json.dumps(egress))
	blue.ws.send(json.dumps(egress))

	egress = {"type": "spellsetup"}
	for i, key in enumerate(['ritual1','ritual2','ritual3','sorcery1','sorcery2','sorcery3','charm1','charm2','charm3']):
		egress[key] = board.spells[i].name
	red.ws.send(json.dumps(egress))
	blue.ws.send(json.dumps(egress))

	egress = {"type": "spelltextsetup"}
	for i, key in enumerate(['ritual1','ritual2','ritual3','sorcery1','sorcery2','sorcery3','charm1','charm2','charm3']):
		egress[key] = {"name": board.spells[i].name.replace("_", " "), "text": board.spells[i].text}
	red.ws.send(json.dumps(egress))
	blue.ws.send(json.dumps(egress))

	if board.variant != 'competitive':
		board.nodes['a1'].stone = 'red'
		board.nodes['b1'].stone = 'blue'
	board.update()
	_save_ladder(board, game_id, red, blue)
	time.sleep(3)

	countdown_timer_thread = Thread(target=countdown_timer, args=(red, blue))
	countdown_timer_thread.start()

	reset_this_turn = False

	try:
		while True:
			try:
				if not reset_this_turn:
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

					egress = {"type": "whoseturndisplay", "color": board.whoseturn, "message": message}
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
					_save_ladder(board, game_id, red, blue)
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
					red.jmessage("Resetting Turn")
					blue.jmessage("Resetting Turn")
					_restore_snapshot(board, red, blue)
					board.update(True)
					_save_ladder(board, game_id, red, blue)
					reset_this_turn = True
					continue

			except Exception:
				if board.gameover:
					break
				if _handle_multiplayer_disconnect(session, board, red, blue, is_ladder=True,
												  red_user=red_user, blue_user=blue_user):
					_restore_snapshot(board, red, blue)
					try:
						board.update(True)
					except Exception:
						pass
					_save_ladder(board, game_id, red, blue)
					reset_this_turn = True
					continue
				else:
					# Grace expired (clock ran out or both stayed gone). Award
					# the still-connected player the win + elo, or just close.
					alive_role = 'red' if _ws_alive(red.ws) else ('blue' if _ws_alive(blue.ws) else None)
					if alive_role:
						winner = red if alive_role == 'red' else blue
						loser = blue if alive_role == 'red' else red
						try:
							winner.jmessage("Opponent did not reconnect.")
							winner.ws.send(json.dumps({"type": "game_over", "winner": alive_role}))
						except Exception:
							pass
						try:
							record_elo(winner, loser)
						except Exception:
							pass
					board.gameover = True
					break
	finally:
		# Note: record_elo already decrements laddergamesinprogress when the
		# game ends through normal channels. Don't double-decrement here.
		multiplayer_sessions.pop(game_id, None)
		if board.gameover:
			_delete_save(game_id)
		else:
			_save_ladder(board, game_id, red, blue)



# Heartbeat thread for a private game. Probes both WSs; when one dies, tells
# the survivor and records the disconnected role on the session so the game
# loop can drive the grace-period / reconnect flow. Never ends the game on
# its own — that decision belongs to the game loop after the grace period.
def private_game_ping(red, blue, session):
	notified_role = None
	while True:
		time.sleep(3)
		if session.board.gameover:
			break
		red_alive = _ws_alive(red.ws)
		blue_alive = _ws_alive(blue.ws)
		if red_alive and blue_alive:
			notified_role = None
			continue
		disc_role = 'red' if not red_alive else 'blue'
		if notified_role != disc_role:
			notified_role = disc_role
			alive = blue if disc_role == 'red' else red
			try:
				alive.jmessage(f"Opponent disconnected. Waiting up to {PRIVATE_DISCONNECT_GRACE}s for them to return...")
				alive.ws.send(json.dumps({
					"type": "opponent_disconnected",
					"grace_seconds": PRIVATE_DISCONNECT_GRACE,
				}))
			except Exception:
				pass




privategamedict = {}

# Active multiplayer game sessions keyed by game_id. A session exists from the
# moment both players are matched until the game ends. Lets a reloaded tab
# reconnect into the game in progress.
multiplayer_sessions = {}

# Grace period (seconds) during which a disconnected un-timed game waits for
# the player to come back. Ladder games use the disconnected player's remaining
# clock instead.
PRIVATE_DISCONNECT_GRACE = 30
MULTIPLAYER_SAVE_TTL_SECONDS = 48 * 3600


class MultiplayerSession:
	"""In-memory handle for an active private or ladder game.

	The game loop runs in one of the players' WebSocket handler threads and
	talks to both clients via `red.ws` / `blue.ws`. When a WS dies, the loop
	parks on `wait_for_reconnect`; a fresh WS connection finds the session
	by game_id and hands itself over via `request_reconnect`.
	"""

	def __init__(self, game_id, board, red, blue, mode, gamename=None):
		self.game_id = game_id
		self.board = board
		self.red = red
		self.blue = blue
		self.mode = mode  # 'private' or 'ladder'
		self.gamename = gamename  # private only
		self.disconnected_role = None  # 'red' or 'blue' while waiting
		self._lock = Lock()
		self._reconnect_event = Event()
		self._pending = None  # (role, new_ws)
		self._holding_threads = 0  # count of WS handler threads parked in hold_open

	def request_reconnect(self, role, new_ws):
		with self._lock:
			self._pending = (role, new_ws)
			self._reconnect_event.set()

	def wait_for_reconnect(self, timeout):
		"""Returns (role, new_ws) on success, None on timeout."""
		ok = self._reconnect_event.wait(timeout=timeout)
		if not ok:
			return None
		with self._lock:
			result = self._pending
			self._pending = None
			self._reconnect_event.clear()
		return result


def _ws_alive(ws):
	"""Check whether a WebSocket is still connected.

	simple_websocket maintains a `connected` flag that flips to False once
	its internal ping mechanism notices the peer has gone away — that's much
	more reliable than `ws.send()` probing, which the TCP layer can queue
	silently for several seconds on a graceful close. As a fallback for any
	other ws-like object we attempt a single send."""
	connected = getattr(ws, 'connected', None)
	if connected is False:
		return False
	if connected is True:
		return True
	try:
		ws.send(json.dumps({"type": "ping"}))
		return True
	except Exception:
		return False


def _send_state_replay(board, player, is_ladder, red_user=None, blue_user=None):
	"""After a reconnect, replay the events a fresh client needs to rebuild
	its UI: spell setup, board state, SFN, and whose turn it is."""
	ws = player.ws
	egress = {"type": "spellsetup"}
	for i, key in enumerate(['ritual1','ritual2','ritual3','sorcery1','sorcery2','sorcery3','charm1','charm2','charm3']):
		egress[key] = board.spells[i].name
	try:
		ws.send(json.dumps(egress))
	except Exception:
		return

	egress = {"type": "spelltextsetup"}
	for i, key in enumerate(['ritual1','ritual2','ritual3','sorcery1','sorcery2','sorcery3','charm1','charm2','charm3']):
		egress[key] = {"name": board.spells[i].name.replace("_", " "), "text": board.spells[i].text}
	try:
		ws.send(json.dumps(egress))
	except Exception:
		return

	if is_ladder:
		egress = {
			"type": "laddersetup",
			"red_name": board.redplayer.username or '',
			"blue_name": board.blueplayer.username or '',
			"red_elo": getattr(red_user, 'elo', 0) if red_user else 0,
			"blue_elo": getattr(blue_user, 'elo', 0) if blue_user else 0,
			"red_timer": board.redplayer.timer,
			"blue_timer": board.blueplayer.timer,
		}
		try:
			ws.send(json.dumps(egress))
		except Exception:
			return

	# board.update sends boardstate to both players (including this one).
	try:
		board.update(True)
	except Exception:
		pass

	try:
		ws.send(json.dumps({"type": "sfn_update", "sfn": board_to_sfn(board)}))
	except Exception:
		pass

	if board.whoseturn == 'red':
		msg = "Red Turn " + str((board.turncounter // 2) + 1)
	else:
		msg = "Blue Turn " + str(board.turncounter // 2)
	try:
		ws.send(json.dumps({"type": "whoseturndisplay", "color": board.whoseturn, "message": msg}))
	except Exception:
		pass


def _purge_old_multiplayer_saves():
	"""Best-effort cleanup of multiplayer save files older than the TTL."""
	saves_dir = os.path.join(_APP_DIR, 'saves')
	if not os.path.isdir(saves_dir):
		return
	cutoff = time.time() - MULTIPLAYER_SAVE_TTL_SECONDS
	for fname in os.listdir(saves_dir):
		if not fname.endswith('.json'):
			continue
		path = os.path.join(saves_dir, fname)
		try:
			with open(path) as f:
				data = json.load(f)
			if data.get('mode') in ('private', 'ladder') and data.get('last_activity', 0) < cutoff:
				os.remove(path)
		except Exception:
			pass


def _restore_snapshot(board, red, blue):
	"""Rewind a Board to its last `take_snapshot()` state. Used both by the
	standard resetException flow and after a disconnect/reconnect to
	restart the turn cleanly."""
	snapshot = board.snapshot
	board.turncounter = snapshot["turncounter"]
	board.gameover = snapshot["gameover"]
	board.winner = snapshot["winner"]
	board.score = snapshot["score"]
	for nodename in board.nodes:
		board.nodes[nodename].stone = snapshot[nodename]
	red.lock = board.spelldict[snapshot["redlock"]] if snapshot["redlock"] else None
	blue.lock = board.spelldict[snapshot["bluelock"]] if snapshot["bluelock"] else None
	red.spellcounter = snapshot["redspellcounter"]
	blue.spellcounter = snapshot["bluespellcounter"]
	board.last_play = snapshot["last_play"]
	board.last_player = snapshot["last_player"]


def _handle_multiplayer_disconnect(session, board, red, blue, is_ladder,
								   red_user=None, blue_user=None):
	"""Called when the game loop detects a WS error. Identifies the
	disconnected player, notifies the alive one, and waits up to a grace
	period for the missing player to reconnect.

	Returns True if reconnect succeeded (caller should restart the turn from
	snapshot), False if no reconnect (caller should end the game).
	"""
	# Identify which side is disconnected by probing both sockets.
	red_alive = _ws_alive(red.ws)
	blue_alive = _ws_alive(blue.ws)
	if red_alive and blue_alive:
		# Either both came back already, or it was a transient error.
		# Treat as no disconnect.
		return False
	if not red_alive and not blue_alive:
		# Both dead — wait briefly for either to reconnect.
		disc_role = 'both'
		alive_player = None
	else:
		disc_role = 'red' if not red_alive else 'blue'
		alive_player = blue if disc_role == 'red' else red

	session.disconnected_role = disc_role if disc_role != 'both' else 'either'

	# Grace period
	if is_ladder and disc_role in ('red', 'blue'):
		disc_player = red if disc_role == 'red' else blue
		if disc_player.timer_running:
			# Their clock is ticking. Let it run out naturally; reconnect
			# is allowed any time before it does. If they had 45s left and
			# spent 60s away, the timer thread has already ended the game.
			grace = max(1, int(disc_player.timer or 0))
		else:
			# Not the active player — their clock isn't running, so fall
			# back to the standard un-timed grace window.
			grace = PRIVATE_DISCONNECT_GRACE
	else:
		grace = PRIVATE_DISCONNECT_GRACE

	# Tell the still-connected player what's happening.
	if alive_player is not None:
		try:
			alive_player.jmessage(f"Opponent disconnected. Waiting up to {grace}s for them to return...")
			alive_player.ws.send(json.dumps({"type": "opponent_disconnected", "grace_seconds": grace}))
		except Exception:
			pass

	result = session.wait_for_reconnect(grace)
	session.disconnected_role = None
	if result is None:
		return False

	role, new_ws = result
	if role == 'red':
		red.ws = new_ws
	else:
		blue.ws = new_ws

	# Notify the player who stayed.
	other = blue if role == 'red' else red
	try:
		other.jmessage("Opponent reconnected.")
		other.ws.send(json.dumps({"type": "opponent_reconnected"}))
	except Exception:
		pass

	reconnected = red if role == 'red' else blue
	_send_state_replay(board, reconnected, is_ladder, red_user=red_user, blue_user=blue_user)
	return True


def _hold_reconnect_ws_open(session, ws):
	"""Keep a reconnect WebSocket alive in its handler thread until the
	game session ends. The actual send/receive on this socket happens from
	the game-loop thread via `red.ws` / `blue.ws`."""
	try:
		while not session.board.gameover:
			time.sleep(2)
	except Exception:
		pass


def _handle_private_reconnect(ws, gamename):
	session = multiplayer_sessions.get(gamename)
	if not session:
		return False
	# Probe to identify which slot is open. If both report alive, wait a
	# couple of seconds for the game-loop thread to register the disconnect.
	red_alive = _ws_alive(session.red.ws)
	blue_alive = _ws_alive(session.blue.ws)
	if red_alive and blue_alive:
		for _ in range(10):
			time.sleep(0.5)
			if session.disconnected_role:
				break
		else:
			try:
				ws.send(json.dumps({"type": "message", "message": "Both players already connected."}))
			except Exception:
				pass
			return True

	role = session.disconnected_role
	if role in (None, 'either'):
		role = 'red' if not red_alive else 'blue'
	session.request_reconnect(role, ws)
	_hold_reconnect_ws_open(session, ws)
	return True


@sock.route('/api/privategame/<privategamename>')
def playprivategame(ws, privategamename):
	global privategamedict
	# Reconnect into a game in progress?
	if privategamename in multiplayer_sessions:
		_handle_private_reconnect(ws, privategamename)
		return
	# First player waiting for an opponent: keep the WS alive with pings.
	if privategamename not in privategamedict:
		privategamedict[privategamename] = ws
		try:
			while True:
				if privategamename in multiplayer_sessions:
					# Game started in the second-player handler. The game
					# loop is using this same ws via opp_ws; keep alive.
					_hold_reconnect_ws_open(multiplayer_sessions[privategamename], ws)
					return
				ws.send(json.dumps({"type": "ping"}))
				time.sleep(1)
		except Exception:
			privategamedict.pop(privategamename, None)
		return
	# Second player has arrived: pop the waiting slot and run the game.
	opp_ws = privategamedict.pop(privategamename, None)
	if opp_ws is None:
		return
	_run_private_game(ws, opp_ws, privategamename)


def _run_private_game(ws, opp_ws, gamename):
	board = Board()
	red = Player(board, 'red')
	blue = Player(board, 'blue')
	board.addplayers(red, blue)
	red.opp = blue
	blue.opp = red
	whoisred = randint(1, 2)
	if whoisred == 1:
		red.ws = ws
		blue.ws = opp_ws
	else:
		red.ws = opp_ws
		blue.ws = ws

	session = MultiplayerSession(
		game_id=gamename, board=board, red=red, blue=blue,
		mode='private', gamename=gamename,
	)
	multiplayer_sessions[gamename] = session

	try:
		red.jmessage("You are RED this game.")
		blue.jmessage("You are BLUE this game.")

		egress = {"type": "spellsetup"}
		for i, key in enumerate(['ritual1','ritual2','ritual3','sorcery1','sorcery2','sorcery3','charm1','charm2','charm3']):
			egress[key] = board.spells[i].name
		red.ws.send(json.dumps(egress))
		blue.ws.send(json.dumps(egress))

		egress = {"type": "spelltextsetup"}
		for i, key in enumerate(['ritual1','ritual2','ritual3','sorcery1','sorcery2','sorcery3','charm1','charm2','charm3']):
			egress[key] = {"name": board.spells[i].name.replace("_", " "), "text": board.spells[i].text}
		red.ws.send(json.dumps(egress))
		blue.ws.send(json.dumps(egress))

		if board.variant != 'competitive':
			board.nodes['a1'].stone = 'red'
			board.nodes['b1'].stone = 'blue'
		board.update()
		_save_private(board, gamename, gamename)
		time.sleep(3)

		private_game_ping_thread = Thread(target=private_game_ping, args=(red, blue, session))
		private_game_ping_thread.start()

		reset_this_turn = False

		while True:
			try:
				if not reset_this_turn:
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

					egress = {"type": "whoseturndisplay", "color": board.whoseturn, "message": message}
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
					_save_private(board, gamename, gamename)
					reset_this_turn = False
					if board.gameover:
						board.end_game()
						break

				except resetException:
					red.jmessage("Resetting Turn")
					blue.jmessage("Resetting Turn")
					_restore_snapshot(board, red, blue)
					board.update(True)
					_save_private(board, gamename, gamename)
					reset_this_turn = True
					continue
			except Exception:
				if board.gameover:
					break
				if _handle_multiplayer_disconnect(session, board, red, blue, is_ladder=False):
					# Reconnect succeeded — rewind to start of turn.
					_restore_snapshot(board, red, blue)
					try:
						board.update(True)
					except Exception:
						pass
					_save_private(board, gamename, gamename)
					reset_this_turn = True
					continue
				else:
					# Grace expired or unrecoverable. Award opponent the win.
					alive_role = 'red' if _ws_alive(red.ws) else ('blue' if _ws_alive(blue.ws) else None)
					if alive_role:
						winner_player = red if alive_role == 'red' else blue
						try:
							winner_player.jmessage("Opponent did not reconnect.")
							winner_player.ws.send(json.dumps({"type": "game_over", "winner": alive_role}))
						except Exception:
							pass
					board.gameover = True
					break
	finally:
		multiplayer_sessions.pop(gamename, None)
		if board.gameover:
			_delete_save(gamename)
		else:
			# Game didn't finish cleanly (e.g. server shutdown); leave the
			# save in place so a future reconnect can resume.
			_save_private(board, gamename, gamename)



_APP_DIR = os.path.dirname(os.path.abspath(__file__))

def _save_sgn(recorder):
	games_dir = os.path.join(_APP_DIR, 'games')
	os.makedirs(games_dir, exist_ok=True)
	from datetime import datetime as dt
	timestamp = dt.now().strftime('%Y%m%d_%H%M%S_%f')
	filepath = os.path.join(games_dir, f'game_{timestamp}.sgn')
	with open(filepath, 'w') as f:
		f.write(recorder.to_sgn())

def _save_training_data(ai_player, winner):
	"""Save MCTS positions from a human-vs-AI game as training data."""
	from ai.config import DATA_DIR
	positions = getattr(ai_player, 'training_positions', None)
	if not positions:
		return
	os.makedirs(DATA_DIR, exist_ok=True)
	from datetime import datetime as dt
	timestamp = dt.now().strftime('%Y%m%d_%H%M%S_%f')
	filepath = os.path.join(DATA_DIR, f'human_game_{timestamp}.jsonl')
	with open(filepath, 'w') as f:
		for pos in positions:
			side = pos['side']
			if winner == side:
				outcome = 1.0
			elif winner is not None:
				outcome = -1.0
			else:
				outcome = 0.0
			record = {
				'sfn': pos['sfn'],
				'spell_ids': pos['spell_ids'],
				'policy': pos['policy'],
				'turn_encodings': pos['turn_encodings'],
				'outcome': outcome,
			}
			f.write(json.dumps(record) + '\n')

def _save_game_state(board, recorder, human_color, difficulty, save_id):
	"""Auto-save the current single-player game state so it can be resumed later."""
	from notation import board_to_sfn
	saves_dir = os.path.join(_APP_DIR, 'saves')
	os.makedirs(saves_dir, exist_ok=True)
	filepath = os.path.join(saves_dir, f'{save_id}.json')
	data = {
		'mode': 'single_player',
		'sfn': board_to_sfn(board),
		'human_color': human_color,
		'difficulty': difficulty,
		'sgn_so_far': recorder.to_sgn(),
		'finished': board.gameover,
	}
	with open(filepath, 'w') as f:
		json.dump(data, f)

def _save_local1v1(board, game_id, variant):
	"""Auto-save the current local-1v1 game state so a reload resumes it."""
	from notation import board_to_sfn
	saves_dir = os.path.join(_APP_DIR, 'saves')
	os.makedirs(saves_dir, exist_ok=True)
	filepath = os.path.join(saves_dir, f'{game_id}.json')
	data = {
		'mode': 'local_1v1',
		'sfn': board_to_sfn(board),
		'variant': variant,
		'finished': board.gameover,
	}
	with open(filepath, 'w') as f:
		json.dump(data, f)

def _save_local1v1_sfn(game_id, sfn, variant):
	"""Pre-seed a local-1v1 save from an imported SFN before the WS opens."""
	saves_dir = os.path.join(_APP_DIR, 'saves')
	os.makedirs(saves_dir, exist_ok=True)
	filepath = os.path.join(saves_dir, f'{game_id}.json')
	data = {
		'mode': 'local_1v1',
		'sfn': sfn,
		'variant': variant,
		'finished': False,
	}
	with open(filepath, 'w') as f:
		json.dump(data, f)

def _save_private(board, game_id, gamename):
	"""Auto-save private-match state so a reload resumes it."""
	from notation import board_to_sfn
	saves_dir = os.path.join(_APP_DIR, 'saves')
	os.makedirs(saves_dir, exist_ok=True)
	filepath = os.path.join(saves_dir, f'{game_id}.json')
	data = {
		'mode': 'private',
		'sfn': board_to_sfn(board),
		'gamename': gamename,
		'finished': board.gameover,
		'last_activity': time.time(),
	}
	with open(filepath, 'w') as f:
		json.dump(data, f)

def _save_ladder(board, game_id, red, blue):
	"""Auto-save ladder-match state so a reload resumes it."""
	from notation import board_to_sfn
	saves_dir = os.path.join(_APP_DIR, 'saves')
	os.makedirs(saves_dir, exist_ok=True)
	filepath = os.path.join(saves_dir, f'{game_id}.json')
	data = {
		'mode': 'ladder',
		'sfn': board_to_sfn(board),
		'red_username': getattr(red, 'username', None),
		'blue_username': getattr(blue, 'username', None),
		'red_timer': getattr(red, 'timer', 0),
		'blue_timer': getattr(blue, 'timer', 0),
		'finished': board.gameover,
		'last_activity': time.time(),
	}
	with open(filepath, 'w') as f:
		json.dump(data, f)

def _delete_save(save_id):
	filepath = os.path.join(_APP_DIR, 'saves', f'{save_id}.json')
	if os.path.exists(filepath):
		os.remove(filepath)

def _save_exists(save_id):
	return os.path.exists(os.path.join(_APP_DIR, 'saves', f'{save_id}.json'))

def _list_saves():
	"""List single-player saves only (for the single-player menu)."""
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
			if data.get('mode', 'single_player') != 'single_player':
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

class _DedupState:
	"""Shared state for deduplicating WebSocket sends across two player objects."""
	def __init__(self):
		self.last_sent = None

class _DedupWebSocket:
	"""Wraps a WebSocket so that consecutive identical sends are skipped.
	Two instances sharing the same _DedupState will deduplicate across both."""
	def __init__(self, ws, shared_state):
		self._ws = ws
		self._state = shared_state

	def send(self, data):
		if data != self._state.last_sent:
			self._ws.send(data)
			self._state.last_sent = data

	def receive(self):
		return self._ws.receive()


local1v1_live_set = set()

@sock.route('/api/local1v1game/<game_id>')
def play_local_1v1_with_id(ws, game_id):
	# Reject a second concurrent connection to the same game id so two
	# tabs can't race each other writing the same save file.
	if game_id in local1v1_live_set:
		ws.send(json.dumps({"type": "message", "message": "This game is already open in another tab."}))
		return
	load_sfn = None
	variant = request.args.get('variant', 'standard')
	if _save_exists(game_id):
		try:
			save_data = _load_save(game_id)
		except Exception:
			save_data = None
		if save_data and save_data.get('mode') == 'local_1v1' and not save_data.get('finished'):
			load_sfn = save_data.get('sfn') or None
			variant = save_data.get('variant', variant)
	local1v1_live_set.add(game_id)
	try:
		_run_local_1v1_game(ws, load_sfn=load_sfn, variant=variant, game_id=game_id)
	finally:
		local1v1_live_set.discard(game_id)

def _run_local_1v1_game(ws, load_sfn=None, variant='standard', game_id=None):
	board = Board()
	board.variant = variant if variant in ('standard', 'competitive') else 'standard'
	red = Player(board, 'red')
	blue = Player(board, 'blue')
	board.addplayers(red, blue)
	red.opp = blue
	blue.opp = red

	shared_state = _DedupState()
	red.ws = _DedupWebSocket(ws, shared_state)
	blue.ws = _DedupWebSocket(ws, shared_state)

	if load_sfn:
		state = sfn_to_dict(load_sfn)
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
		next_turn = 'Red' if state['turncounter'] % 2 == 0 else 'Blue'
		red.jmessage("Imported position — " + next_turn + "'s turn.")
	else:
		red.jmessage("Local 1v1 — Red goes first.")

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

	if load_sfn:
		board.update()
	else:
		# Skip the standard a1/b1 setup for the competitive variant —
		# the first two turns place the stones via a free blink.
		if board.variant != 'competitive':
			board.nodes['a1'].stone = 'red'
			board.nodes['b1'].stone = 'blue'
		board.update()

	time.sleep(2)

	def send_sfn():
		sfn = board_to_sfn(board)
		red.ws.send(json.dumps({"type": "sfn_update", "sfn": sfn}))

	send_sfn()
	if game_id:
		_save_local1v1(board, game_id, board.variant)

	reset_this_turn = False

	try:
		while True:
			try:
				if not reset_this_turn:
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

					activeplayer.bot_triggers()
					if board.gameover:
						break

					if board.whoseturn == 'red':
						red.taketurn()
					else:
						blue.taketurn()

					activeplayer.eot_triggers()
					board.update(True)
					send_sfn()
					if game_id:
						_save_local1v1(board, game_id, board.variant)
					reset_this_turn = False
					if board.gameover:
						break

				except resetException:
					red.jmessage("Resetting Turn")

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
					send_sfn()
					if game_id:
						_save_local1v1(board, game_id, board.variant)
					reset_this_turn = True
					continue
			except Exception:
				break
	finally:
		if board.gameover:
			try:
				board.end_game()
				time.sleep(1)
			except Exception:
				pass
			if game_id:
				_delete_save(game_id)


@sock.route('/api/singleplayergame')
def playsingleplayergame(ws):
	variant = request.args.get('variant', 'standard')
	save_id = request.args.get('save_id') or None
	_run_singleplayer_game(ws, ai_class=AIPlayer, difficulty='easy',
						   variant=variant, save_id=save_id)

@sock.route('/api/singleplayergame_medium')
def playsingleplayergame_medium(ws):
	variant = request.args.get('variant', 'standard')
	save_id = request.args.get('save_id') or None
	_run_singleplayer_game(ws, ai_class=MCTSAIPlayer, difficulty='medium',
						   ai_kwargs={'net_class': SigilNet},
						   variant=variant, save_id=save_id)

@sock.route('/api/singleplayergame_hard')
def playsingleplayergame_hard(ws):
	variant = request.args.get('variant', 'standard')
	save_id = request.args.get('save_id') or None
	_run_singleplayer_game(ws, ai_class=MCTSAIPlayer, difficulty='hard',
						   ai_kwargs={'net_class': SigilNetHard},
						   variant=variant, save_id=save_id)

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
						   ai_kwargs=None, load_save=None, save_id=None,
						   variant='standard'):
	from notation import sfn_to_dict
	import uuid

	if save_id is None:
		save_id = str(uuid.uuid4())[:8]

	board = SPBoard()
	# Loaded saves carry their own variant inside the SFN string;
	# parse it out so we restore play under the same rules. New
	# (non-loaded) games take the variant from the request.
	if load_save is not None:
		try:
			from notation import sfn_to_dict as _saved_sfn_to_dict
			saved_state = _saved_sfn_to_dict(load_save['sfn'])
			board.variant = saved_state.get('variant', 'standard')
		except Exception:
			board.variant = 'standard'
	else:
		board.variant = variant if variant in ('standard', 'competitive') else 'standard'

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
	recorder = GameRecorder(spell_names, red_name=red_name, blue_name=blue_name,
							variant=board.variant)
	board.recorder = recorder

	if load_save is None:
		# Standard variant places the starting stones on a1/b1.
		# Competitive variant leaves the board empty; the first two
		# turns will use the special opening blink/soft-blink logic
		# inside Player.taketurn / AIPlayer.taketurn.
		if board.variant != 'competitive':
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
		# Save MCTS training data from this game
		try:
			_save_training_data(ai, board.winner)
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
