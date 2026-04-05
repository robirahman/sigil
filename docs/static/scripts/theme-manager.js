/**
 * ThemeManager — manages visual themes via CSS custom properties.
 * Loaded early in <head> so theme applies before first paint.
 */
const THEMES = {
	default: {
		name: 'Arcane',
		vars: {}
	},
	frost: {
		name: 'Frost',
		vars: {
			'--color-bg': '#0a1520',
			'--color-bg-dark': '#060e18',
			'--color-bg-mid': '#0c1928',
			'--color-red-player': '#cc4444',
			'--color-blue-player': '#66bbee',
			'--color-red-glow': '#dd5544',
			'--color-blue-glow': '#44aadd',
			'--color-last-play-outline': '#aaeeff',
			'--color-text': '#c8dde8',
			'--color-text-light': '#ddeef5',
			'--color-text-warm': '#b8ccd8',
			'--color-btn-end-turn': '#1a3550',
			'--color-btn-end-turn-hover': '#244868',
			'--color-btn-dash': '#184858',
			'--color-btn-dash-hover': '#226070',
			'--color-btn-reset': '#4a1a1a',
			'--color-btn-reset-hover': '#602828',
			'--color-win-modal-bg': 'rgba(8, 16, 28, 0.92)',
			'--color-header-bg': '#060e18',
		}
	},
	parchment: {
		name: 'Parchment',
		vars: {
			'--color-bg': '#d8c8a8',
			'--color-bg-dark': '#c4b494',
			'--color-bg-mid': '#ccbc9c',
			'--color-red-player': '#b83a2a',
			'--color-blue-player': '#2a4a8a',
			'--color-red-glow': '#cc4433',
			'--color-blue-glow': '#3358a0',
			'--color-last-play-outline': '#8b6914',
			'--color-text': '#2a2018',
			'--color-text-light': '#1a1008',
			'--color-text-warm': '#3a2a14',
			'--color-btn-end-turn': '#4a6a3a',
			'--color-btn-end-turn-hover': '#5a7a4a',
			'--color-btn-dash': '#5a6040',
			'--color-btn-dash-hover': '#6a7050',
			'--color-btn-reset': '#8a3020',
			'--color-btn-reset-hover': '#a04030',
			'--color-win-modal-bg': 'rgba(200, 185, 155, 0.95)',
			'--color-header-bg': '#a89878',
		}
	},
	forest: {
		name: 'Forest',
		vars: {
			'--color-bg': '#0c1a0c',
			'--color-bg-dark': '#060f06',
			'--color-bg-mid': '#0a160a',
			'--color-red-player': '#cc5533',
			'--color-blue-player': '#33aa77',
			'--color-red-glow': '#dd6644',
			'--color-blue-glow': '#2c9968',
			'--color-last-play-outline': '#ccdd44',
			'--color-text': '#c8d8c0',
			'--color-text-light': '#dde8d5',
			'--color-text-warm': '#c0b890',
			'--color-btn-end-turn': '#2a4a28',
			'--color-btn-end-turn-hover': '#3a5a38',
			'--color-btn-dash': '#3a4828',
			'--color-btn-dash-hover': '#4a5838',
			'--color-btn-reset': '#5a2010',
			'--color-btn-reset-hover': '#6a3020',
			'--color-win-modal-bg': 'rgba(10, 22, 10, 0.92)',
			'--color-header-bg': '#060f06',
		}
	},
	volcanic: {
		name: 'Volcanic',
		vars: {
			'--color-bg': '#1a0a0a',
			'--color-bg-dark': '#100505',
			'--color-bg-mid': '#140808',
			'--color-red-player': '#ff5533',
			'--color-blue-player': '#ff8844',
			'--color-red-glow': '#ff6644',
			'--color-blue-glow': '#ee7733',
			'--color-last-play-outline': '#ffcc22',
			'--color-text': '#e8d0c0',
			'--color-text-light': '#f0ddd0',
			'--color-text-warm': '#e0c0a0',
			'--color-btn-end-turn': '#4a2010',
			'--color-btn-end-turn-hover': '#5a3020',
			'--color-btn-dash': '#4a3010',
			'--color-btn-dash-hover': '#5a4020',
			'--color-btn-reset': '#6a1010',
			'--color-btn-reset-hover': '#881818',
			'--color-win-modal-bg': 'rgba(26, 10, 10, 0.92)',
			'--color-header-bg': '#100505',
		}
	}
};

class ThemeManager {
	constructor() {
		this.current = localStorage.getItem('sigil_theme') || 'default';
		this.apply(this.current);
	}

	apply(themeId) {
		const theme = THEMES[themeId];
		if (!theme) return;
		const root = document.documentElement;

		// Clear all theme vars first
		for (const t of Object.values(THEMES)) {
			for (const k of Object.keys(t.vars || {})) {
				root.style.removeProperty(k);
			}
		}

		// Set data-theme attribute for image/filter selectors
		root.setAttribute('data-theme', themeId);

		// Apply new vars
		for (const [k, v] of Object.entries(theme.vars || {})) {
			root.style.setProperty(k, v);
		}

		this.current = themeId;
		localStorage.setItem('sigil_theme', themeId);
	}

	getThemeList() {
		return Object.entries(THEMES).map(([id, t]) => ({ id, name: t.name }));
	}
}

const themeManager = new ThemeManager();
