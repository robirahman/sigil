// eslint-disable-next-line no-unused-vars
function main() {
	// awaiting is a global variable set to null when not awaiting anything,
	// set to 'node' when the server is awaiting a node name,
	//set to 'spell' when the server is awaiting a choice of spell,
	// and set to 'action' when the server is awaiting an action.

	// actionlist is the list of available actions, when awaiting == 'action'.
	awaiting = null;
	actionlist = null;

	// SpellDict will be a dictionary with keys "ritual2", "charm3", etc.,
	// and values "Fireblast", "Flourish", etc.
	SpellDict = null;

	// ReverseSpellDict will be a dictionary with keys "Fireblast", "Flourish", etc.,
	// and values "ritual2", "charm3", etc.
	ReverseSpellDict = null;

	auxlockdict = {
		ritual1: 'a1',
		ritual2: 'b1',
		ritual3: 'c1',
		sorcery1: 'a2',
		sorcery2: 'b2',
		sorcery3: 'c2',
	};

	// lockdict will be a dictionary with keys "Fireblast", "Flourish", etc.,
	// and values "a1", "c2", etc.  It is initialized at the same time as SpellDict,
	// once the spell setup JSON is received.
	lockdict = {};

	for (spellname in ReverseSpellDict) {
		lockdict[spellname] = auxlockdict[ReverseSpellDict[spellname]];
	}

	// This needs to be "ws://" for HTTP and "wss://" for HTTPS. Might need to change this later.
	events = new WebSocket('wss://' + location.host + '/api/singleplayergame');
	events.onmessage = incomingEvent;

	allnodenames = [
		'a1',
		'a2',
		'a3',
		'a4',
		'a5',
		'a6',
		'a7',
		'a8',
		'a9',
		'a10',
		'a11',
		'a12',
		'a13',
		'b1',
		'b2',
		'b3',
		'b4',
		'b5',
		'b6',
		'b7',
		'b8',
		'b9',
		'b10',
		'b11',
		'b12',
		'b13',
		'c1',
		'c2',
		'c3',
		'c4',
		'c5',
		'c6',
		'c7',
		'c8',
		'c9',
		'c10',
		'c11',
		'c12',
		'c13',
	];

	var allstones = document.getElementsByClassName('stone');
	for (var i = 0; i < allstones.length; i++) {
		allstones[i].addEventListener(
			'click',
			function () {
				nodeClick(this);
			},
			false
		);
	}

	document.getElementById('ritualnodes1').addEventListener(
		'click',
		function () {
			spellClick('ritual1');
		},
		false
	);

	document.getElementById('ritualnodes2').addEventListener(
		'click',
		function () {
			spellClick('ritual2');
		},
		false
	);

	document.getElementById('ritualnodes3').addEventListener(
		'click',
		function () {
			spellClick('ritual3');
		},
		false
	);

	document.getElementById('sorcerynodes1').addEventListener(
		'click',
		function () {
			spellClick('sorcery1');
		},
		false
	);

	document.getElementById('sorcerynodes2').addEventListener(
		'click',
		function () {
			spellClick('sorcery2');
		},
		false
	);

	document.getElementById('sorcerynodes3').addEventListener(
		'click',
		function () {
			spellClick('sorcery3');
		},
		false
	);

	document.getElementById('dashbutton').addEventListener(
		'click',
		function () {
			dashClick(this);
		},
		false
	);

	document.getElementById('passbutton').addEventListener(
		'click',
		function () {
			passClick(this);
		},
		false
	);

	document.getElementById('resetbutton').addEventListener(
		'click',
		function () {
			resetClick(this);
		},
		false
	);

	document.getElementById('doneselectingbutton').addEventListener(
		'click',
		function () {
			doneselectingClick(this);
		},
		false
	);

	document.addEventListener('keydown', keyDownFunction, false);

	fadeIn();
}

