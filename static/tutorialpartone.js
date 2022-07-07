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

	tutorialtext7 = "Now we're ready to begin.";

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

	tutorialtext18 = "The three largest spells are called Rituals.<br>Rituals have five nodes inside them.";

	tutorialtext19 = "The three medium-sized spells<br>are called Sorceries.<br>Sorceries have three nodes inside them.";

	tutorialtext20 = "The three small spells,<br>with just a single node,<br>are called Charms.";

	tutorialtext21 = "Let's look at Searing Wind as an<br>example. This is a Sorcery<br>with the effect 'Destroy all enemy<br>stones which are touching you.'";

	tutorialtext22 = "If you fill Searing Wind<br>with your stones, then cast it,<br>you will first sacrifice the<br>three stones from Searing Wind.";

	tutorialtext23 = "Then all enemy stones<br>anywhere on the board<br>which are touching your<br>stones will be destroyed.";

	tutorialtext24 = "Your three stones on Searing Wind<br>are sacrificed BEFORE the effect<br>resolves; so they will not burn away<br>enemy stones that were touching them.";

	tutorialtext25 = "Ideally, you'd like to destroy<br>at least three enemy stones<br>when you cast Searing Wind,<br>to make up for the three<br>you sacrificed.";

	tutorialtext26 = "If you'd rather save<br>a spell for later, you don't<br>have to cast it immediately.";

	tutorialtext27 = "In this position, if blue casts<br>Searing Wind, it will only destroy a<br>single red stone (because the three<br>stones on Searing Wind will be gone<br>when the effect resolves). So blue<br>might want to save their<br>Searing Wind for later.";

	tutorialtext28 = "There are also three<br>special <b>mana</b> nodes around<br>the edge of the board.";
	
	tutorialtext29 = "One of the mana nodes is red's<br>starting location.";

	tutorialtext30 = "Another one is blue's<br>starting location.";

	tutorialtext31 = "The third mana node at the<br>top of the board is neutral--<br>neither player starts with a<br>stone there.";

	tutorialtext32 = "Mana nodes are some of the<br>most important positions on the<br>board. You want to control<br>as many mana nodes as possible.";

	tutorialtext33 = "This is because mana makes<br>your Sorcery and Ritual spells<br>more efficient.";

	tutorialtext34 = "When you cast a Ritual or<br>Sorcery spell, you sacrifice<br>one fewer stone for<br>each mana you control.";

	tutorialtext35 = "For example, if you control<br>one mana, and have filled<br>Searing Wind with your stones,<br>then you only need to sacrifice<br>two of them to cast it.";

	tutorialtext36 = "With two mana, you would<br>only have to sacrifice one<br>stone to cast it.";

	tutorialtext37 = "With all three mana,<br>you wouldn't have to sacrifice<br>any stones at all.";

	tutorialtext38 = "The spell must always<br>be filled with your stones<br>before you can cast it.<br>Controlling mana just means<br>you will get to keep some stones<br>in the spell afterwards.";

	tutorialtext39 = "Mana does not affect your<br>Charms at all; you always<br>have to sacrifice the one<br>stone in a Charm to cast it.";

	tutorialtext40 = "Although each player starts with<br>one mana, there is no guarantee<br>that they will keep it forever.";

	tutorialtext41 = "In Sigil, players can steal territory<br>from each other by moving into<br>enemy-occupied nodes.";

	tutorialtext42 = "So your opponent might try to<br>steal your starting mana, and<br>make you fight to defend it.";

	tutorialtext43 = "Or you might spot an opportunity<br>to attack your opponent's starting<br>mana and take it from them.";

	tutorialtext44 = "You win the game if you have<br>three more stones than your opponent<br>at the end of your turn.";

	tutorialtext45 = "But if players just take turns<br>placing one new stone at a<br>time, nobody will ever get<br>a three-stone advantage.";

	tutorialtext46 = "Casting spells like Searing<br>Wind is one way to get a stone<br>advantage, if you destroy<br>more enemy stones than<br>you had to sacrifice.";

	tutorialtext47 = "The more mana you control,<br>the more likely that<br>your spells will give<br>you a stone advantage.";

	tutorialtext48 = "In Part 3, we'll see that surrounding<br>a group of enemy stones is<br> another way to get a stone advantage.";

	tutorialtext49 = "To keep track of which color has<br>a stone advantage, we use the<br>scorekeeping area in the middle<br>of the Sigil board.";

	tutorialtext50 = "A single blue stone is used<br>to track the current score.";

	tutorialtext51 = "If both colors have the same<br>number of stones on the board,<br>the scorekeeper goes in the middle.";

	tutorialtext52 = "If one color has more stones,<br>the scorekeeper moves to mark<br>how big of an advantage they have.";

	tutorialtext53 = "When the scorekeeper marks<br>a three-stone advantage for one<br>color, that player wins.";

	tutorialtext54 = "The scorekeeper stone itself<br>counts as a blue stone. So at<br>the start of the game, blue has<br>a one-stone advantage.";

	tutorialtext55 = "But red gets to move first,<br>and after they place a stone<br>on their first turn, the score<br>will be tied at two stones each.";

	tutorialtext56 = "Then blue will move and get<br>a one-stone advantage again.";

	tutorialtext57 = "At the end of each player's turn,<br>that player moves the scorekeeper stone<br>to mark the current stone advantage.";

	tutorialtext58 = "In the physical Sigil board game,<br>this is also how you show that<br>you're finished with your turn.";

	tutorialtext59 = "In Sigil Online, you can just press<br>the 'End Turn' button (or Space) and<br>the scorekeeper stone will update<br>automatically.";

	tutorialtext60 = "This concludes Part 1 of the<br>tutorial. See you in Part 2!";


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

