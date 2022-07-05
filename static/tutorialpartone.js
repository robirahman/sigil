// eslint-disable-next-line no-unused-vars
function main() {
	tutorialcounter = 1;
	runningSampleGameOne = true;
	runningSampleGameTwo = true;

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

	document.getElementById('nextbutton').addEventListener(
		'click',
		function () {
			nextClick(this);
		},
		false
	);

	document.addEventListener('keydown', keyDownFunction, false);


	tutorialtext2 =
		"Sigil is a battle between the red stones and blue stones.<br>Each side is trying to expand their territory<br>and attack the opponent's territory.";

	tutorialtext3 =
		'As your stones expand<br>to different regions of the board,<br>you gain access to special<br>abilities called <b>spells</b>.';

	tutorialtext4 =
		'The nine large dark circles on the<br>board are locations for spells to<br>be placed. There are three small, three medium,<br>and three large spell locations.';

	tutorialtext5 =
		'Before the game starts,<br>spells are placed at random<br>into these nine locations.';

	tutorialtext6 =
		"Let's place spells<br>onto the board now.";

	tutorialtext7 = "Now we're ready to begin the game.";

	tutorialtext8 = 'Each side starts with just<br>one stone on the board.';

	tutorialtext9 =
		"The red circle in the bottom<br>left is red's starting location.";

	tutorialtext10 =
		"Blue starts with a stone<br>in the bottom right.";

	tutorialtext11 =
		"On each player's turn,<br>they place one new<br>stone of their color onto<br>the board.";

	tutorialtext12 = 'The new stone must be adjacent<br>to a stone they already have.';

	tutorialtext13 = "The small white circles are called <b>nodes</b>.<br>Stones are placed inside of nodes.";

	tutorialtext14 = "If you fill all the nodes<br>inside a spell with your stones,<br>you may cast that spell for<br>a powerful effect.";

	tutorialtext15 = "To cast a spell, first make<br>your standard move for the<br>turn by placing a new stone.<br>After that, if you have a spell<br>filled with your stones, click<br>on the center of the spell<br>to cast it.";

	tutorialtext16 = "When you cast a spell,<br>all your stones on the<br>spell are sacrificed<br>(removed from the board).";

	tutorialtext17 = "Each spell has a different<br>effect. Hover over a spell<br>to see its effect.";

	tutorialtext18 = "For example, Searing Wind<br>has the effect 'Destroy<br>all enemy stones which are<br>touching you.'";

	tutorialtext19 = "If you place a stone to fill<br>Searing Wind, then cast it,<br>you will first sacrifice the<br>three stones from Searing Wind.";

	tutorialtext20 = "Then all enemy stones<br>anywhere on the board<br>which are touching your<br>stones will be destroyed.";

	tutorialtext21 = "Notice that the three<br>stones on Searing Wind are<br>already gone by the time<br>the effect resolves; so<br>they don't count for<br>Searing Wind's effect.";

	tutorialtext22 = "Ideally, you'd like to destroy<br>at least three enemy stones<br>when you cast Searing Wind,<br>to make up for the three<br>you sacrificed.";

	tutorialtext23 = "If you'd rather save<br>a spell for later, you don't<br>have to cast it immediately.";

	tutorialtext24 = "In this position, blue<br>might want to wait until<br>their Searing Wind would<br>destroy more enemy stones.";

	tutorialtext25 = "There are also three<br>special <b>mana</b> nodes around<br>the edge of the board.";
	
	tutorialtext26 = "One of the mana nodes is red's<br>starting location.";

	tutorialtext27 = "Another one is blue's<br>starting location.";

	tutorialtext28 = "The third mana node at the<br>top of the board is neutral--<br>neither player starts with a<br>stone there.";

	tutorialtext29 = "Mana is the most important resource<br>in Sigil; if you gain control of<br>two out of three mana, it<br>will give you a big advantage.";

	tutorialtext30 = "This is because your spells become<br>more powerful with each additional<br>mana you control.";

	tutorialtext31 = "When you cast a spell, you<br>sacrifice one fewer stone<br>for each mana you control.";

	tutorialtext32 = "For example, if you control<br>one mana, and have filled<br>Searing Wind with your stones,<br>then you only need to sacrifice<br>two of them to cast it.";

	tutorialtext33 = "With two mana, you would<br>only have to sacrifice one<br>stone to cast it.";

	tutorialtext34 = "With all three mana,<br>you wouldn't have to sacrifice<br>any stones at all.";

	tutorialtext35 = "The spell must always<br>be filled with your stones<br>before you can cast it.<br>Controlling mana just means<br>you will get to keep some stones<br>in the spell afterwards.";

	tutorialtext36 = "Although each player starts with<br>one mana, there is no guarantee<br>that they will keep it forever.";

	tutorialtext37 = "In Sigil, players can steal territory<br>from each other by moving into<br>enemy-occupied nodes.";

	tutorialtext38 = "So your opponent might try to<br>steal your starting mana, and<br>make you fight to defend it!";

	tutorialtext39 = "Or you might spot an opportunity<br>to attack your opponent's starting<br>mana and take it from them.";

	tutorialtext40 = "You win the game if you have<br>three more stones than your opponent<br>at the end of your turn.";

	tutorialtext41 = "But if players just take turns<br>placing one new stone at a<br>time, nobody will ever get<br>a three-stone advantage.";

	tutorialtext42 = "Casting spells like Searing<br>Wind is one way to get a stone<br>advantage, if you destroy<br>more enemy stones than<br>you had to sacrifice.";

	tutorialtext43 = "The more mana you control,<br>the more likely that<br>your spells will give<br>you a stone advantage.";

	tutorialtext44 = "In Part 3, we'll see that surrounding<br>a group of enemy stones is<br> another way to get a stone advantage.";

	tutorialtext45 = "To keep track of which color has<br>a stone advantage, we use the<br>scorekeeping area in the middle<br>of the Sigil board.";

	tutorialtext46 = "A single blue stone is used<br>to track the current score.";

	tutorialtext47 = "If both colors have the same<br>number of stones on the board,<br>the scorekeeper goes in the middle.";

	tutorialtext48 = "If one color has more stones,<br>the scorekeeper moves to mark<br>how big of an advantage they have.";

	tutorialtext49 = "When the scorekeeper marks<br>a three-stone advantage for one<br>color, that player wins.";

	tutorialtext50 = "The scorekeeper stone itself<br>counts as a blue stone. So at<br>the start of the game, blue has<br>a one-stone advantage.";

	tutorialtext51 = "But red gets to move first,<br>and after they place a stone<br>on their first turn, the score<br>will be tied at two stones each.";

	tutorialtext52 = "Then blue will move and get<br>a one-stone advantage again.";

	tutorialtext53 = "At the end of each player's turn,<br>that player moves the scorekeeper stone<br>to mark the current stone advantage.";

	tutorialtext54 = "In the physical Sigil board game,<br>this is also how you show that<br>you're finished with your turn.";

	tutorialtext55 = "In Sigil Online, you can just press<br>the 'End Turn' button (or Space) and<br>the scorekeeper stone will update<br>automatically.";

	tutorialtext56 = "This concludes Part 1 of the<br>tutorial. See you in Part 2!";


	fadeIn();
}