function spellClick(spellposition) {
	//This is ONLY triggered for spells, not charms

	// Takes in a spell position, e.g., "ritual2", "sorcery3"
	// and sends a spellname, e.g., 'Fireblast', 'Flourish'
	var spellname = SpellDict[spellposition];
	if (awaiting == 'action' && actionlist.includes(spellname)) {
		var payload = { message: spellname };
		events.send(JSON.stringify(payload));
		awaiting = null;
	} else if (awaiting == 'spell') {
		// eslint-disable-next-line no-redeclare
		var payload = { message: spellname };
		events.send(JSON.stringify(payload));
		awaiting = null;
	}
}

function addSpellLabels() {
	document.getElementById('ritualdiv1').onmouseover = function () {
		document.getElementById('ritualtext1').style.display = 'inline';
	};
	document.getElementById('ritualdiv2').onmouseover = function () {
		document.getElementById('ritualtext2').style.display = 'inline';
	};
	document.getElementById('ritualdiv3').onmouseover = function () {
		document.getElementById('ritualtext3').style.display = 'inline';
	};
	document.getElementById('sorcerydiv1').onmouseover = function () {
		document.getElementById('sorcerytext1').style.display = 'inline';
	};
	document.getElementById('sorcerydiv2').onmouseover = function () {
		document.getElementById('sorcerytext2').style.display = 'inline';
	};
	document.getElementById('sorcerydiv3').onmouseover = function () {
		document.getElementById('sorcerytext3').style.display = 'inline';
	};
	document.getElementById('charmdiv1').onmouseover = function () {
		document.getElementById('charmtext1').style.display = 'inline';
	};
	document.getElementById('charmdiv2').onmouseover = function () {
		document.getElementById('charmtext2').style.display = 'inline';
	};
	document.getElementById('charmdiv3').onmouseover = function () {
		document.getElementById('charmtext3').style.display = 'inline';
	};

	document.getElementById('ritualdiv1').onmouseout = function () {
		document.getElementById('ritualtext1').style.display = 'none';
	};
	document.getElementById('ritualdiv2').onmouseout = function () {
		document.getElementById('ritualtext2').style.display = 'none';
	};
	document.getElementById('ritualdiv3').onmouseout = function () {
		document.getElementById('ritualtext3').style.display = 'none';
	};
	document.getElementById('sorcerydiv1').onmouseout = function () {
		document.getElementById('sorcerytext1').style.display = 'none';
	};
	document.getElementById('sorcerydiv2').onmouseout = function () {
		document.getElementById('sorcerytext2').style.display = 'none';
	};
	document.getElementById('sorcerydiv3').onmouseout = function () {
		document.getElementById('sorcerytext3').style.display = 'none';
	};
	document.getElementById('charmdiv1').onmouseout = function () {
		document.getElementById('charmtext1').style.display = 'none';
	};
	document.getElementById('charmdiv2').onmouseout = function () {
		document.getElementById('charmtext2').style.display = 'none';
	};
	document.getElementById('charmdiv3').onmouseout = function () {
		document.getElementById('charmtext3').style.display = 'none';
	};
}

function setupSpells(spellnamedict) {
	// spellnamedict is a JSON dictionary with keys "ritual2", "charm3", etc.,
	// and values "Fireblast", "Flourish", etc.
	document.getElementById('ritual1').src = '/static/images/' + spellnamedict.ritual1 + '.png';
	document.getElementById('ritual2').src = '/static/images/' + spellnamedict.ritual2 + '.png';
	document.getElementById('ritual3').src = '/static/images/' + spellnamedict.ritual3 + '.png';
	document.getElementById('sorcery1').src = '/static/images/' + spellnamedict.sorcery1 + '.png';
	document.getElementById('sorcery2').src = '/static/images/' + spellnamedict.sorcery2 + '.png';
	document.getElementById('sorcery3').src = '/static/images/' + spellnamedict.sorcery3 + '.png';
	document.getElementById('charm1').src = '/static/images/' + spellnamedict.charm1 + '.png';
	document.getElementById('charm2').src = '/static/images/' + spellnamedict.charm2 + '.png';
	document.getElementById('charm3').src = '/static/images/' + spellnamedict.charm3 + '.png';

	document.getElementById('ritualnodes1').style.opacity = 0.7;
	document.getElementById('ritualnodes2').style.opacity = 0.7;
	document.getElementById('ritualnodes3').style.opacity = 0.7;
	document.getElementById('sorcerynodes1').style.opacity = 0.7;
	document.getElementById('sorcerynodes2').style.opacity = 0.7;
	document.getElementById('sorcerynodes3').style.opacity = 0.7;
	document.getElementById('charmnodes1').style.opacity = 0.7;
	document.getElementById('charmnodes2').style.opacity = 0.7;
	document.getElementById('charmnodes3').style.opacity = 0.7;
}