function arrowBlueManaFadeOut() {
	document.getElementById('arrowbluemana').style.visibility = "hidden";
	document.getElementById('arrowbluemana').style.opacity = 0;
	document.getElementById('arrowbluemana').style.left = '915px';
}

function arrowRedManaFadeIn() {
	document.getElementById('arrowredmana').style.visibility = "visible";
	document.getElementById('arrowredmana').style.opacity = 1;
	document.getElementById('arrowredmana').style.left = '-78px';
}

function arrowRedManaFadeOut() {
	document.getElementById('arrowredmana').style.visibility = "hidden";
	document.getElementById('arrowredmana').style.opacity = 0;
	document.getElementById('arrowredmana').style.left = '-178px';
}

function arrowNeutralManaFadeIn() {
	document.getElementById('arrowneutralmana').style.visibility = "visible";
	document.getElementById('arrowneutralmana').style.opacity = 1;
	document.getElementById('arrowneutralmana').style.left = '640px';
}

function arrowNeutralManaFadeOut() {
	document.getElementById('arrowneutralmana').style.visibility = "hidden";
	document.getElementById('arrowneutralmana').style.opacity = 0;
	document.getElementById('arrowneutralmana').style.left = '740px';
}



function arrowScorekeeperFadeIn() {
	document.getElementById('arrowscorekeeper').style.opacity = 1;
	document.getElementById('arrowscorekeeper').style.left = '300px';
}



function arrowRitual1FadeIn() {
	document.getElementById('arrowritual1').style.visibility = "visible";
	document.getElementById('arrowritual1').style.opacity = 1;
	document.getElementById('arrowritual1').style.left = '-5px';
}

function arrowSorcery1FadeIn() {
	document.getElementById('arrowsorcery1').style.visibility = "visible";
	document.getElementById('arrowsorcery1').style.opacity = 1;
	document.getElementById('arrowsorcery1').style.left = '285px';
}

function arrowCharm1FadeIn() {
	document.getElementById('arrowcharm1').style.visibility = "visible";
	document.getElementById('arrowcharm1').style.opacity = 1;
	document.getElementById('arrowcharm1').style.left = '270px';
}