function fadeIn() {
	document.getElementById('board').style.opacity = 1;
}

function fadeInSpells() {
	document.getElementById('charm1').style.opacity = 1;
	document.getElementById('charm2').style.opacity = 1;
	document.getElementById('charm3').style.opacity = 1;
	document.getElementById('sorcery1').style.opacity = 1;
	document.getElementById('sorcery2').style.opacity = 1;
	document.getElementById('sorcery3').style.opacity = 1;
	document.getElementById('ritual1').style.opacity = 1;
	document.getElementById('ritual2').style.opacity = 1;
	document.getElementById('ritual3').style.opacity = 1;

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

function arrowBlueManaFadeIn() {
	document.getElementById('arrowbluemana').style.visibility = "visible";
	document.getElementById('arrowbluemana').style.opacity = 1;
	document.getElementById('arrowbluemana').style.left = '815px';
}

function arrowRedManaFadeIn() {
	document.getElementById('arrowredmana').style.visibility = "visible";
	document.getElementById('arrowredmana').style.opacity = 1;
	document.getElementById('arrowredmana').style.left = '-78px';
}

function arrowNeutralManaFadeIn() {
	document.getElementById('arrowneutralmana').style.visibility = "visible";
	document.getElementById('arrowneutralmana').style.opacity = 1;
	document.getElementById('arrowneutralmana').style.left = '640px';
}

function arrowScorekeeperFadeIn() {
	document.getElementById('arrowscorekeeper').style.opacity = 1;
	document.getElementById('arrowscorekeeper').style.left = '300px';
}

function arrowRitual1FadeIn() {
	document.getElementById('arrowritual1').style.opacity = 1;
	document.getElementById('arrowritual1').style.left = '-5px';
}

function arrowSorcery1FadeIn() {
	document.getElementById('arrowsorcery1').style.opacity = 1;
	document.getElementById('arrowsorcery1').style.left = '285px';
}

function arrowCharm1FadeIn() {
	document.getElementById('arrowcharm1').style.opacity = 1;
	document.getElementById('arrowcharm1').style.left = '270px';
}

function arrowRitual2FadeIn() {
	document.getElementById('arrowritual2').style.opacity = 1;
	document.getElementById('arrowritual2').style.left = '865px';
}

function arrowSorcery2FadeIn() {
	document.getElementById('arrowsorcery2').style.opacity = 1;
	document.getElementById('arrowsorcery2').style.left = '845px';
}

function arrowCharm2FadeIn() {
	document.getElementById('arrowcharm2').style.opacity = 1;
	document.getElementById('arrowcharm2').style.left = '700px';
}

function arrowRitual3FadeIn() {
	document.getElementById('arrowritual3').style.opacity = 1;
	document.getElementById('arrowritual3').style.left = '260px';
}

function arrowSorcery3FadeIn() {
	document.getElementById('arrowsorcery3').style.opacity = 1;
	document.getElementById('arrowsorcery3').style.left = '5px';
}

function arrowCharm3FadeIn() {
	document.getElementById('arrowcharm3').style.opacity = 1;
	document.getElementById('arrowcharm3').style.left = '195px';
}



function arrowBlueManaFadeOut() {
	document.getElementById('arrowbluemana').style.visibility = "hidden";
	document.getElementById('arrowbluemana').style.opacity = 0;
	document.getElementById('arrowbluemana').style.left = '915px';
}

function arrowRedManaFadeOut() {
	document.getElementById('arrowredmana').style.visibility = "hidden";
	document.getElementById('arrowredmana').style.opacity = 0;
	document.getElementById('arrowredmana').style.left = '-178px';
}

function arrowNeutralManaFadeOut() {
	document.getElementById('arrowneutralmana').style.visibility = "hidden";
	document.getElementById('arrowneutralmana').style.opacity = 0;
	document.getElementById('arrowneutralmana').style.left = '740px';
}

function startingStonesFadeIn() {
	document.getElementById('a1').src = '/static/images/redstone.png';
	document.getElementById('b1').src = '/static/images/bluestone.png';
}

function keyDownFunction(e) {
	var keyCode = e.keyCode;
	if (keyCode == 32) {
		e.preventDefault();
		document.getElementById('nextbutton').click();
	}
}


function clearBoard() {
	for (var name of allnodenames) {
		document.getElementById(name).src = '/static/images/emptystone.png';
	}
}

function sampleGameOne() {

	nodelist = ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4', 'a5', 'b5', 'a6', 'b6', 'a7', 'b7', 'a8', 'b8', 'a9', 'b9', 'a10', 'b10', 'a12', 'c11', 'c7', 'c1', 'c4', 'c2', 'c5', 'c3', 'c6', 'c13'];

	playSampleGameOne = async () => {
		while (runningSampleGameOne) {
			whichColor = 0;

  		for (var node of nodelist) {
    		await new Promise(r => setTimeout(r, 100));
    		whichColor += 1;
    		if (whichColor % 2 == 0) {
	    		document.getElementById(node).src = '/static/images/bluestone.png';
	    	} else {
	    		document.getElementById(node).src = '/static/images/redstone.png';
	    	}
  }
  await new Promise(r => setTimeout(r, 1000));
  clearBoard();
}

}

		playSampleGameOne();

}

function sampleGameTwo() {

	nodelist = ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4', 'a5', 'b5', 'a6', 'b6'];

	playSampleGameTwo = async () => {
		while (runningSampleGameTwo) {
			whichColor = 0;

  		for (var node of nodelist) {
    		await new Promise(r => setTimeout(r, 500));
    		whichColor += 1;
    		if (whichColor % 2 == 0) {
	    		document.getElementById(node).src = '/static/images/bluestone.png';
	    	} else {
	    		document.getElementById(node).src = '/static/images/redstone.png';
	    	}
  }
  await new Promise(r => setTimeout(r, 1000));
  clearBoard();
}

}

		playSampleGameTwo();

}

function nextClick() {
	tutorialcounter += 1;

	if (tutorialcounter == 2) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext2;
		sampleGameOne();
	} else if (tutorialcounter == 3) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext3;
		runningSampleGameOne = false;
	} else if (tutorialcounter == 4) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext4;
		arrowRitual1FadeIn();
		arrowRitual2FadeIn();
		arrowRitual3FadeIn();
		arrowSorcery1FadeIn();
		arrowSorcery2FadeIn();
		arrowSorcery3FadeIn();
		arrowCharm1FadeIn();
		arrowCharm2FadeIn();
		arrowCharm3FadeIn();
	} else if (tutorialcounter == 5) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext5;
	} else if (tutorialcounter == 6) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext6;
		document.getElementById('arrowritual1').style.visibility = "hidden";
		document.getElementById('arrowritual2').style.visibility = "hidden";
		document.getElementById('arrowritual3').style.visibility = "hidden";
		document.getElementById('arrowsorcery1').style.visibility = "hidden";
		document.getElementById('arrowsorcery2').style.visibility = "hidden";
		document.getElementById('arrowsorcery3').style.visibility = "hidden";
		document.getElementById('arrowcharm1').style.visibility = "hidden";
		document.getElementById('arrowcharm2').style.visibility = "hidden";
		document.getElementById('arrowcharm3').style.visibility = "hidden";
	} else if (tutorialcounter == 7) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext7;
		fadeInSpells();
		addSpellLabels();
	} else if (tutorialcounter == 8) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext8;
	} else if (tutorialcounter == 9) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext9;
		arrowRedManaFadeIn();
		startingStonesFadeIn();
	} else if (tutorialcounter == 10) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext10;
		arrowBlueManaFadeIn();
		arrowRedManaFadeOut();
	} else if (tutorialcounter == 11) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext11;
		arrowBlueManaFadeOut();
		sampleGameTwo();
	} else if (tutorialcounter == 12) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext12;
		runningSampleGameTwo = false;
	} else if (tutorialcounter == 13) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext13;
	} else if (tutorialcounter == 14) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext14;
	} else if (tutorialcounter == 15) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext15;
	} else if (tutorialcounter == 16) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext16;
	} else if (tutorialcounter == 17) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext17;
	} else if (tutorialcounter == 18) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext18;
	} else if (tutorialcounter == 19) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext19;
	} else if (tutorialcounter == 20) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext20;
	} else if (tutorialcounter == 21) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext21;
	} else if (tutorialcounter == 22) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext22;
	} else if (tutorialcounter == 23) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext23;
	} else if (tutorialcounter == 24) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext24;
	} else if (tutorialcounter == 25) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext25;
	} else if (tutorialcounter == 26) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext26;
		arrowRedManaFadeIn();
	} else if (tutorialcounter == 27) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext27;
		arrowBlueManaFadeIn();
		arrowRedManaFadeOut();
	} else if (tutorialcounter == 28) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext28;
		arrowBlueManaFadeOut();
		arrowNeutralManaFadeIn();
	} else if (tutorialcounter == 29) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext29;
		arrowNeutralManaFadeOut();
	} else if (tutorialcounter == 30) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext30;
	} else if (tutorialcounter == 31) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext31;
	} else if (tutorialcounter == 32) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext32;
	} else if (tutorialcounter == 33) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext33;
	} else if (tutorialcounter == 34) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext34;
	} else if (tutorialcounter == 35) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext35;
	} else if (tutorialcounter == 36) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext36;
	} else if (tutorialcounter == 37) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext37;
	} else if (tutorialcounter == 38) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext38;
	} else if (tutorialcounter == 39) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext39;
	} else if (tutorialcounter == 40) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext40;
	} else if (tutorialcounter == 41) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext41;
	} else if (tutorialcounter == 42) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext42;
	} else if (tutorialcounter == 43) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext43;
	} else if (tutorialcounter == 44) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext44;
	} else if (tutorialcounter == 45) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext45;
		arrowScorekeeperFadeIn();
	} else if (tutorialcounter == 46) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext46;
		document.getElementById('arrowscorekeeper').style.visibility = "hidden";
		document.getElementById('scorekeeper').style.opacity = 1;
	} else if (tutorialcounter == 47) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext47;
		document.getElementById('scorekeeper').className = "scoretied";
	} else if (tutorialcounter == 48) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext48;
		document.getElementById('scorekeeper').className = "scorer1";
	} else if (tutorialcounter == 49) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext49;
		document.getElementById('scorekeeper').className = "scorer3";
	} else if (tutorialcounter == 50) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext50;
		startingStonesFadeIn();
		document.getElementById('scorekeeper').className = "scoreb1";
	} else if (tutorialcounter == 51) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext51;
		document.getElementById('a2').src = '/static/images/redstone.png';
		document.getElementById('scorekeeper').className = "scoretied";
	} else if (tutorialcounter == 52) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext52;
		document.getElementById('b2').src = '/static/images/bluestone.png';
		document.getElementById('scorekeeper').className = "scoreb1";
	} else if (tutorialcounter == 53) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext53;
	} else if (tutorialcounter == 54) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext54;
	} else if (tutorialcounter == 55) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext55;
	} else if (tutorialcounter == 56) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext56;
	}
}