function setupSpellText(spelltextdict) {
	// spelltextdict is a JSON dictionary with keys "ritual2", "charm3", etc.,
	// and values == the innerhtml strings for those respective text boxes
	document.getElementById('ritualtext1').innerHTML = spelltextdict.ritual1;
	document.getElementById('ritualtext2').innerHTML = spelltextdict.ritual2;
	document.getElementById('ritualtext3').innerHTML = spelltextdict.ritual3;
	document.getElementById('sorcerytext1').innerHTML = spelltextdict.sorcery1;
	document.getElementById('sorcerytext2').innerHTML = spelltextdict.sorcery2;
	document.getElementById('sorcerytext3').innerHTML = spelltextdict.sorcery3;
	document.getElementById('charmtext1').innerHTML = spelltextdict.charm1;
	document.getElementById('charmtext2').innerHTML = spelltextdict.charm2;
	document.getElementById('charmtext3').innerHTML = spelltextdict.charm3;
}

function fadeIn() {
	document.getElementById('board').style.opacity = 1;
	document.getElementById('ritual1').style.opacity = 1;
	document.getElementById('sorcery1').style.opacity = 1;
	document.getElementById('charm1').style.opacity = 1;
	document.getElementById('ritual2').style.opacity = 1;
	document.getElementById('sorcery2').style.opacity = 1;
	document.getElementById('charm2').style.opacity = 1;
	document.getElementById('ritual3').style.opacity = 1;
	document.getElementById('sorcery3').style.opacity = 1;
	document.getElementById('charm3').style.opacity = 1;

	setTimeout(scorekeeperFadeIn, 1000);

	setTimeout(addSpellLabels, 2000);
}

function scorekeeperFadeIn() {
	document.getElementById('scorekeeper').style.opacity = 1;
}

function keyDownFunction(e) {
	var keyCode = e.keyCode;
	if (keyCode == 32) {
		e.preventDefault();
		if (document.getElementById('passbutton').style.visibility == 'visible') {
			document.getElementById('passbutton').click();
		}
	} else if (keyCode == 68) {
		if (document.getElementById('dashbutton').style.visibility == 'visible') {
			document.getElementById('dashbutton').click();
		}
	} else if (keyCode == 82) {
		if (document.getElementById('resetbutton').style.visibility == 'visible') {
			document.getElementById('resetbutton').click();
		}
	}
}

function dashClick() {
	if (awaiting == 'action' && actionlist.includes('dash')) {
		var payload = { message: 'dash' };
		events.send(JSON.stringify(payload));
	}
}

function passClick() {
	if (awaiting == 'action' && actionlist.includes('pass')) {
		var payload = { message: 'pass' };
		events.send(JSON.stringify(payload));
		document.getElementById('dashbutton').style.visibility = 'hidden';
		document.getElementById('passbutton').style.visibility = 'hidden';
		document.getElementById('resetbutton').style.visibility = 'hidden';
	}
}

function resetClick() {
	awaiting = null;
	actionlist = null;
	var payload = { message: 'reset' };
	events.send(JSON.stringify(payload));
}

function doneselectingClick() {
	awaiting = null;
	var payload = { message: 'doneselecting' };
	events.send(JSON.stringify(payload));
}