function arrowRitual2FadeIn() {
	document.getElementById('arrowritual2').style.visibility = "visible";
	document.getElementById('arrowritual2').style.opacity = 1;
	document.getElementById('arrowritual2').style.left = '865px';
}

function arrowSorcery2FadeIn() {
	document.getElementById('arrowsorcery2').style.visibility = "visible";
	document.getElementById('arrowsorcery2').style.opacity = 1;
	document.getElementById('arrowsorcery2').style.left = '845px';
}

function arrowCharm2FadeIn() {
	document.getElementById('arrowcharm2').style.visibility = "visible";
	document.getElementById('arrowcharm2').style.opacity = 1;
	document.getElementById('arrowcharm2').style.left = '700px';
}

function arrowRitual3FadeIn() {
	document.getElementById('arrowritual3').style.visibility = "visible";
	document.getElementById('arrowritual3').style.opacity = 1;
	document.getElementById('arrowritual3').style.left = '260px';
}

function arrowSorcery3FadeIn() {
	document.getElementById('arrowsorcery3').style.visibility = "visible";
	document.getElementById('arrowsorcery3').style.opacity = 1;
	document.getElementById('arrowsorcery3').style.left = '5px';
}

function arrowCharm3FadeIn() {
	document.getElementById('arrowcharm3').style.visibility = "visible";
	document.getElementById('arrowcharm3').style.opacity = 1;
	document.getElementById('arrowcharm3').style.left = '195px';
}

function arrowRitual1FadeOut() {
	document.getElementById('arrowritual1').style.visibility = "hidden";
	document.getElementById('arrowritual1').style.opacity = 0;
	document.getElementById('arrowritual1').style.left = '-105px';
}

function arrowSorcery1FadeOut() {
	document.getElementById('arrowsorcery1').style.visibility = "hidden";
	document.getElementById('arrowsorcery1').style.opacity = 0;
	document.getElementById('arrowsorcery1').style.left = '185px';
}

function arrowCharm1FadeOut() {
	document.getElementById('arrowcharm1').style.visibility = "hidden";
	document.getElementById('arrowcharm1').style.opacity = 0;
	document.getElementById('arrowcharm1').style.left = '170px';
}

function arrowRitual2FadeOut() {
	document.getElementById('arrowritual2').style.visibility = "hidden";
	document.getElementById('arrowritual2').style.opacity = 0;
	document.getElementById('arrowritual2').style.left = '965px';
}

function arrowSorcery2FadeOut() {
	document.getElementById('arrowsorcery2').style.visibility = "hidden";
	document.getElementById('arrowsorcery2').style.opacity = 0;
	document.getElementById('arrowsorcery2').style.left = '945px';
}

function arrowCharm2FadeOut() {
	document.getElementById('arrowcharm2').style.visibility = "hidden";
	document.getElementById('arrowcharm2').style.opacity = 0;
	document.getElementById('arrowcharm2').style.left = '800px';
}

function arrowRitual3FadeOut() {
	document.getElementById('arrowritual3').style.visibility = "hidden";
	document.getElementById('arrowritual3').style.opacity = 0;
	document.getElementById('arrowritual3').style.left = '160px';
}

function arrowSorcery3FadeOut() {
	document.getElementById('arrowsorcery3').style.visibility = "hidden";
	document.getElementById('arrowsorcery3').style.opacity = 0;
	document.getElementById('arrowsorcery3').style.left = '-95px';
}

