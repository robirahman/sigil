/**
 * SoundManager — synthesizes game sound effects using Web Audio API.
 * No external audio files required.
 */
class SoundManager {
	constructor() {
		this.muted = false;
		try { this.muted = localStorage.getItem('sigil_muted') === 'true'; } catch (e) { /* storage blocked */ }
		// Master volume 0..1, set from the settings panel (settings-panel.js).
		this.volume = typeof SigilSettings !== 'undefined' ? SigilSettings.get('volume') : 1;
		this._ctx = null;
		this._gain = null;
	}

	_ensureCtx() {
		if (!this._ctx) {
			this._ctx = new (window.AudioContext || window.webkitAudioContext)();
		}
		if (this._ctx.state === 'suspended') {
			this._ctx.resume();
		}
		return this._ctx;
	}

	// Every sound ends in this master gain, which carries the volume.
	_out(ctx) {
		if (!this._gain) {
			this._gain = ctx.createGain();
			this._gain.connect(ctx.destination);
		}
		this._gain.gain.value = this.volume;
		return this._gain;
	}

	play(name) {
		if (this.muted || !(this.volume > 0)) return;
		try {
			const fn = this['_snd_' + name];
			if (fn) fn.call(this);
		} catch (e) { /* ignore audio errors */ }
	}

	setMuted(muted) {
		this.muted = muted;
		try { localStorage.setItem('sigil_muted', String(this.muted)); } catch (e) { /* storage blocked */ }
	}

	toggleMute() {
		this.setMuted(!this.muted);
		return this.muted;
	}

	// --- Sound definitions ---

	// Stone placed: short low click/thud
	_snd_stonePlaced() {
		const ctx = this._ensureCtx();
		const t = ctx.currentTime;
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = 'sine';
		osc.frequency.setValueAtTime(220, t);
		osc.frequency.exponentialRampToValueAtTime(80, t + 0.08);
		gain.gain.setValueAtTime(0.3, t);
		gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
		osc.connect(gain).connect(this._out(ctx));
		osc.start(t);
		osc.stop(t + 0.12);
	}

	// Stone crushed: noise burst with decay
	_snd_stoneCrushed() {
		const ctx = this._ensureCtx();
		const t = ctx.currentTime;
		const bufferSize = ctx.sampleRate * 0.25;
		const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
		const data = buffer.getChannelData(0);
		for (let i = 0; i < bufferSize; i++) {
			data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
		}
		const noise = ctx.createBufferSource();
		noise.buffer = buffer;
		const gain = ctx.createGain();
		gain.gain.setValueAtTime(0.25, t);
		gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
		const filter = ctx.createBiquadFilter();
		filter.type = 'lowpass';
		filter.frequency.setValueAtTime(2000, t);
		filter.frequency.exponentialRampToValueAtTime(200, t + 0.2);
		noise.connect(filter).connect(gain).connect(this._out(ctx));
		noise.start(t);
		noise.stop(t + 0.25);
	}

	// Stone pushed: sliding sweep
	_snd_stonePushed() {
		const ctx = this._ensureCtx();
		const t = ctx.currentTime;
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = 'sawtooth';
		osc.frequency.setValueAtTime(300, t);
		osc.frequency.exponentialRampToValueAtTime(100, t + 0.2);
		gain.gain.setValueAtTime(0.12, t);
		gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
		const filter = ctx.createBiquadFilter();
		filter.type = 'lowpass';
		filter.frequency.value = 800;
		osc.connect(filter).connect(gain).connect(this._out(ctx));
		osc.start(t);
		osc.stop(t + 0.25);
	}

	// Spell cast: magical rising whoosh
	_snd_spellCast() {
		const ctx = this._ensureCtx();
		const t = ctx.currentTime;
		// Rising tone
		const osc1 = ctx.createOscillator();
		const gain1 = ctx.createGain();
		osc1.type = 'sine';
		osc1.frequency.setValueAtTime(200, t);
		osc1.frequency.exponentialRampToValueAtTime(800, t + 0.3);
		gain1.gain.setValueAtTime(0.2, t);
		gain1.gain.setValueAtTime(0.2, t + 0.15);
		gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
		osc1.connect(gain1).connect(this._out(ctx));
		osc1.start(t);
		osc1.stop(t + 0.5);
		// Shimmer
		const osc2 = ctx.createOscillator();
		const gain2 = ctx.createGain();
		osc2.type = 'triangle';
		osc2.frequency.setValueAtTime(600, t);
		osc2.frequency.exponentialRampToValueAtTime(1200, t + 0.4);
		gain2.gain.setValueAtTime(0.1, t);
		gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
		osc2.connect(gain2).connect(this._out(ctx));
		osc2.start(t);
		osc2.stop(t + 0.5);
	}

	// Game start: ascending chime (3 notes)
	_snd_gameStart() {
		const ctx = this._ensureCtx();
		const t = ctx.currentTime;
		const notes = [330, 440, 660];
		notes.forEach((freq, i) => {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = 'sine';
			osc.frequency.value = freq;
			const start = t + i * 0.12;
			gain.gain.setValueAtTime(0, start);
			gain.gain.linearRampToValueAtTime(0.2, start + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
			osc.connect(gain).connect(this._out(ctx));
			osc.start(start);
			osc.stop(start + 0.4);
		});
	}

	// Game over: triumphant fanfare (chord + resolve)
	_snd_gameOver() {
		const ctx = this._ensureCtx();
		const t = ctx.currentTime;
		const chord = [262, 330, 392, 523];
		chord.forEach((freq) => {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = 'triangle';
			osc.frequency.value = freq;
			gain.gain.setValueAtTime(0, t);
			gain.gain.linearRampToValueAtTime(0.15, t + 0.05);
			gain.gain.setValueAtTime(0.15, t + 0.4);
			gain.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
			osc.connect(gain).connect(this._out(ctx));
			osc.start(t);
			osc.stop(t + 1.0);
		});
		// Resolve note
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = 'sine';
		osc.frequency.value = 523;
		gain.gain.setValueAtTime(0, t + 0.3);
		gain.gain.linearRampToValueAtTime(0.25, t + 0.35);
		gain.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
		osc.connect(gain).connect(this._out(ctx));
		osc.start(t + 0.3);
		osc.stop(t + 1.2);
	}
}

const soundManager = new SoundManager();
