/**
 * AuthManager — wraps Firebase Authentication for Sigil Online.
 *
 * Supports email/password, Google sign-in, and anonymous auth.
 * Manages user profiles in Firebase RTDB at /users/{uid}.
 */
class AuthManager {
	constructor() {
		this.auth = firebase.auth();
		this.currentUser = null;
		this.userProfile = null; // cached RTDB profile
		this._onAuthChangedCallbacks = [];

		this.auth.onAuthStateChanged((user) => {
			this.currentUser = user;
			for (const cb of this._onAuthChangedCallbacks) {
				cb(user);
			}
		});
	}

	/** Register a callback for auth state changes. */
	onAuthChanged(callback) {
		this._onAuthChangedCallbacks.push(callback);
		// Fire immediately with current state
		if (this.currentUser !== undefined) {
			callback(this.currentUser);
		}
	}

	/**
	 * Sign up with email, password, and display name.
	 * Creates the Firebase Auth account and RTDB profile.
	 */
	async signUpWithEmail(email, password, displayName) {
		const cred = await this.auth.createUserWithEmailAndPassword(email, password);
		await cred.user.updateProfile({ displayName });
		await this.ensureUserProfile(firebase.database(), displayName);
		return cred.user;
	}

	/** Sign in with email and password. */
	async signInWithEmail(email, password) {
		const cred = await this.auth.signInWithEmailAndPassword(email, password);
		await this.ensureUserProfile(firebase.database());
		return cred.user;
	}

	/** Sign in with Google popup. */
	async signInWithGoogle() {
		const provider = new firebase.auth.GoogleAuthProvider();
		const cred = await this.auth.signInWithPopup(provider);
		await this.ensureUserProfile(firebase.database());
		return cred.user;
	}

	/** Sign in anonymously (for unranked play without account). */
	async signInAnonymously() {
		const cred = await this.auth.signInAnonymously();
		return cred.user;
	}

	/** Sign out. */
	async signOut() {
		this.userProfile = null;
		await this.auth.signOut();
	}

	/** Update the user's annotationMode preference. */
	async updateAnnotationMode(enabled) {
		if (!this.currentUser) throw new Error('Not signed in');
		const db = firebase.database();
		await db.ref('users/' + this.currentUser.uid + '/annotationMode').set(!!enabled);
		if (this.userProfile) {
			this.userProfile.annotationMode = !!enabled;
		}
	}

	get annotationMode() {
		return !!(this.userProfile && this.userProfile.annotationMode);
	}

	/** Update the user's showAiThinkReport preference. */
	async updateShowAiThinkReport(enabled) {
		if (!this.currentUser) throw new Error('Not signed in');
		const db = firebase.database();
		await db.ref('users/' + this.currentUser.uid + '/showAiThinkReport').set(!!enabled);
		if (this.userProfile) {
			this.userProfile.showAiThinkReport = !!enabled;
		}
	}

	get showAiThinkReport() {
		return !!(this.userProfile && this.userProfile.showAiThinkReport);
	}

	/** Update the user's enablePondering preference. */
	async updateEnablePondering(enabled) {
		if (!this.currentUser) throw new Error('Not signed in');
		const db = firebase.database();
		await db.ref('users/' + this.currentUser.uid + '/enablePondering').set(!!enabled);
		if (this.userProfile) {
			this.userProfile.enablePondering = !!enabled;
		}
	}

	get enablePondering() {
		// Default ON: undefined or true → enabled; only explicit false disables.
		return !(this.userProfile && this.userProfile.enablePondering === false);
	}

	/**
	 * Check whether a display name is available (not claimed by another user).
	 * Returns true if unclaimed OR currently owned by the signed-in user.
	 * Returns false if the name is claimed by someone else, or if the format
	 * is invalid for the `usernames/` index key.
	 */
	async checkUsernameAvailable(name) {
		const trimmed = (name || '').trim();
		if (!AuthManager.isValidDisplayName(trimmed)) return false;
		const key = trimmed.toLowerCase();
		const snap = await firebase.database().ref('usernames/' + key).once('value');
		if (!snap.exists()) return true;
		return this.currentUser ? snap.val() === this.currentUser.uid : false;
	}

	static isValidDisplayName(name) {
		return typeof name === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(name);
	}

