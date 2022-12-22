// JavaScript for private match page
// eslint-disable-next-line no-unused-vars
function main() {
	let waitingForOpponent = false;

	document.getElementById('creategamebutton').addEventListener('click', function () {
		document.getElementById('creategameform').style.display = 'flex';
		document.getElementById('joingameform').style.display = 'none';
	});

	document.getElementById('joingamebutton').addEventListener('click', function () {
		document.getElementById('joingameform').style.display = 'flex';
		document.getElementById('creategameform').style.display = 'none';
	});

	const createGameForm = document.getElementById('creategameform');

	createGameForm.addEventListener('submit', function (event) {
		event.preventDefault();

		if (!waitingForOpponent) {
			const apiProtocol = document.location.protocol === 'http:' ? 'ws:' : 'wss:';
			const createGameWs = new WebSocket(`${apiProtocol}//${location.host}/api/creategame`);

			createGameWs.addEventListener('open', () => {
				const payload = {
					gamename: createGameForm.elements['gamename'].value,
				};
				createGameWs.send(JSON.stringify(payload));
			});

			createGameWs.addEventListener('message', function (event) {
				const payload = JSON.parse(event.data);
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
					window.location.href = '/private-game/' + payload.gamename;
				}
			});
		}
	});

	const joinGameForm = document.getElementById('joingameform');

	joinGameForm.addEventListener('submit', function (event) {
		event.preventDefault();

		if (!waitingForOpponent) {
			const apiProtocol = document.location.protocol === 'http:' ? 'ws:' : 'wss:';
			const joinGameWs = new WebSocket(`${apiProtocol}//${location.host}/api/joingame`);

			joinGameWs.addEventListener('open', () => {
				const payload = {
					gamename: joinGameForm.elements['gamename'].value,
				};
				joinGameWs.send(JSON.stringify(payload));
			});

			joinGameWs.addEventListener('message', function (event) {
				const payload = JSON.parse(event.data);
				if (payload.type == 'notfound') {
					document.getElementById('privatematchdescription').innerHTML =
						'That game does not exist.';
				} else if (payload.type == 'startprivategame') {
					// Update this if we switch to HTTPS
					window.location.href = '/private-game/' + payload.gamename;
				}
			});
		}
	});
}

document.addEventListener('DOMContentLoaded', main);
