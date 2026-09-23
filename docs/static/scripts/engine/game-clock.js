/**
 * GameClock -- a chess-style game clock: base time for the whole game plus an
 * increment credited after every move ("5+0", "10+1", "15+10").
 *
 * One class for every mode. Times are milliseconds and `now` is always passed
 * in, so the same object runs on `Date.now()` in the local game and could run
 * on Firebase server time online. The side to move is charged wall time from
 * `start` to `stop`; `stop` credits the increment; `flagged` names the side
 * whose clock has run out. Sigil clock games are lost on the flag, for a human
 * and for the AI alike (the AI's allocator, `RustAI.moveBudgetMs`, keeps a
 * reserve precisely so that it does not happen to it).
 */
class GameClock {
	/**
	 * @param {{baseMs:number, incMs:number}} control
	 * @param {{red:number, blue:number}|null} [remaining] - resume state
	 */
	constructor(control, remaining) {
		this.baseMs = Math.max(0, Math.floor(control.baseMs || 0));
		this.incMs = Math.max(0, Math.floor(control.incMs || 0));
		this.remaining = {
			red: (remaining && typeof remaining.red === 'number') ? remaining.red : this.baseMs,
			blue: (remaining && typeof remaining.blue === 'number') ? remaining.blue : this.baseMs,
		};
		this.active = null;
		this.startedAt = 0;
	}

	/** Start charging `color`. Idempotent for the side already running (a
	 * reset within the same turn must not restart the clock). */
	start(color, now) {
		if (this.active === color) return;
		if (this.active) this.stop(now, true);
		this.active = color;
		this.startedAt = now;
	}

	/** End the active side's turn: charge its wall time and credit the increment. */
	stop(now, credit) {
		if (!this.active) return;
		const c = this.active;
		const used = Math.max(0, now - this.startedAt);
		this.remaining[c] = Math.max(0, this.remaining[c] - used) + (credit === false ? 0 : this.incMs);
		this.active = null;
	}

	/** Remaining ms for `color` at `now`, live for the running side. */
	remainingOf(color, now) {
		const r = this.remaining[color];
		return this.active === color ? Math.max(0, r - Math.max(0, now - this.startedAt)) : r;
	}

	/** The running side if its clock has hit zero, else null. */
	flagged(now) {
		if (!this.active) return null;
		return (this.remaining[this.active] - Math.max(0, now - this.startedAt)) <= 0 ? this.active : null;
	}

	snapshot(now) {
		return {
			baseMs: this.baseMs, incMs: this.incMs,
			red: this.remainingOf('red', now), blue: this.remainingOf('blue', now),
			active: this.active,
		};
	}

	/** "5+0" / "10+1" / "2.5+3" (minutes + seconds per move) -> {baseMs, incMs}, or null. */
	static parse(text) {
		if (!text) return null;
		const m = /^\s*(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)\s*$/.exec(String(text));
		if (!m) return null;
		const baseMs = Math.round(parseFloat(m[1]) * 60000);
		const incMs = Math.round(parseFloat(m[2]) * 1000);
		if (!(baseMs > 0) || !(incMs >= 0)) return null;
		return { baseMs, incMs };
	}

	/** {baseMs, incMs} -> "5+0". */
	static label(control) {
		if (!control) return '';
		const min = control.baseMs / 60000;
		const inc = control.incMs / 1000;
		const f = (x) => (Math.abs(x - Math.round(x)) < 1e-9 ? String(Math.round(x)) : String(x));
		return f(min) + '+' + f(inc);
	}

	/** The multiplayer room's `timeControl` shape for this clock. */
	static toTimeControl(control) {
		return control ? { type: 'realtime', initialTime: control.baseMs, increment: control.incMs } : { type: 'none' };
	}

	/** Inverse of toTimeControl; null for no clock or correspondence. */
	static fromTimeControl(tc) {
		if (!tc || tc.type !== 'realtime' || !(tc.initialTime > 0)) return null;
		return { baseMs: tc.initialTime | 0, incMs: (tc.increment | 0) };
	}

	/** M:SS, rounded up so a clock reads 0:00 only when it has actually run out. */
	static formatMs(ms) {
		const totalSec = Math.max(0, Math.ceil((ms || 0) / 1000));
		const min = Math.floor(totalSec / 60);
		const sec = totalSec % 60;
		return min + ':' + String(sec).padStart(2, '0');
	}
}

if (typeof window !== 'undefined') window.GameClock = GameClock;
