// JavaScript for private match page
// eslint-disable-next-line no-unused-vars
function main() {
	waitingForOpponent = false;

	document.getElementById('creategamebutton').onmouseover = function () {
		document.getElementById('creategametext').style.display = 'inline';
	};
	document.getElementById('joingamebutton').onmouseover = function () {
		document.getElementById('joingametext').style.display = 'inline';
	};

	document.getElementById('creategamebutton').onmouseout = function () {
		document.getElementById('creategametext').style.display = 'none';
	};
	document.getElementById('joingamebutton').onmouseout = function () {
		document.getElementById('joingametext').style.display = 'none';
	};

	document.getElementById('creategamebutton').addEventListener('click', function () {
		document.getElementById('creategameform').style.display = 'inline';
		document.getElementById('joingameform').style.display = 'none';
	});

	document.getElementById('joingamebutton').addEventListener('click', function () {
		document.getElementById('joingameform').style.display = 'inline';
		document.getElementById('creategameform').style.display = 'none';
	});

	createGameForm = document.getElementById('creategameform');

	createGameForm.addEventListener('submit', function (event) {
		event.preventDefault();

		if (!waitingForOpponent) {
			// Might need to change this to "wss://" when we set up HTTPS
			createGameWs = new WebSocket('ws://' + location.host + '/api/creategame');

			createGameWs.addEventListener('open', () => {
				var payload = {
					gamename: createGameForm.elements['gamename'].value,
					gamepwd: createGameForm.elements['gamepwd'].value,
				};
				createGameWs.send(JSON.stringify(payload));
			});

			createGameWs.addEventListener('message', function (event) {
				var payload = JSON.parse(event.data);
				if (payload.type == 'nameconflict') {
					document.getElementById('privatematchdescription').innerHTML =
						'That name is already taken. Choose another game name.';
				} else if (payload.type == 'success') {
					document.getElementById('privatematchdescription').innerHTML =
						'Game ' +
						createGameForm.elements['gamename'].value +
						' created. Waiting for opponent to join...';
					waitingForOpponent = true;
				} else if (payload.type == 'startprivategame') {
					// Update this if we switch to HTTPS
					window.location.href = 'privategameboard/' + payload.gamename;
				}
			});
		}
	});

	joinGameForm = document.getElementById('joingameform');

	joinGameForm.addEventListener('submit', function (event) {
		event.preventDefault();

		if (!waitingForOpponent) {
			// Might need to change this to "wss://" when we set up HTTPS
			joinGameWs = new WebSocket('ws://' + location.host + '/api/joingame');

			joinGameWs.addEventListener('open', () => {
				var payload = {
					gamename: joinGameForm.elements['gamename'].value,
					gamepwd: joinGameForm.elements['gamepwd'].value,
				};
				joinGameWs.send(JSON.stringify(payload));
			});

			joinGameWs.addEventListener('message', function (event) {
				var payload = JSON.parse(event.data);
				if (payload.type == 'notfound') {
					document.getElementById('privatematchdescription').innerHTML =
						'That game does not exist, or the password is incorrect.';
				} else if (payload.type == 'startprivategame') {
					// Update this if we switch to HTTPS
					window.location.href = 'privategameboard/' + payload.gamename;
				}
			});
		}
	});
}
