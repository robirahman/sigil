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
			'--color-header-bg': '#060e18',
			'--color-red-player': '#cc4444',
			'--color-blue-player': '#66bbee',
			'--color-red-glow': '#dd5544',
			'--color-blue-glow': '#44aadd',
			'--color-red-lock': '#cc4444',
			'--color-blue-lock': '#44aadd',
			'--color-last-play-outline': '#aaeeff',
			'--color-text': '#c8dde8',
			'--color-text-light': '#ddeef5',
			'--color-text-warm': '#b8ccd8',
			'--color-text-bright': '#d0e8f5',
			'--color-text-muted': '#7899aa',
			'--color-text-dim': '#6688aa',
			'--color-text-faint': '#557799',
			'--color-surface': '#0e1e30',
			'--color-surface-raised': '#162840',
			'--color-surface-hover': '#1e3858',
			'--color-border': '#2a4a68',
			'--color-border-hover': '#4488aa',
			'--color-accent': '#66bbee',
			'--color-link': '#44aadd',
			'--color-link-hover': '#66ccee',
			'--color-error': '#dd6666',
			'--color-success': '#66cc88',
			'--color-btn-end-turn': '#1a3550',
			'--color-btn-end-turn-hover': '#244868',
			'--color-btn-dash': '#184858',
			'--color-btn-dash-hover': '#226070',
			'--color-btn-reset': '#4a1a1a',
			'--color-btn-reset-hover': '#602828',
			'--color-btn-rematch': '#186838',
			'--color-btn-rematch-hover': '#1e8848',
			'--color-btn-menu': '#1a4466',
			'--color-btn-menu-hover': '#0d3355',
			'--color-btn-menu-dark': '#162838',
			'--color-btn-menu-dark-hover': '#0e1e2c',
			'--color-win-modal-bg': 'rgba(8, 16, 28, 0.92)',
			'--color-spectator-banner': 'rgba(10, 25, 50, 0.95)',
			'--color-review-bar-bg': 'rgba(6, 14, 24, 0.92)',
			'--bg-image': 'url("static/images/themes/tiled-background-frost.jpg")',
			'--bg-image-webp': 'url("static/images/themes/tiled-background-frost.jpg")',
		}
	},
	parchment: {
		name: 'Parchment',
		vars: {
			'--color-bg': '#d8c8a8',
			'--color-bg-dark': '#b8a888',
			'--color-bg-mid': '#c4b494',
			'--color-header-bg': '#a89878',
			'--color-red-player': '#b83a2a',
			'--color-blue-player': '#2a4a8a',
			'--color-red-glow': '#cc4433',
			'--color-blue-glow': '#3358a0',
			'--color-red-lock': '#b83a2a',
			'--color-blue-lock': '#2a4a8a',
			'--color-last-play-outline': '#8b6914',
			'--color-text': '#2a2018',
			'--color-text-light': '#1a1008',
			'--color-text-warm': '#3a2a14',
			'--color-text-bright': '#2a1a08',
			'--color-text-muted': '#7a6a5a',
			'--color-text-dim': '#6a5a4a',
			'--color-text-faint': '#8a7a6a',
			'--color-surface': '#c8b898',
			'--color-surface-raised': '#b8a888',
			'--color-surface-hover': '#a89878',
			'--color-border': '#9a8a6a',
			'--color-border-hover': '#7a6a4a',
			'--color-accent': '#6a4a1a',
			'--color-link': '#5a3a10',
			'--color-link-hover': '#3a2a08',
			'--color-error': '#aa3322',
			'--color-success': '#3a7a2a',
			'--color-btn-end-turn': '#4a6a3a',
			'--color-btn-end-turn-hover': '#5a7a4a',
			'--color-btn-dash': '#5a6040',
			'--color-btn-dash-hover': '#6a7050',
			'--color-btn-reset': '#8a3020',
			'--color-btn-reset-hover': '#a04030',
			'--color-btn-rematch': '#3a7a2a',
			'--color-btn-rematch-hover': '#4a8a3a',
			'--color-btn-menu': '#6a7a5a',
			'--color-btn-menu-hover': '#5a6a4a',
			'--color-btn-menu-dark': '#8a7a5a',
			'--color-btn-menu-dark-hover': '#7a6a4a',
			'--color-win-modal-bg': 'rgba(200, 185, 155, 0.95)',
			'--color-spectator-banner': 'rgba(180, 165, 135, 0.95)',
			'--color-review-bar-bg': 'rgba(180, 160, 130, 0.95)',
			'--bg-image': 'url("static/images/themes/tiled-background-parchment.jpg")',
			'--bg-image-webp': 'url("static/images/themes/tiled-background-parchment.jpg")',
		}
	},
	forest: {
		name: 'Forest',
		vars: {
			'--color-bg': '#0c1a0c',
			'--color-bg-dark': '#060f06',
			'--color-bg-mid': '#0a160a',
			'--color-header-bg': '#060f06',
			'--color-red-player': '#cc5533',
			'--color-blue-player': '#33aa77',
			'--color-red-glow': '#dd6644',
			'--color-blue-glow': '#2c9968',
			'--color-red-lock': '#cc5533',
			'--color-blue-lock': '#2c9968',
			'--color-last-play-outline': '#ccdd44',
			'--color-text': '#c8d8c0',
			'--color-text-light': '#dde8d5',
			'--color-text-warm': '#c0b890',
			'--color-text-bright': '#d0c8a0',
			'--color-text-muted': '#6a8a5a',
			'--color-text-dim': '#5a7a4a',
			'--color-text-faint': '#4a6a3a',
			'--color-surface': '#102810',
			'--color-surface-raised': '#183818',
			'--color-surface-hover': '#204820',
			'--color-border': '#2a5a2a',
			'--color-border-hover': '#4a8a4a',
			'--color-accent': '#88cc44',
			'--color-link': '#66aa33',
			'--color-link-hover': '#88cc44',
			'--color-error': '#dd5533',
			'--color-success': '#66cc44',
			'--color-btn-end-turn': '#2a4a28',
			'--color-btn-end-turn-hover': '#3a5a38',
			'--color-btn-dash': '#3a4828',
			'--color-btn-dash-hover': '#4a5838',
			'--color-btn-reset': '#5a2010',
			'--color-btn-reset-hover': '#6a3020',
			'--color-btn-rematch': '#2a6a18',
			'--color-btn-rematch-hover': '#3a8a28',
			'--color-btn-menu': '#2a5a28',
			'--color-btn-menu-hover': '#1a4a18',
			'--color-btn-menu-dark': '#183818',
			'--color-btn-menu-dark-hover': '#102810',
			'--color-win-modal-bg': 'rgba(10, 22, 10, 0.92)',
			'--color-spectator-banner': 'rgba(10, 30, 10, 0.95)',
			'--color-review-bar-bg': 'rgba(6, 15, 6, 0.92)',
			'--bg-image': 'url("static/images/themes/tiled-background-forest.jpg")',
			'--bg-image-webp': 'url("static/images/themes/tiled-background-forest.jpg")',
		}
	},
	volcanic: {
		name: 'Volcanic',
		vars: {
			'--color-bg': '#1a0a0a',
			'--color-bg-dark': '#100505',
			'--color-bg-mid': '#140808',
			'--color-header-bg': '#100505',
			'--color-red-player': '#ff5533',
			'--color-blue-player': '#ff8844',
			'--color-red-glow': '#ff6644',
			'--color-blue-glow': '#ee7733',
			'--color-red-lock': '#ff5533',
			'--color-blue-lock': '#ee7733',
			'--color-last-play-outline': '#ffcc22',
			'--color-text': '#e8d0c0',
			'--color-text-light': '#f0ddd0',
			'--color-text-warm': '#e0c0a0',
			'--color-text-bright': '#f0d0b0',
			'--color-text-muted': '#8a5a40',
			'--color-text-dim': '#aa6a4a',
			'--color-text-faint': '#7a4a30',
			'--color-surface': '#2a1010',
			'--color-surface-raised': '#3a1818',
			'--color-surface-hover': '#4a2222',
			'--color-border': '#5a2a1a',
			'--color-border-hover': '#8a4a30',
			'--color-accent': '#ff8844',
			'--color-link': '#ee7733',
			'--color-link-hover': '#ff9955',
			'--color-error': '#ff4422',
			'--color-success': '#cc8822',
			'--color-btn-end-turn': '#4a2010',
			'--color-btn-end-turn-hover': '#5a3020',
			'--color-btn-dash': '#4a3010',
			'--color-btn-dash-hover': '#5a4020',
			'--color-btn-reset': '#6a1010',
			'--color-btn-reset-hover': '#881818',
			'--color-btn-rematch': '#6a4a10',
			'--color-btn-rematch-hover': '#8a5a18',
			'--color-btn-menu': '#5a2a10',
			'--color-btn-menu-hover': '#4a1a08',
			'--color-btn-menu-dark': '#3a1818',
			'--color-btn-menu-dark-hover': '#2a1010',
			'--color-win-modal-bg': 'rgba(26, 10, 10, 0.92)',
			'--color-spectator-banner': 'rgba(40, 15, 10, 0.95)',
			'--color-review-bar-bg': 'rgba(16, 5, 5, 0.92)',
			'--bg-image': 'url("static/images/themes/tiled-background-volcanic.jpg")',
			'--bg-image-webp': 'url("static/images/themes/tiled-background-volcanic.jpg")',
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
