
function main() {

  tutorialcounter = 1;


  document.getElementById("nextbutton").addEventListener(
    'click', function() {nextClick(this);}, false);


  document.addEventListener("keydown", keyDownFunction, false);


  tutorialtext2 = "Sigil is a two-player strategy board game<br>designed by Andreas Voellmer and<br>published by Pine Island Games.";
  
  tutorialtext3 = "A physical version of Sigil will<br>be launching soon on Kickstarter.<br>Check the <a href='https://www.pineislandgames.com' target='_blank' rel='noopener noreferrer'>Pine Island Games website</a><br>for details, and join our mailing list for updates.";

  tutorialtext4 = "Overview of sigilbattle.com Features";

  tutorialtext5 = "At sigilbattle.com you can play Sigil online<br>for free. Learn the rules<br>in this tutorial, then try out a<br>single-player game against an AI.";

  tutorialtext6 = "If you want to play against a friend,<br>you can create a private game<br>for them to join.";
  
  tutorialtext7 = "If you want to compete against random<br>opponents, you can play games on the ladder.<br>Wins and losses in ladder games will affect<br>your Sigil rating. The highest rated players<br>are visible on the leaderboard,<br>and in the future they may be invited to<br>exclusive Sigil tournaments<br>with cash prizes.";

  tutorialtext8 = "How to Play";

  tutorialtext9 = "Sigil is a battle between the red stones and blue stones.<br>Each side is trying to expand their territory<br>and disrupt the opponent's expansion.";

  tutorialtext10 = "As your stones expand<br>to different regions of the board,<br>you gain different special<br>abilities; these are called spells.";

  tutorialtext11 = "The nine large dark circles on the<br>board are locations for spells to<br>be placed. There are three small, three medium,<br>and three large spell locations.";

  tutorialtext12 = "Before the game starts,<br>spells are placed at random<br>into these nine locations.";

  tutorialtext13 = "We'll talk more about how spells work<br>in Part 2 of this tutorial.<br>For now, let's fill the board<br>with spells just so we can see what<br>a completed board looks like.";

  tutorialtext14 = "With the spells in place,<br>we're ready to play."

  tutorialtext15 = "Each side starts with just<br>one stone on the board.";

  tutorialtext16 = "The red circle in the bottom<br>left is red's starting location.<br>Blue starts with a stone<br>in the bottom right.";

  tutorialtext17 = "On each player's turn,<br>they place one new<br>stone of their color onto<br>the board.";

  tutorialtext18 = "The new stone must be adjacent<br>to a stone they already have.";

  tutorialtext19 = "The small white circles are called<br>nodes. Stones are placed<br>inside of nodes. There are also three<br>special mana nodes around the edge<br>of the board: the red and blue starting<br>locations, and one more 'neutral' mana<br>at the top of the board.";

  fadeIn();

}


function fadeIn() {

  document.getElementById("board").style.opacity = 1;
  document.getElementById("scorekeeper").style.opacity = 1;

}


function fadeInSpells() {
  document.getElementById("charm1").style.opacity = 1;
  document.getElementById("charm2").style.opacity = 1;
  document.getElementById("charm3").style.opacity = 1;
  document.getElementById("sorcery1").style.opacity = 1;
  document.getElementById("sorcery2").style.opacity = 1;
  document.getElementById("sorcery3").style.opacity = 1;
  document.getElementById("ritual1").style.opacity = 1;
  document.getElementById("ritual2").style.opacity = 1;
  document.getElementById("ritual3").style.opacity = 1;

  document.getElementById("ritualnodes1").style.opacity = .7;
  document.getElementById("ritualnodes2").style.opacity = .7;
  document.getElementById("ritualnodes3").style.opacity = .7;
  document.getElementById("sorcerynodes1").style.opacity = .7;
  document.getElementById("sorcerynodes2").style.opacity = .7;
  document.getElementById("sorcerynodes3").style.opacity = .7;
  document.getElementById("charmnodes1").style.opacity = .7;
  document.getElementById("charmnodes2").style.opacity = .7;
  document.getElementById("charmnodes3").style.opacity = .7;
}




function keyDownFunction(e) {
  var keyCode = e.keyCode;
  if (keyCode == 32) {
    e.preventDefault();
    document.getElementById("nextbutton").click();
  }
}



function nextClick(button) {

  tutorialcounter += 1;

  if (tutorialcounter == 2) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext2;
  } else if (tutorialcounter == 3) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext3;
  } else if (tutorialcounter == 4) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext4;
  } else if (tutorialcounter == 5) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext5;
  } else if (tutorialcounter == 6) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext6;
  } else if (tutorialcounter == 7) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext7;
  } else if (tutorialcounter == 8) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext8;
  } else if (tutorialcounter == 9) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext9;
  } else if (tutorialcounter == 10) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext10;
  } else if (tutorialcounter == 11) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext11;
  } else if (tutorialcounter == 12) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext12;
  } else if (tutorialcounter == 13) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext13;
    fadeInSpells();
  } else if (tutorialcounter == 14) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext14;
  } else if (tutorialcounter == 15) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext15;
  } else if (tutorialcounter == 16) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext16;
  } else if (tutorialcounter == 17) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext17;
  } else if (tutorialcounter == 18) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext18;
  } else if (tutorialcounter == 19) {
    document.getElementById("tutorialtext").innerHTML = tutorialtext19;
  }
}