function arrowCharm3FadeOut() {
	document.getElementById('arrowcharm3').style.visibility = "hidden";
	document.getElementById('arrowcharm3').style.opacity = 0;
	document.getElementById('arrowcharm3').style.left = '95px';
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

function sampleBoardOne() {
	bluenodelist = ['b4', 'b7', 'b8', 'b9', 'b10'];
	rednodelist = ['c2', 'c5', 'c6', 'c11', 'c12'];

	for (var node of bluenodelist) {
		document.getElementById(node).src = '/static/images/bluestone.png';
	}
	for (var node of rednodelist) {
		document.getElementById(node).src = '/static/images/redstone.png';
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
		arrowRitual1FadeOut();
		arrowRitual2FadeOut();
		arrowRitual3FadeOut();
		arrowSorcery1FadeOut();
		arrowSorcery2FadeOut();
		arrowSorcery3FadeOut();
		arrowCharm1FadeOut();
		arrowCharm2FadeOut();
		arrowCharm3FadeOut();
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
		arrowRitual1FadeIn();
		arrowRitual2FadeIn();
		arrowRitual3FadeIn();
	} else if (tutorialcounter == 19) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext19;
		arrowRitual1FadeOut();
		arrowRitual2FadeOut();
		arrowRitual3FadeOut();
		arrowSorcery1FadeIn();
		arrowSorcery2FadeIn();
		arrowSorcery3FadeIn();
	} else if (tutorialcounter == 20) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext20;
		arrowSorcery1FadeOut();
		arrowSorcery2FadeOut();
		arrowSorcery3FadeOut();
		arrowCharm1FadeIn();
		arrowCharm2FadeIn();
		arrowCharm3FadeIn();
	} else if (tutorialcounter == 21) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext21;
		arrowSorcery2FadeIn();
		arrowCharm1FadeOut();
		arrowCharm2FadeOut();
		arrowCharm3FadeOut();
	} else if (tutorialcounter == 22) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext22;
		arrowSorcery2FadeOut();
		sampleBoardOne();
	} else if (tutorialcounter == 23) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext23;
	} else if (tutorialcounter == 24) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext24;
	} else if (tutorialcounter == 25) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext25;
	} else if (tutorialcounter == 26) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext26;
	} else if (tutorialcounter == 27) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext27;
	} else if (tutorialcounter == 28) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext28;
		clearBoard();
	} else if (tutorialcounter == 29) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext29;
		arrowRedManaFadeIn();
	} else if (tutorialcounter == 30) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext30;
		arrowBlueManaFadeIn();
		arrowRedManaFadeOut();
	} else if (tutorialcounter == 31) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext31;
		arrowBlueManaFadeOut();
		arrowNeutralManaFadeIn();
	} else if (tutorialcounter == 32) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext32;
		arrowNeutralManaFadeOut();
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
	} else if (tutorialcounter == 46) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext46;
	} else if (tutorialcounter == 47) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext47;
	} else if (tutorialcounter == 48) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext48;
	} else if (tutorialcounter == 49) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext49;
		arrowScorekeeperFadeIn();
	} else if (tutorialcounter == 50) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext50;
		document.getElementById('arrowscorekeeper').style.visibility = "hidden";
		document.getElementById('scorekeeper').style.opacity = 1;
	} else if (tutorialcounter == 51) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext51;
		document.getElementById('scorekeeper').className = "scoretied";
	} else if (tutorialcounter == 52) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext52;
		document.getElementById('scorekeeper').className = "scorer1";
	} else if (tutorialcounter == 53) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext53;
		document.getElementById('scorekeeper').className = "scorer3";
	} else if (tutorialcounter == 54) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext54;
		startingStonesFadeIn();
		document.getElementById('scorekeeper').className = "scoreb1";
	} else if (tutorialcounter == 55) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext55;
		document.getElementById('a2').src = '/static/images/redstone.png';
		document.getElementById('scorekeeper').className = "scoretied";
	} else if (tutorialcounter == 56) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext56;
		document.getElementById('b2').src = '/static/images/bluestone.png';
		document.getElementById('scorekeeper').className = "scoreb1";
	} else if (tutorialcounter == 57) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext57;
	} else if (tutorialcounter == 58) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext58;
	} else if (tutorialcounter == 59) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext59;
	} else if (tutorialcounter == 60) {
		document.getElementById('tutorialtext').innerHTML = tutorialtext60;
	}
}