	/**
	 * Update the user's display name (Auth profile + RTDB) atomically.
	 *
	 * Uses the `usernames/{lowercaseName}` index for cross-user uniqueness:
	 * the new key is claimed and the old key (if owned by this user) is
	 * released in a single multi-path update. The leaderboard's
	 * denormalized copy is updated too when present.
	 */
	async updateDisplayName(newName) {
		if (!this.currentUser) throw new Error('Not signed in');
		const trimmed = (newName || '').trim();
		if (!AuthManager.isValidDisplayName(trimmed)) {
			throw new Error('Display name must be 1-20 characters: letters, digits, underscores, or hyphens.');
		}
		const uid = this.currentUser.uid;
		const newKey = trimmed.toLowerCase();
		const db = firebase.database();

		const newOwnerSnap = await db.ref('usernames/' + newKey).once('value');
		if (newOwnerSnap.exists() && newOwnerSnap.val() !== uid) {
			throw new Error('That name is already taken.');
		}

		const oldName = (this.userProfile && this.userProfile.displayName)
			|| (this.currentUser && this.currentUser.displayName)
			|| '';
		const oldKey = AuthManager.isValidDisplayName(oldName) ? oldName.toLowerCase() : null;

		const updates = {};
		updates['usernames/' + newKey] = uid;
		if (oldKey && oldKey !== newKey) {
			const oldOwnerSnap = await db.ref('usernames/' + oldKey).once('value');
			if (oldOwnerSnap.exists() && oldOwnerSnap.val() === uid) {
				updates['usernames/' + oldKey] = null;
			}
		}
		updates['users/' + uid + '/displayName'] = trimmed;
		const leaderSnap = await db.ref('leaderboard/' + uid).once('value');
		if (leaderSnap.exists()) {
			updates['leaderboard/' + uid + '/displayName'] = trimmed;
		}

		await db.ref().update(updates);
		await this.currentUser.updateProfile({ displayName: trimmed });
		if (this.userProfile) {
			this.userProfile.displayName = trimmed;
		}
	}

	/**
	 * True when the stored display name is the literal placeholder 'Player'
	 * — the symptom of the username-overwrite glitch. Account UIs should
	 * surface a rename prompt when this is true.
	 */
	get needsRename() {
		return !!(this.userProfile && this.userProfile.displayName === 'Player');
	}

	/**
	 * Ensure the user's RTDB profile exists at /users/{uid}.
	 * Creates with defaults on first login; loads on subsequent logins.
	 * @param {firebase.database.Database} db
	 * @param {string} [displayName] - override display name (used during sign-up)
	 */
	async ensureUserProfile(db, displayName) {
		if (!this.currentUser || this.currentUser.isAnonymous) return;

		const uid = this.currentUser.uid;
		const ref = db.ref('users/' + uid);
		const snap = await ref.once('value');
		const existing = snap.val() || {};

		// Priority: explicit signup arg → existing RTDB record → Auth profile → 'Player'.
		// 'Player' is reachable only when no name has ever been recorded anywhere.
		const resolvedName =
			displayName ||
			existing.displayName ||
			this.currentUser.displayName ||
			'Player';

		if (!snap.exists()) {
			const profile = {
				displayName: resolvedName,
				elo: 1000,
				gamesPlayed: 0,
				wins: 0,
				losses: 0,
				created: Date.now(),
			};
			await ref.set(profile);
			this.userProfile = profile;
		} else {
			this.userProfile = existing;
			// Only update the stored name when the caller explicitly passed one
			// (sign-up flow). Never overwrite an existing real name with a fallback.
			if (displayName && displayName !== existing.displayName) {
				await ref.child('displayName').set(displayName);
				this.userProfile.displayName = displayName;
			} else if (!existing.displayName && this.currentUser.displayName) {
				// Skeletal record (created by elo.js multi-path update without a name).
				// Backfill from Auth profile only — never write the 'Player' literal.
				await ref.child('displayName').set(this.currentUser.displayName);
				this.userProfile.displayName = this.currentUser.displayName;
			}
		}

		const lbRef = db.ref('leaderboard/' + uid);
		const lbSnap = await lbRef.once('value');
		if (!lbSnap.exists() && this.userProfile.displayName) {
			await lbRef.set({
				displayName: this.userProfile.displayName,
				elo: this.userProfile.elo || 1000,
				gamesPlayed: this.userProfile.gamesPlayed || 0,
			});
		}
	}

	/** Load the user's RTDB profile (call after auth state is ready). */
	async loadProfile(db) {
		if (!this.currentUser || this.currentUser.isAnonymous) {
			this.userProfile = null;
			return null;
		}
		const snap = await db.ref('users/' + this.currentUser.uid).once('value');
		this.userProfile = snap.exists() ? snap.val() : null;
		return this.userProfile;
	}

	get uid() {
		return this.currentUser ? this.currentUser.uid : null;
	}

	get displayName() {
		if (this.userProfile) return this.userProfile.displayName;
		if (this.currentUser) return this.currentUser.displayName || 'Anonymous';
		return 'Guest';
	}

	get elo() {
		return this.userProfile ? this.userProfile.elo : null;
	}

	get isDeveloper() {
		// Server-set boolean; client RTDB rules disallow writing `true`.
		// See ai/set_developer.py for the service-account-authenticated
		// promotion path. Used to gate the dev-only AI eval display.
		return !!(this.userProfile && this.userProfile.isDeveloper);
	}

	get isAnonymous() {
		return !this.currentUser || this.currentUser.isAnonymous;
	}

	get isAuthenticated() {
		return !!this.currentUser && !this.currentUser.isAnonymous;
	}

	/** Get user info object suitable for passing to FirebaseSync. */
	getUserInfo() {
		return {
			uid: this.uid,
			displayName: this.displayName,
			elo: this.elo,
			isAnonymous: this.isAnonymous,
		};
	}
}
