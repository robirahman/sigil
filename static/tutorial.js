// JavaScript for tutorial page


function main() {

	document.getElementById("partone").onmouseover = function() {document.getElementById("partonetext").style.display="inline";};
	document.getElementById("parttwo").onmouseover = function() {document.getElementById("parttwotext").style.display="inline";};
	document.getElementById("partthree").onmouseover = function() {document.getElementById("partthreetext").style.display="inline";};
	document.getElementById("basicspells").onmouseover = function() {document.getElementById("basicspellstext").style.display="inline";};
	document.getElementById("advancedspells").onmouseover = function() {document.getElementById("advancedspellstext").style.display="inline";};

	document.getElementById("partone").onmouseout = function() {document.getElementById("partonetext").style.display="none";};
	document.getElementById("parttwo").onmouseout = function() {document.getElementById("parttwotext").style.display="none";};
	document.getElementById("partthree").onmouseout = function() {document.getElementById("partthreetext").style.display="none";};
	document.getElementById("basicspells").onmouseout = function() {document.getElementById("basicspellstext").style.display="none";};
	document.getElementById("advancedspells").onmouseout = function() {document.getElementById("advancedspellstext").style.display="none";};

	document.getElementById("partone").addEventListener('click', function() {document.getElementById("partonetext").style.display="none";});
	document.getElementById("parttwo").addEventListener('click', function() {document.getElementById("parttwotext").style.display="none";});
	document.getElementById("partthree").addEventListener('click', function() {document.getElementById("partthreetext").style.display="none";});
	document.getElementById("basicspells").addEventListener('click', function() {document.getElementById("basicspellstext").style.display="none";});
	document.getElementById("advancedspells").addEventListener('click', function() {document.getElementById("advancedspellstext").style.display="none";});


}