function nodeClick(node) {
	if (awaiting == 'node') {
		var payload = { message: node.id };
		// Sends a string like 'a12', 'c3', etc, as the message

		events.send(JSON.stringify(payload));
		awaiting = null;
	} else if (awaiting == 'action') {
		if (actionlist.includes(SpellDict['charm1']) && node.id == 'a7') {
			// eslint-disable-next-line no-redeclare
			var payload = { message: SpellDict['charm1'] };
			events.send(JSON.stringify(payload));
			awaiting = null;
		} else if (actionlist.includes(SpellDict['charm2']) && node.id == 'b7') {
			// eslint-disable-next-line no-redeclare
			var payload = { message: SpellDict['charm2'] };
			events.send(JSON.stringify(payload));
			awaiting = null;
		} else if (actionlist.includes(SpellDict['charm3']) && node.id == 'c7') {
			// eslint-disable-next-line no-redeclare
			var payload = { message: SpellDict['charm3'] };
			events.send(JSON.stringify(payload));
			awaiting = null;
		} else if (actionlist.includes('move')) {
			// eslint-disable-next-line no-redeclare
			var payload = { message: node.id };
			events.send(JSON.stringify(payload));
			awaiting = null;
		}
	}
}

function incomingEvent(event) {
	var payload = JSON.parse(event.data);
	var box = document.getElementById('actionBox');

	if (payload.type == 'selectingNoButton') {
		document.getElementById('dashbutton').style.visibility = 'hidden';
		document.getElementById('passbutton').style.visibility = 'hidden';
	} else if (payload.type == 'selecting') {
		document.getElementById('doneselectingbutton').style.visibility = 'visible';
		document.getElementById('dashbutton').style.visibility = 'hidden';
		document.getElementById('passbutton').style.visibility = 'hidden';
	} else if (payload.type == 'doneselecting') {
		document.getElementById('doneselectingbutton').style.visibility = 'hidden';
	} else if (payload.type == 'spelltextsetup') {
		setupSpellText(payload);
	} else if (payload.type == 'spellsetup') {
		SpellDict = payload;
		delete SpellDict['type'];

		ReverseSpellDict = {};
		for (position in SpellDict) {
			ReverseSpellDict[SpellDict[position]] = position;
		}

		for (spellname in ReverseSpellDict) {
			lockdict[spellname] = auxlockdict[ReverseSpellDict[spellname]];
		}

		setupSpells(payload);
	} else if (payload.type == 'message') {
		box.innerHTML = payload.message;
	} else if (payload.type == 'whoseturndisplay') {
		var turnbox = document.getElementById('whoseturndisplay');
		turnbox.innerHTML = payload.message;
	} else if (payload.type == 'boardstate') {
		updateBoard(payload);
	} else if (payload.type == 'pushingoptions') {
		for (nodename of allnodenames) {
			if (payload[nodename] == 'red') {
				document.getElementById(nodename).src = '/static/images/redstone.png';
				document.getElementById(nodename).style.opacity = 0.6;
			} else if (payload[nodename] == 'blue') {
				document.getElementById(nodename).src = '/static/images/bluestone.png';
				document.getElementById(nodename).style.opacity = 0.6;
			}
		}
	} else if (payload.type == 'chooserefills') {
		for (nodename of allnodenames) {
			if (payload[nodename]) {
				if (payload.playercolor == 'red') {
					document.getElementById(nodename).src = '/static/images/redstone.png';
					document.getElementById(nodename).style.opacity = 0.6;
				} else if (payload.playercolor == 'blue') {
					document.getElementById(nodename).src = '/static/images/bluestone.png';
					document.getElementById(nodename).style.opacity = 0.6;
				}
			}
		}
	} else if (payload.type == 'donerefilling') {
		for (nodename of allnodenames) {
			if (document.getElementById(nodename).style.opacity == 0.6) {
				document.getElementById(nodename).src = '/static/images/emptystone.png';
				document.getElementById(nodename).style.opacity = 1;
			}
		}
	}

	if (payload.awaiting) {
		awaiting = payload.awaiting;
	}
	if (payload.actionlist) {
		actionlist = payload.actionlist;
		document.getElementById('resetbutton').style.visibility = 'visible';

		if (actionlist.includes('dash')) {
			document.getElementById('dashbutton').style.visibility = 'visible';
		} else {
			document.getElementById('dashbutton').style.visibility = 'hidden';
		}

		if (actionlist.includes('pass')) {
			document.getElementById('passbutton').style.visibility = 'visible';
		} else {
			document.getElementById('passbutton').style.visibility = 'hidden';
		}
	}
}

