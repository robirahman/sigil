// JavaScript for home page


function main() {

	document.getElementById("tutorialbutton").onmouseover = function() {document.getElementById("tutorialtext").style.display="inline";};
	document.getElementById("singleplayerbutton").onmouseover = function() {document.getElementById("singleplayertext").style.display="inline";};
	document.getElementById("privatematchbutton").onmouseover = function() {document.getElementById("privatematchtext").style.display="inline";};
	document.getElementById("laddermatchbutton").onmouseover = function() {document.getElementById("laddermatchtext").style.display="inline";};

	document.getElementById("tutorialbutton").onmouseout = function() {document.getElementById("tutorialtext").style.display="none";};
	document.getElementById("singleplayerbutton").onmouseout = function() {document.getElementById("singleplayertext").style.display="none";};
	document.getElementById("privatematchbutton").onmouseout = function() {document.getElementById("privatematchtext").style.display="none";};
	document.getElementById("laddermatchbutton").onmouseout = function() {document.getElementById("laddermatchtext").style.display="none";};

	document.getElementById("tutorialbutton").addEventListener('click', function() {document.getElementById("tutorialtext").style.display="none";});
	document.getElementById("singleplayerbutton").addEventListener('click', function() {document.getElementById("singleplayertext").style.display="none";});
	document.getElementById("privatematchbutton").addEventListener('click', function() {document.getElementById("privatematchtext").style.display="none";});
	document.getElementById("laddermatchbutton").addEventListener('click', function() {document.getElementById("laddermatchtext").style.display="none";});
}