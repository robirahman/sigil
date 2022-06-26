// JavaScript for home page
// eslint-disable-next-line no-unused-vars
function main() {
	document.getElementById('tutorialbutton').onmouseover = function () {
		document.getElementById('tutorialtext').style.display = 'inline';
	};
	document.getElementById('singleplayerbutton').onmouseover = function () {
		document.getElementById('singleplayertext').style.display = 'inline';
	};
	document.getElementById('privatematchbutton').onmouseover = function () {
		document.getElementById('privatematchtext').style.display = 'inline';
	};
	document.getElementById('laddermatchbutton').onmouseover = function () {
		document.getElementById('laddermatchtext').style.display = 'inline';
	};

	document.getElementById('tutorialbutton').onmouseout = function () {
		document.getElementById('tutorialtext').style.display = 'none';
	};
	document.getElementById('singleplayerbutton').onmouseout = function () {
		document.getElementById('singleplayertext').style.display = 'none';
	};
	document.getElementById('privatematchbutton').onmouseout = function () {
		document.getElementById('privatematchtext').style.display = 'none';
	};
	document.getElementById('laddermatchbutton').onmouseout = function () {
		document.getElementById('laddermatchtext').style.display = 'none';
	};

	document.getElementById('tutorialbutton').addEventListener('click', function () {
		document.getElementById('tutorialtext').style.display = 'none';
	});
	document.getElementById('singleplayerbutton').addEventListener('click', function () {
		document.getElementById('singleplayertext').style.display = 'none';
	});
	document.getElementById('privatematchbutton').addEventListener('click', function () {
		document.getElementById('privatematchtext').style.display = 'none';
	});
	document.getElementById('laddermatchbutton').addEventListener('click', function () {
		document.getElementById('laddermatchtext').style.display = 'none';
	});

	document.getElementById('ritual1').onmouseover = function () {
		document.getElementById('ritual1text').style.display = 'inline';
	};
	document.getElementById('ritual2').onmouseover = function () {
		document.getElementById('ritual2text').style.display = 'inline';
	};
	document.getElementById('ritual3').onmouseover = function () {
		document.getElementById('ritual3text').style.display = 'inline';
	};

	document.getElementById('ritual1').onmouseout = function () {
		document.getElementById('ritual1text').style.display = 'none';
	};
	document.getElementById('ritual2').onmouseout = function () {
		document.getElementById('ritual2text').style.display = 'none';
	};
	document.getElementById('ritual3').onmouseout = function () {
		document.getElementById('ritual3text').style.display = 'none';
	};

	document.getElementById('sorcery1').onmouseover = function () {
		document.getElementById('sorcery1text').style.display = 'inline';
	};
	document.getElementById('sorcery2').onmouseover = function () {
		document.getElementById('sorcery2text').style.display = 'inline';
	};
	document.getElementById('sorcery3').onmouseover = function () {
		document.getElementById('sorcery3text').style.display = 'inline';
	};

	document.getElementById('sorcery1').onmouseout = function () {
		document.getElementById('sorcery1text').style.display = 'none';
	};
	document.getElementById('sorcery2').onmouseout = function () {
		document.getElementById('sorcery2text').style.display = 'none';
	};
	document.getElementById('sorcery3').onmouseout = function () {
		document.getElementById('sorcery3text').style.display = 'none';
	};

	document.getElementById('charm1').onmouseover = function () {
		document.getElementById('charm1text').style.display = 'inline';
	};
	document.getElementById('charm2').onmouseover = function () {
		document.getElementById('charm2text').style.display = 'inline';
	};
	document.getElementById('charm3').onmouseover = function () {
		document.getElementById('charm3text').style.display = 'inline';
	};

	document.getElementById('charm1').onmouseout = function () {
		document.getElementById('charm1text').style.display = 'none';
	};
	document.getElementById('charm2').onmouseout = function () {
		document.getElementById('charm2text').style.display = 'none';
	};
	document.getElementById('charm3').onmouseout = function () {
		document.getElementById('charm3text').style.display = 'none';
	};

	document.getElementById('mana1').onmouseover = function () {
		document.getElementById('mana1text').style.display = 'inline';
	};
	document.getElementById('mana2').onmouseover = function () {
		document.getElementById('mana2text').style.display = 'inline';
	};
	document.getElementById('mana3').onmouseover = function () {
		document.getElementById('mana3text').style.display = 'inline';
	};

	document.getElementById('mana1').onmouseout = function () {
		document.getElementById('mana1text').style.display = 'none';
	};
	document.getElementById('mana2').onmouseout = function () {
		document.getElementById('mana2text').style.display = 'none';
	};
	document.getElementById('mana3').onmouseout = function () {
		document.getElementById('mana3text').style.display = 'none';
	};

	document.getElementById('scorekeeper').onmouseover = function () {
		document.getElementById('scorekeepertext').style.display = 'inline';
	};
	document.getElementById('scorekeeper').onmouseout = function () {
		document.getElementById('scorekeepertext').style.display = 'none';
	};
}
