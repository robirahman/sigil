document.addEventListener('DOMContentLoaded', () => {
	const containerElem = document.querySelector('.help-menu-container');
	if (!containerElem) return;
	const submenuElem = document.querySelector('.help-menu-container .submenu');
	const contentElem = document.querySelector('.help-menu-container .content');
	const glossaryElem = document.querySelector('.help-menu-container .glossary');
	const turnStructureElem = document.querySelector('.help-menu-container .turn-structure');

	const showContent = () => {
		submenuElem.classList.remove('show');
		contentElem.classList.add('show');
		contentElem.addEventListener('transitionend', () => {
			contentElem.classList.add('after-open-transition');
		});
	};

	const glossaryBtn = document.querySelector('.help-menu-container .glossary-btn');
	glossaryBtn.addEventListener('click', () => {
		glossaryElem.classList.add('show');
		showContent();
	});

	const turnStructureBtn = document.querySelector('.help-menu-container .turn-structure-btn');
	turnStructureBtn.addEventListener('click', () => {
		turnStructureElem.classList.add('show');
		showContent();
	});

	const labelElem = document.querySelector('.help-menu-container label');
	const submenuContainerElem = document.querySelector('.help-menu-container .submenu-container');
	const helpMenuCheckbox = document.querySelector('.help-menu-container #help-menu');
	helpMenuCheckbox.addEventListener('change', () => {
		const isOpening = helpMenuCheckbox.checked;
		if (isOpening) {
			submenuElem.classList.add('show');
			contentElem.classList.remove('show');
			glossaryElem.classList.remove('show');
			turnStructureElem.classList.remove('show');
			contentElem.classList.remove('after-open-transition');

			containerElem.classList.add('open');

			//close on click away
			const onAnyClick = (event) => {
				if (!submenuContainerElem.contains(event.target) && !labelElem.contains(event.target)) {
					helpMenuCheckbox.checked = false; //close
					document.removeEventListener('click', onAnyClick);
				}
			};
			document.addEventListener('click', onAnyClick);
		} else {
			containerElem.classList.remove('open');
		}
	});
});
