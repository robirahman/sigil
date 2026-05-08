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

	/** Update the user's display name (Auth profile + RTDB). */
	async updateDisplayName(newName) {
		if (!this.currentUser) throw new Error('Not signed in');
		await this.currentUser.updateProfile({ displayName: newName });
		const db = firebase.database();
		await db.ref('users/' + this.currentUser.uid + '/displayName').set(newName);
		// Also update leaderboard denormalized copy if it exists
		const leaderSnap = await db.ref('leaderboard/' + this.currentUser.uid).once('value');
		if (leaderSnap.exists()) {
			await db.ref('leaderboard/' + this.currentUser.uid + '/displayName').set(newName);
		}
		if (this.userProfile) {
			this.userProfile.displayName = newName;
		}
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