function updateBoard(boardstate) {
	for (var name of allnodenames) {
		if (boardstate[name] == 'red') {
			document.getElementById(name).src = '/static/images/redstone.png';
			document.getElementById(name).style.opacity = 1;
		} else if (boardstate[name] == 'blue') {
			document.getElementById(name).src = '/static/images/bluestone.png';
			document.getElementById(name).style.opacity = 1;
		} else {
			document.getElementById(name).src = '/static/images/emptystone.png';
			document.getElementById(name).style.opacity = 1;
		}
	}

	if (boardstate['last_play'] != null) {
		var lastplayname = boardstate['last_play'];
		var lastplayer = boardstate['last_player'];
		document.getElementById(lastplayname).src = '/static/images/' + lastplayer + 'stonehalo.png';
		document.getElementById(lastplayname).style.opacity = 1;
	}

	var redlockedspellname = boardstate['redlock'];
	var bluelockedspellname = boardstate['bluelock'];
	// These are the locked spell names, e.g., "Fireblast", "Flourish"

	for (lockIdentifierChars of ['a1', 'b1', 'c1', 'a2', 'b2', 'c2']) {
		if (
			document.getElementById('redlock' + lockIdentifierChars).style.opacity == 1 &&
			lockdict[redlockedspellname] != lockIdentifierChars
		) {
			deactivateLock(lockIdentifierChars, 'red');
		}

		if (
			document.getElementById('redlock' + lockIdentifierChars + 'alt').style.opacity == 1 &&
			lockdict[redlockedspellname] != lockIdentifierChars
		) {
			deactivateLock(lockIdentifierChars + 'alt', 'red');
		}

		if (
			document.getElementById('bluelock' + lockIdentifierChars).style.opacity == 1 &&
			lockdict[bluelockedspellname] != lockIdentifierChars
		) {
			deactivateLock(lockIdentifierChars, 'blue');
		}

		if (
			document.getElementById('bluelock' + lockIdentifierChars + 'alt').style.opacity == 1 &&
			lockdict[bluelockedspellname] != lockIdentifierChars
		) {
			deactivateLock(lockIdentifierChars + 'alt', 'blue');
		}
	}

	if (redlockedspellname) {
		if (
			document.getElementById('redlock' + lockdict[redlockedspellname]).style.opacity == 0 &&
			document.getElementById('redlock' + lockdict[redlockedspellname] + 'alt').style.opacity == 0
		) {
			if (document.getElementById('bluelock' + lockdict[redlockedspellname]).style.opacity == 0) {
				activateLock(lockdict[redlockedspellname], 'red');
			} else {
				activateLock(lockdict[redlockedspellname] + 'alt', 'red');
			}
		}
	}

	if (bluelockedspellname) {
		if (
			document.getElementById('bluelock' + lockdict[bluelockedspellname]).style.opacity == 0 &&
			document.getElementById('bluelock' + lockdict[bluelockedspellname] + 'alt').style.opacity == 0
		) {
			if (document.getElementById('redlock' + lockdict[bluelockedspellname]).style.opacity == 0) {
				activateLock(lockdict[bluelockedspellname], 'blue');
			} else {
				activateLock(lockdict[bluelockedspellname] + 'alt', 'blue');
			}
		}
	}

	var score = boardstate['score'];
	if (score) {
		document.getElementById('scorekeeper').className = 'score' + score;
	}

	var redspellcounter = boardstate['redspellcounter'];
	document.getElementById('redspellcounter').innerHTML = redspellcounter;

	var bluespellcounter = boardstate['bluespellcounter'];
	document.getElementById('bluespellcounter').innerHTML = bluespellcounter;
}

function activateLock(lockIdentifierChars, color) {
	document.getElementById(color + 'lock' + lockIdentifierChars).style.opacity = 1;
}

function deactivateLock(lockIdentifierChars, color) {
	document.getElementById(color + 'lock' + lockIdentifierChars).style.opacity = 0;
}
