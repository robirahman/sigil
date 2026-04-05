/**
 * ThemeManager — manages visual themes via CSS custom properties.
 * Loaded early in <head> so theme applies before first paint.
 */
const THEMES = {
	default: {
		name: 'Dark Arcane',
		vars: {}
	},
	frost: {
		name: 'Frost / Ice',
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
			'--color-link': '#66aadd',
			'--color-btn-primary': '#1a4466',
			'--color-btn-primary-hover': '#0d3355',
			'--color-btn-dark': '#162838',
			'--color-btn-dark-hover': '#0e1e2c',
			'--color-btn-end-turn': '#1a3550',
			'--color-btn-end-turn-hover': '#244868',
			'--color-btn-dash': '#184858',
			'--color-btn-dash-hover': '#226070',
			'--color-btn-reset': '#4a1a1a',
			'--color-btn-reset-hover': '#602828',
			'--color-win-modal-bg': 'rgba(8, 16, 28, 0.92)',
			'--color-header-bg': '#060e18',
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
