// eslint-disable-next-line no-unused-vars
function main() {
	tutorialcounter = 1;
	runningSampleGameOne = true;
	runningSampleGameTwo = true;
	runningSampleGameThree = true;

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
		'Sigil is a two-player strategy board game<br>designed by Andreas Voellmer and<br>published by Pine Island Games.';


	tutorialtext3 =
		"At sigilbattle.com you can play<br>Sigil online for free. If you<br>enjoy the game, we hope you'll consider<br>backing us on Kickstarter to get a<br>physical Sigil board as well!";

	tutorialtext4 =
		"Check the <a href='https://www.pineislandgames.com' target='_blank' rel='noopener noreferrer'>Pine Island Games website</a><br>for details, and join our mailing list for updates.";


	tutorialtext5 = "Learn the rules in this tutorial,<br>then test out your skills in a<br>single-player game against an AI.";


	tutorialtext6 = "When you're ready, challenge<br>a friend to a private match.";

	tutorialtext7 = "Finally, you can play ladder matches<br>to compete against top Sigil<br>players across the world.";


	tutorialtext8 = 'So, how do you play Sigil?';

	tutorialtext9 =
		"Sigil is a battle between the red stones and blue stones.<br>Each side is trying to expand their territory<br>and attack the opponent's territory.";

	tutorialtext10 =
		'As your stones expand<br>to different regions of the board,<br>you gain access to special<br>abilities called <b>spells</b>.';

	tutorialtext11 =
		'The nine large dark circles on the<br>board are locations for spells to<br>be placed. There are three small, three medium,<br>and three large spell locations.';

	tutorialtext12 =
		'Before the game starts,<br>spells are placed at random<br>into these nine locations.';

	tutorialtext13 =
		"We'll talk more about how spells work<br>in Part 2 of this tutorial.<br>For now, let's fill the board<br>with spells just so we can see what<br>a completed board looks like.";

	tutorialtext14 = "With the spells in place,<br>we're ready to play.";

	tutorialtext15 = 'Each side starts with just<br>one stone on the board.';

	tutorialtext16 =
		"The red circle in the bottom<br>left is red's starting location.";

	tutorialtext17 =
		"Blue starts with a stone<br>in the bottom right.";

	tutorialtext18 =
		"On each player's turn,<br>they place one new<br>stone of their color onto<br>the board.";

	tutorialtext19 = 'The new stone must be adjacent<br>to a stone they already have.';

	tutorialtext20 = "The small white circles are called <b>nodes</b>.<br>Stones are placed inside of nodes.";

	tutorialtext21 = "There are also three<br>special <b>mana</b> nodes around<br>the edge of the board.";
	
	tutorialtext22 = "One of the mana nodes is red's<br>starting location.";

	tutorialtext23 = "Another one is blue's<br>starting location.";

	tutorialtext24 = "The third mana node at the<br>top of the board is neutral--<br>neither player starts with a<br>stone there.";

	tutorialtext25 = "Mana is the most important resource<br>in Sigil; if you gain control of<br>two out of three mana, it<br>will give you a big advantage.";

	tutorialtext26 = "This is because your spells become<br>more powerful with each additional<br>mana you control.";

	tutorialtext27 = "We'll explain how mana works<br>in more detail in Part 2.";

	tutorialtext28 = "Although each player starts with<br>one mana, there is no guarantee<br>that they will keep it forever.";

	tutorialtext29 = "In Sigil, players can steal territory<br>from each other by moving into<br>enemy-occupied nodes.";

	tutorialtext30 = "So your opponent might try to<br>steal your starting mana, and<br>make you fight to defend it!";

	tutorialtext31 = "Or you might spot an opportunity<br>to attack your opponent's starting<br>mana and take it from them.";

	tutorialtext32 = "Many games of Sigil will start<br>with both players racing to<br>grab the third neutral mana<br>at the top of the board.";

	tutorialtext33 = "We'll talk in more detail about<br>how to push enemy stones and<br>fight over territory in Part 3<br>of this tutorial.";

	tutorialtext34 = "You win the game if you have<br>three more stones than your opponent<br>at the end of your turn.";

	tutorialtext35 = "But if players just take turns<br>placing one new stone at a<br>time, nobody will ever get<br>a three-stone advantage.";

	tutorialtext36 = "In Part 2, we'll see that casting<br>spells is one way to get a stone<br>advantage-- especially if you<br>control more than one mana.";

	tutorialtext37 = "In Part 3, we'll see that surrounding<br>a group of enemy stones is<br> another way to get a stone advantage.";

	tutorialtext38 = "To keep track of which color has<br>a stone advantage, we use the<br>scorekeeping area in the middle<br>of the Sigil board.";

	tutorialtext39 = "A single blue stone is used<br>to track the current score.";

	tutorialtext40 = "If both colors have the same<br>number of stones on the board,<br>the scorekeeper goes in the middle.";

	tutorialtext41 = "If one color has more stones,<br>the scorekeeper moves to mark<br>how big of an advantage they have.";

	tutorialtext42 = "When the scorekeeper marks<br>a three-stone advantage for one<br>color, that player wins.";

	tutorialtext43 = "The scorekeeper stone itself<br>counts as a blue stone. So at<br>the start of the game, blue has<br>a one-stone advantage.";

	tutorialtext44 = "But red gets to move first,<br>and after they place a stone<br>on their first turn, the score<br>will be tied at two stones each.";

	tutorialtext45 = "Then blue will move and get<br>a one-stone advantage again.";

	tutorialtext46 = "At the end of each player's turn,<br>that player moves the scorekeeper stone<br>to mark the current stone advantage.";

	tutorialtext47 = "In the physical Sigil board game,<br>this is also how you show that<br>you're finished with your turn.";

	tutorialtext48 = "In Sigil Online, you can just press<br>the 'End Turn' button (or Space) and<br>the scorekeeper stone will update<br>automatically.";

	tutorialtext49 = "This concludes Part 1 of the<br>tutorial. See you in Part 2!";


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

function sampleGameThree() {

	nodelist = ['a1', 'b1', 'a11', 'b2', 'c10', 'b3', 'c9', 'b13', 'c13', 'b9', 'c3', 'b10', 'c2', 'c11', 'c1'];

	playSampleGameThree = async () => {
		while (runningSampleGameThree) {
			whichColor = 0;

  		for (var node of nodelist) {
    		await new Promise(r => setTimeout(r, 300));
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

		playSampleGameThree();

}

function nextClick() {
	tutorialcounter += 1;

	if (tutorialcounter == 2) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext2;
	} else if (tutorialcounter == 3) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext3;
	} else if (tutorialcounter == 4) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext4;
	} else if (tutorialcounter == 5) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext5;
	} else if (tutorialcounter == 6) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext6;
	} else if (tutorialcounter == 7) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext7;
	} else if (tutorialcounter == 8) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext8;
	} else if (tutorialcounter == 9) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext9;
		sampleGameOne();
	} else if (tutorialcounter == 10) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext10;
		runningSampleGameOne = false;
	} else if (tutorialcounter == 11) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext11;
		arrowRitual1FadeIn();
		arrowRitual2FadeIn();
		arrowRitual3FadeIn();
		arrowSorcery1FadeIn();
		arrowSorcery2FadeIn();
		arrowSorcery3FadeIn();
		arrowCharm1FadeIn();
		arrowCharm2FadeIn();
		arrowCharm3FadeIn();
	} else if (tutorialcounter == 12) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext12;
	} else if (tutorialcounter == 13) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext13;
		document.getElementById('arrowritual1').style.visibility = "hidden";
		document.getElementById('arrowritual2').style.visibility = "hidden";
		document.getElementById('arrowritual3').style.visibility = "hidden";
		document.getElementById('arrowsorcery1').style.visibility = "hidden";
		document.getElementById('arrowsorcery2').style.visibility = "hidden";
		document.getElementById('arrowsorcery3').style.visibility = "hidden";
		document.getElementById('arrowcharm1').style.visibility = "hidden";
		document.getElementById('arrowcharm2').style.visibility = "hidden";
		document.getElementById('arrowcharm3').style.visibility = "hidden";
	} else if (tutorialcounter == 14) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext14;
		fadeInSpells();
	} else if (tutorialcounter == 15) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext15;
	} else if (tutorialcounter == 16) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext16;
		arrowRedManaFadeIn();
		startingStonesFadeIn();
	} else if (tutorialcounter == 17) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext17;
		arrowBlueManaFadeIn();
		arrowRedManaFadeOut();
	} else if (tutorialcounter == 18) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext18;
		arrowBlueManaFadeOut();
		sampleGameTwo();
	} else if (tutorialcounter == 19) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext19;
	} else if (tutorialcounter == 20) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext20;
		runningSampleGameTwo = false;
	} else if (tutorialcounter == 21) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext21;
	} else if (tutorialcounter == 22) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext22;
		arrowRedManaFadeIn();
	} else if (tutorialcounter == 23) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext23;
		arrowBlueManaFadeIn();
		arrowRedManaFadeOut();
	} else if (tutorialcounter == 24) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext24;
		arrowBlueManaFadeOut();
		arrowNeutralManaFadeIn();
	} else if (tutorialcounter == 25) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext25;
		arrowNeutralManaFadeOut();
	} else if (tutorialcounter == 26) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext26;
	} else if (tutorialcounter == 27) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext27;
	} else if (tutorialcounter == 28) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext28;
	} else if (tutorialcounter == 29) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext29;
	} else if (tutorialcounter == 30) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext30;
	} else if (tutorialcounter == 31) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext31;
	} else if (tutorialcounter == 32) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext32;
		sampleGameThree();
	} else if (tutorialcounter == 33) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext33;
		runningSampleGameThree = false;
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
		arrowScorekeeperFadeIn();
	} else if (tutorialcounter == 39) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext39;
		document.getElementById('arrowscorekeeper').style.visibility = "hidden";
		document.getElementById('scorekeeper').style.opacity = 1;
	} else if (tutorialcounter == 40) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext40;
		document.getElementById('scorekeeper').className = "scoretied";
	} else if (tutorialcounter == 41) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext41;
		document.getElementById('scorekeeper').className = "scorer1";
	} else if (tutorialcounter == 42) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext42;
		document.getElementById('scorekeeper').className = "scorer3";
	} else if (tutorialcounter == 43) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext43;
		startingStonesFadeIn();
		document.getElementById('scorekeeper').className = "scoreb1";
	} else if (tutorialcounter == 44) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext44;
		document.getElementById('a2').src = '/static/images/redstone.png';
		document.getElementById('scorekeeper').className = "scoretied";
	} else if (tutorialcounter == 45) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext45;
		document.getElementById('b2').src = '/static/images/bluestone.png';
		document.getElementById('scorekeeper').className = "scoreb1";
	} else if (tutorialcounter == 46) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext46;
	} else if (tutorialcounter == 47) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext47;
	} else if (tutorialcounter == 48) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext48;
	} else if (tutorialcounter == 49) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext49;
	}
}
