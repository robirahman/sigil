/**
 * Studies: shared, chapter-based analysis boards (analysis.html?study=<id>).
 *
 * studyMixin() is spread into the analysis board's gameBoard after
 * analysisMixin (game-board-local.js), so a study is the analysis board: the
 * same move tree, engine panel and editor. What a study adds:
 *
 *   chapters  each a move tree from its own start position;
 *   live      every turn played, deleted, annotated (!, ?, !!, ??, !?, ?!),
 *             every arrow and circle (board-marks.js) and every comment is
 *             written to the database and reaches the other viewers at once;
 *   roles     the owner and the editors they invite change the study; viewers
 *             follow it, and may play turns of their own, which stay on their
 *             screen only (shown in italics) and are never saved;
 *   sharing   public (listed on studies.html), unlisted (anyone with the link)
 *             or private (members only); invite links for editors and viewers.
 *
 * The tree arrives as a whole (a value listener on the chapter's nodes) and
 * is reconciled into the board's tree: nodes keep their local ids for the
 * session, so the selection, arrows and engine survive every update.
 *
 * Database (database.rules.json enforces every role):
 *   studies/{sid}/meta            { title, desc, owner, ownerName, visibility, created, updated }
 *   studies/{sid}/members/{uid}   { role: 'editor' | 'viewer', name, at }
 *   studies/{sid}/chapterList/{ch} { title, order, by, created }
 *   studies/{sid}/chapters/{ch}/nodes/{key}
 *       { p: parent key (none for 'root'), sfn: loadable SFN, t: the turn (JSON),
 *         s: silenced ('red' | 'blue' | 'both'), w: winner, g: symbol,
 *         m: { '<from>-<to>': colour } arrows and circles, by, at }
 *   studies/{sid}/notes/{ch}/{key}/{uid}  { text, name, at }  one comment per author
 *   study_secrets/{sid}           { editor, viewer }  invite tokens (the owner's)
 *   study_joins/{sid}/{uid}       the token a member joined with (write-only)
 *   study_index/{sid}             { title, ownerName, owner, updated, chapters }  public studies
 *                                 (the owner's copy, refreshed when the settings are saved)
 *   user_studies/{uid}/{sid}      { title, role, at }  a player's study list (studies.html)
 *   study_presence/{sid}/{uid}    { name, ch, node, at }  who has the study open
 */

const STUDY_MAX_NODES = 3000;       // per chapter, by the client
// Database references live outside the Alpine component: its reactive
// proxies break the SDK's internals (one study per page).
let _studyPresenceRef = null;
const STUDY_MAX_CHAPTERS = 64;
const STUDY_NOTE_MAX = 2000;
const STUDY_TITLE_MAX = 80;
const STUDY_VISIBILITIES = [
	{ v: 'public', label: 'Public', hint: 'Listed on the Studies page; anyone can follow it.' },
	{ v: 'unlisted', label: 'Unlisted', hint: 'Anyone with the link can follow it.' },
	{ v: 'private', label: 'Private', hint: 'Only you and the people you invite.' },
];

function studyTs() {
	return firebase.database.ServerValue.TIMESTAMP;
}

/** A random invite token: 24 URL-safe characters. */
function studyToken() {
	const a = new Uint8Array(18);
	crypto.getRandomValues(a);
	return btoa(String.fromCharCode.apply(null, a)).replace(/\+/g, '-').replace(/\//g, '_');
}

function studySilencedCode(sil) {
	if (!sil) return null;
	if (sil.red && sil.blue) return 'both';
	if (sil.red) return 'red';
	if (sil.blue) return 'blue';
	return null;
}

function studySilencedFromCode(c) {
	return { red: c === 'red' || c === 'both', blue: c === 'blue' || c === 'both' };
}

/** { 'a1-b2': 'green' } -> [{ from, to, colour }] (from === to: a circle). */
function studyMarksToList(m) {
	if (!m || typeof m !== 'object') return [];
	return Object.keys(m).sort().map((k) => {
		const [from, to] = k.split('-');
		return { from, to, colour: m[k] };
	}).filter((x) => x.from && x.to);
}

/** The inverse: null for no marks (the database drops the field). */
function studyListToMarks(list) {
	const out = {};
	for (const x of list || []) if (x && x.from && x.to) out[x.from + '-' + x.to] = x.colour || 'green';
	return Object.keys(out).length ? out : null;
}

/** A turn as the study stores it (the fields the tree reads). */
function studySlimTurn(turn) {
	if (!turn) return null;
	return { color: turn.color, turnNumber: turn.turnNumber, kind: turn.kind, actions: turn.actions };
}

/** A tree node as a database record under `parentKey` (null: the root). */
function studyNodeRecord(n, parentKey, uid) {
	const rec = { sfn: n.sfn, by: uid, at: studyTs() };
	if (parentKey) rec.p = parentKey;
	const turn = studySlimTurn(n.turn);
	if (turn) rec.t = JSON.stringify(turn);
	const s = studySilencedCode(n.silenced);
	if (s) rec.s = s;
	if (n.winner === 'red' || n.winner === 'blue') rec.w = n.winner;
	if (n.glyph) rec.g = n.glyph;
	return rec;
}

/**
 * A chapter's node keys, parents first ('root', then breadth-first), each
 * node's children in key order (push keys sort by creation time, so the
 * first child is the main line). Nodes not reachable from the root (an
 * unfinished delete) are left out.
 */
function studyOrderNodes(nodes) {
	if (!nodes || !nodes.root) return [];
	const kids = {};
	for (const k of Object.keys(nodes)) {
		const p = k !== 'root' && nodes[k] && nodes[k].p;
		if (p) (kids[p] = kids[p] || []).push(k);
	}
	const out = ['root'];
	for (let i = 0; i < out.length; i++) {
		const ch = kids[out[i]];
		if (ch) out.push(...ch.sort());
	}
	return out;
}

/**
 * The subtree of an analysis tree from `startId` as chapter records:
 * { nodes: { key: record }, count }. The start becomes the root. newKey()
 * gives a fresh database key.
 */
function studyChapterNodes(tree, startId, uid, newKey) {
	const nodes = {};
	let count = 0;
	const stack = [[startId, null]];
	while (stack.length) {
		const [id, parentKey] = stack.pop();
		const n = tree[id];
		if (!n || n.deleted || n.local) continue;
		const key = parentKey === null ? 'root' : newKey();
		const rec = studyNodeRecord(n, parentKey, uid);
		// The start may be a later position: its turn belongs to the old line.
		if (parentKey === null) delete rec.t;
		nodes[key] = rec;
		count++;
		for (let i = n.children.length - 1; i >= 0; i--) stack.push([n.children[i], key]);
	}
	return { nodes, count };
}

/** The standard start on the core board with a random core draw. */
function studyStartSfn() {
	const b = new SigilBoard(generateSpellList(['core']), 'standard');
	b.setupInitial();
	return boardToSfn(b);
}

/** The signed-in user's display name: their profile's, or 'Guest'. */
async function studyUserName(user) {
	if (!user) return 'Guest';
	if (user.isAnonymous) return 'Guest';
	try {
		const snap = await firebase.database().ref('users/' + user.uid + '/displayName').once('value');
		if (snap.exists() && typeof snap.val() === 'string') return snap.val().slice(0, 30);
	} catch (e) { /* the auth name */ }
	return (user.displayName || 'Player').slice(0, 30);
}

/**
 * Create a study: meta, its first chapter (the `nodes` of
 * studyChapterNodes, or just a root at `sfn`), and the owner's list entry.
 * Returns { sid, ch }.
 */
async function studyCreate(user, opts) {
	const db = firebase.database();
	const sid = db.ref('studies').push().key;
	const ch = db.ref('studies/' + sid + '/chapterList').push().key;
	const title = String(opts.title || 'Untitled study').trim().slice(0, STUDY_TITLE_MAX) || 'Untitled study';
	const visibility = STUDY_VISIBILITIES.some((x) => x.v === opts.visibility) ? opts.visibility : 'unlisted';
	const name = await studyUserName(user);
	const nodes = opts.nodes || { root: { sfn: opts.sfn || studyStartSfn(), by: user.uid, at: studyTs() } };
	const u = {};
	u['studies/' + sid + '/meta'] = { title, owner: user.uid, ownerName: name, visibility, created: studyTs(), updated: studyTs() };
	u['studies/' + sid + '/chapterList/' + ch] = {
		title: String(opts.chapterTitle || 'Chapter 1').trim().slice(0, STUDY_TITLE_MAX) || 'Chapter 1',
		order: 0, by: user.uid, created: studyTs(),
	};
	for (const k of Object.keys(nodes)) u['studies/' + sid + '/chapters/' + ch + '/nodes/' + k] = nodes[k];
	u['user_studies/' + user.uid + '/' + sid] = { title, role: 'owner', at: studyTs() };
	if (visibility === 'public') {
		u['study_index/' + sid] = { title, ownerName: name, owner: user.uid, updated: studyTs(), chapters: 1 };
	}
	await db.ref().update(u);
	return { sid, ch };
}

function studyMixin() {
	return {
		// The study on this page ('' on the plain analysis board).
		studyId: '',
		studyStatus: '',            // 'loading' | 'ready' | 'missing' | 'denied' | 'error'
		studyError: '',             // the last failed write or join, shown until dismissed
		studyMeta: null,            // studies/{sid}/meta
		studyUid: '',
		studyUserName: 'Guest',
		studyAnon: true,
		studyRole: '',              // 'owner' | 'editor' | 'viewer'
		studyChapters: [],          // [{ id, title, order, by }] in order
		studyChapter: '',
		studyMembers: [],           // [{ uid, name, role }]
		studyPresence: [],          // [{ uid, name, ch, node, me }]
		studyNotes: {},             // node key -> [{ uid, name, text, at }]
		studyNoteDraft: '',
		studyNoteEditing: false,
		studyLinkCopied: '',
		studyNewChapter: { open: false, title: '', from: 'here', sfn: '', error: '' },
		studyRename: { open: false, title: '' },
		studySettings: { title: '', desc: '', visibility: 'unlisted', saving: false, msg: '' },
		studyInvite: { name: '', role: 'editor', msg: '', busy: false },
		studyLinks: { editor: '', viewer: '', loading: false },
		// The plain board's "Save to a study" panel.
		studySave: { open: false, list: [], target: '', title: '', chapterTitle: '', visibility: 'unlisted', busy: false, msg: '', loaded: false },

		_studyKeyToId: null,
		_studyOff: [],
		_studyChOff: [],
		_studyNodesRaw: null,
		_studyPendingNode: '',
		_studyPresenceTimer: null,
		_studyMarksHooked: false,

		// ---------------- start ----------------

		/** analysis-board's _analysisInit, when the URL names a study. */
		async _studyInit(params) {
			this.studyId = params.get('study');
			this.studyStatus = 'loading';
			this.anaMode = 'analyse';
			this._studyKeyToId = new Map();
			this._studyPendingNode = params.get('node') || '';
			const wantChapter = params.get('chapter') || '';
			if (typeof firebase === 'undefined' || !firebase.apps || !firebase.apps.length) {
				this.studyStatus = 'error';
				this.studyError = 'Studies need the online service, which did not load.';
				return;
			}
			let user = await firebaseAuthSettled();
			// Presence and joining need a uid: a guest gets one, as online play does.
			if (!user) {
				try { user = (await firebase.auth().signInAnonymously()).user; } catch (e) { user = null; }
			}
			this.studyUid = user ? user.uid : '';
			this.studyAnon = !user || user.isAnonymous;
			this.studyUserName = await studyUserName(user);
			const join = params.get('join');
			if (user && (join === 'editor' || join === 'viewer') && params.get('token')) {
				await this._studyJoin(join, params.get('token'));
			}
			this._studyHookMarks();
			this._studyListen(wantChapter);
			this.$watch('anaCur', () => { this._studyLoadNoteDraft(); this._studyPresenceSoon(); });
		},

		/** Become a member through an invite link (the token proves it). */
		async _studyJoin(role, token) {
			const db = firebase.database();
			const sid = this.studyId;
			try {
				const meta = (await db.ref('studies/' + sid + '/meta').once('value').catch(() => null));
				if (meta && meta.exists() && meta.val().owner === this.studyUid) return;
				const mine = await db.ref('studies/' + sid + '/members/' + this.studyUid).once('value').catch(() => null);
				// An editor following a viewer link stays an editor.
				if (mine && mine.exists() && (mine.val().role === role || mine.val().role === 'editor')) return;
				const u = {};
				u['study_joins/' + sid + '/' + this.studyUid] = token;
				u['studies/' + sid + '/members/' + this.studyUid] = { role, name: this.studyUserName, at: studyTs() };
				const title = meta && meta.exists() ? meta.val().title : 'Study';
				u['user_studies/' + this.studyUid + '/' + sid] = { title: String(title).slice(0, STUDY_TITLE_MAX), role, at: studyTs() };
				await db.ref().update(u);
			} catch (e) {
				this.studyError = 'This invite link is not valid any more. Ask the study\'s owner for a new one.';
			}
			// The token leaves the address bar (and the shared link).
			try {
				const url = new URL(window.location.href);
				url.searchParams.delete('join');
				url.searchParams.delete('token');
				history.replaceState(null, '', url.toString());
			} catch (e) { /* ignore */ }
		},

		_studyListen(wantChapter) {
			const db = firebase.database();
			const base = 'studies/' + this.studyId;
			const on = (path, fn) => {
				const ref = db.ref(path);
				const cb = ref.on('value', fn, (err) => this._studyDenied(err));
				this._studyOff.push(() => ref.off('value', cb));
			};
			let first = true;
			on(base + '/meta', (snap) => {
				if (!snap.exists()) {
					this.studyStatus = 'missing';
					this._studyStopChapter();
					return;
				}
				this.studyMeta = snap.val();
				this._studyComputeRole();
				if (first) {
					first = false;
					this._studyResetSettings();
					this._studyStartPresence();
				}
				if (this.studyStatus === 'loading' && this.studyChapters.length && this.studyChapter) this.studyStatus = 'ready';
			});
			on(base + '/members', (snap) => {
				const v = snap.val() || {};
				this.studyMembers = Object.keys(v).map((uid) => ({ uid, name: v[uid].name || 'Player', role: v[uid].role }))
					.sort((a, b) => (a.role === b.role ? (a.name < b.name ? -1 : 1) : (a.role === 'editor' ? -1 : 1)));
				this._studyComputeRole();
			});
			on(base + '/chapterList', (snap) => {
				const v = snap.val() || {};
				this.studyChapters = Object.keys(v).map((id) => Object.assign({ id }, v[id]))
					.sort((a, b) => ((a.order || 0) - (b.order || 0)) || (a.id < b.id ? -1 : 1));
				if (!this.studyChapters.length) return;
				// The chapter in view went away: the first one.
				if (!this.studyChapter || !this.studyChapters.some((c) => c.id === this.studyChapter)) {
					const want = this.studyChapters.find((c) => c.id === wantChapter);
					this.studyOpenChapter((want || this.studyChapters[0]).id, want ? this._studyPendingNode : '');
				}
			});
			on('study_presence/' + this.studyId, (snap) => {
				const v = snap.val() || {};
				this.studyPresence = Object.keys(v).map((uid) => Object.assign({ uid, me: uid === this.studyUid }, v[uid]))
					.sort((a, b) => (a.me ? -1 : b.me ? 1 : (a.name < b.name ? -1 : 1)));
			});
		},

		_studyDenied(err) {
			if (this.studyStatus === 'ready' || this.studyStatus === 'loading') {
				this.studyStatus = 'denied';
				this.studyError = '';
			}
			void err;
			this._studyStopChapter();
		},

		_studyComputeRole() {
			const m = this.studyMeta;
			if (!m) { this.studyRole = ''; return; }
			if (m.owner === this.studyUid && this.studyUid) this.studyRole = 'owner';
			else {
				const me = this.studyMembers.find((x) => x.uid === this.studyUid);
				this.studyRole = me ? me.role : 'viewer';
			}
		},

		studyCanEdit() {
			return this.studyRole === 'owner' || this.studyRole === 'editor';
		},

		/** analysis-board: may this node be changed (deleted, annotated)? */
		_studyCanEdit(node) {
			if (!this.studyId) return true;
			return !!(node && node.local) || this.studyCanEdit();
		},

		// ---------------- chapters ----------------

		_studyStopChapter() {
			for (const off of this._studyChOff) off();
			this._studyChOff = [];
		},

		/** Show chapter `ch`, at node `nodeKey` when given (else its start). */
		studyOpenChapter(ch, nodeKey) {
			if (!ch) return;
			this._studyStopChapter();
			this.studyChapter = ch;
			this.studyNotes = {};
			this.studyNewChapter.open = false;
			this.studyRename.open = false;
			this._studyKeyToId = new Map();
			this._studyPendingNode = nodeKey || '';
			this.anaMode = 'analyse';
			// Nothing is played on the old chapter's board while the new one loads.
			this._anaStopEval();
			if (this._anaCtl) this._anaCtl.stop();
			if (this.boardMarks) this.boardMarks.clearAll();
			const db = firebase.database();
			const base = 'studies/' + this.studyId;
			let first = true;
			const nodesRef = db.ref(base + '/chapters/' + ch + '/nodes');
			const cb = nodesRef.on('value', (snap) => {
				if (this.studyChapter !== ch) return;
				const nodes = snap.val();
				if (!nodes || !nodes.root) {
					// A deleted chapter: chapterList moves us on.
					if (first) this.studyStatus = this.studyStatus === 'loading' ? 'loading' : this.studyStatus;
					return;
				}
				this._studyNodesRaw = nodes;
				if (first) {
					first = false;
					this.anaTree = [];
					this._studyApply(nodes);
					const target = this._studyPendingNode && this._studyKeyToId.get(this._studyPendingNode);
					this._studyPendingNode = '';
					this.anaGoto(target || 0);
					if (this.studyMeta) this.studyStatus = 'ready';
				} else {
					this._studyApply(nodes);
				}
			}, (err) => this._studyDenied(err));
			this._studyChOff.push(() => nodesRef.off('value', cb));
			const notesRef = db.ref(base + '/notes/' + ch);
			const ncb = notesRef.on('value', (snap) => {
				if (this.studyChapter !== ch) return;
				const v = snap.val() || {};
				const out = {};
				for (const key of Object.keys(v)) {
					out[key] = Object.keys(v[key] || {}).map((uid) => Object.assign({ uid }, v[key][uid]))
						.filter((x) => typeof x.text === 'string')
						.sort((a, b) => (a.at || 0) - (b.at || 0));
				}
				this.studyNotes = out;
				for (const n of this.anaTree) if (n.key) n.notes = (out[n.key] || []).length;
				if (!this.studyNoteEditing) this._studyLoadNoteDraft();
			}, () => { /* the nodes listener reports access */ });
			this._studyChOff.push(() => notesRef.off('value', ncb));
			this._studyPresenceSoon();
		},

		/**
		 * Merge the chapter's records into the board's tree: new nodes join
		 * under their parents (siblings in key order, this viewer's own
		 * unsaved turns last), changed ones take their symbol, winner and
		 * marks, and nodes gone from the database leave with their subtrees.
		 */
		_studyApply(nodes) {
			const T = this.anaTree;
			const ids = this._studyKeyToId;
			const order = studyOrderNodes(nodes);
			const present = new Set(order);
			let removedCur = false;
			for (const n of T) {
				if (n.deleted || !n.key || present.has(n.key)) continue;
				if (this._studyDropSubtree(n)) removedCur = true;
			}
			for (const key of order) {
				const rec = nodes[key];
				let id = ids.get(key);
				let node = id === undefined ? null : T[id];
				if (!node || node.deleted) {
					let parent = null;
					if (key !== 'root') {
						const pid = ids.get(rec.p);
						parent = pid === undefined ? null : T[pid];
						if (!parent || parent.deleted) continue;
					} else if (T.length) {
						continue;   // the root is always node 0
					}
					let turn = null;
					try { turn = rec.t ? JSON.parse(rec.t) : null; } catch (e) { turn = null; }
					node = {
						id: T.length, key, parent: parent ? parent.id : null, sfn: rec.sfn,
						label: parent ? (turn ? analysisTurnLabel(turn.color, turn.turnNumber) : 'Turn') : 'Start',
						text: turn ? analysisTurnText(turn) : '',
						turn, children: [], lastChild: null,
						winner: rec.w || null, deleted: false,
						silenced: studySilencedFromCode(rec.s),
						glyph: rec.g || '', notes: (this.studyNotes[key] || []).length,
					};
					if (!parent && !rec.w) {
						try { node.winner = analysisDecidedWinner(rec.sfn); } catch (e) { node.winner = null; }
					}
					T.push(node);
					ids.set(key, node.id);
					if (parent) this._studyInsertChild(parent, node);
				} else {
					node.glyph = rec.g || '';
					if (rec.w && !node.winner) node.winner = rec.w;
				}
				if (this.boardMarks) this.boardMarks.set('node:' + node.id, studyMarksToList(rec.m));
			}
			if (removedCur) {
				let n = this._anaNode();
				while (n && n.deleted && n.parent !== null) n = T[n.parent];
				if (n) this.anaGoto(n.id);
			}
		},

		/** Children in key order; unsaved (local) ones after the shared. */
		_studyInsertChild(parent, node) {
			const T = this.anaTree;
			const rank = (n) => (n.key ? '0' + n.key : '1' + String(n.id).padStart(8, '0'));
			const kids = parent.children.slice();
			let at = kids.length;
			for (let i = 0; i < kids.length; i++) {
				if (rank(T[kids[i]]) > rank(node)) { at = i; break; }
			}
			kids.splice(at, 0, node.id);
			parent.children = kids;
			if (parent.lastChild === null) parent.lastChild = node.id;
		},

		/** Drop a node and its subtree; true when the selection was in it. */
		_studyDropSubtree(node) {
			const T = this.anaTree;
			let hadCur = false;
			const drop = (n) => {
				if (n.deleted) return;
				n.deleted = true;
				if (n.id === this.anaCur) hadCur = true;
				if (n.key) this._studyKeyToId.delete(n.key);
				n.children.forEach((i) => drop(T[i]));
			};
			drop(node);
			if (node.parent !== null) {
				const parent = T[node.parent];
				parent.children = parent.children.filter((i) => i !== node.id);
				if (parent.lastChild === node.id) parent.lastChild = parent.children[0] === undefined ? null : parent.children[0];
			}
			return hadCur;
		},

		/** analysis-board: a new turn under the selected node. Editors save
		 *  it; a viewer keeps it on this screen only. */
		_studyNodeAdded(child) {
			if (!this.studyId || !this.studyChapter) return;
			const parent = this.anaTree[child.parent];
			if (!this.studyCanEdit() || !parent || parent.local || !parent.key) {
				child.local = true;
				return;
			}
			const db = firebase.database();
			const base = 'studies/' + this.studyId;
			if (this.anaTree.filter((n) => !n.deleted && n.key).length >= STUDY_MAX_NODES) {
				child.local = true;
				this.studyError = 'This chapter is full (' + STUDY_MAX_NODES + ' turns): the turn stays on your screen only. Start a new chapter.';
				return;
			}
			const key = db.ref(base + '/chapters/' + this.studyChapter + '/nodes').push().key;
			child.key = key;
			child.notes = 0;
			this._studyKeyToId.set(key, child.id);
			// Only the parent's place in the order matters: a new key sorts last.
			const u = {};
			u[base + '/chapters/' + this.studyChapter + '/nodes/' + key] = studyNodeRecord(child, parent.key, this.studyUid);
			this._studyTouch(u);
			this._studyWrite(u);
		},

		_studyWinnerFound(node) {
			if (!this.studyId || !node.key || !this.studyCanEdit() || !node.winner) return;
			this._studyWrite({ ['studies/' + this.studyId + '/chapters/' + this.studyChapter + '/nodes/' + node.key + '/w']: node.winner });
		},

		/** analysis-board: turns deleted (the selected one and what follows). */
		_studyNodesDeleted(dropped) {
			if (!this.studyId) return;
			const keys = dropped.filter((n) => n.key).map((n) => n.key);
			for (const k of keys) this._studyKeyToId.delete(k);
			if (!keys.length || !this.studyCanEdit()) return;
			const base = 'studies/' + this.studyId;
			const u = {};
			for (const k of keys) {
				u[base + '/chapters/' + this.studyChapter + '/nodes/' + k] = null;
				if (this.studyNotes[k]) u[base + '/notes/' + this.studyChapter + '/' + k] = null;
			}
			this._studyTouch(u);
			this._studyWrite(u);
		},

		_studyGlyphChanged(node) {
			if (!this.studyId || !node.key || !this.studyCanEdit()) return;
			const u = {};
			u['studies/' + this.studyId + '/chapters/' + this.studyChapter + '/nodes/' + node.key + '/g'] = node.glyph || null;
			this._studyTouch(u);
			this._studyWrite(u);
		},

		/** Arrows and circles drawn on a shared node go to the database. */
		_studyHookMarks() {
			if (this._studyMarksHooked || !this.boardMarks) return;
			this._studyMarksHooked = true;
			this.boardMarks.onChange((key, list) => {
				if (!this.studyId || !this.studyCanEdit() || !/^node:\d+$/.test(key)) return;
				const node = this.anaTree[Number(key.slice(5))];
				if (!node || node.deleted || !node.key) return;
				const u = {};
				u['studies/' + this.studyId + '/chapters/' + this.studyChapter + '/nodes/' + node.key + '/m'] = studyListToMarks(list);
				this._studyWrite(u);
			});
		},

		/** The study's last change (studies.html sorts by it). */
		_studyTouch(u) {
			u['studies/' + this.studyId + '/meta/updated'] = studyTs();
		},

		_studyWrite(u) {
			return firebase.database().ref().update(u).catch((e) => {
				this.studyError = 'Your change was not saved' + (e && e.code === 'PERMISSION_DENIED' ? ': you can no longer edit this study.' : ' (' + ((e && e.message) || e) + ').');
			});
		},

		/** The editor's position as a new chapter (analysis-board edAnalyse). */
		_studyFromEditor(sfn) {
			if (!this.studyId) return false;
			if (!this.studyCanEdit()) {
				this.studyError = 'Only the study\'s owner and editors add chapters.';
				return true;
			}
			this.studyNewChapter = { open: true, title: this.studyNewChapter.title || '', from: 'editor', sfn, error: '' };
			this.studyCreateChapter();
			return true;
		},

		/** The Analyse tab from the editor: back to the chapter as it was. */
		_studyBackToChapter() {
			if (!this.studyId) return false;
			this.anaMode = 'analyse';
			const node = this._anaNode();
			if (node) this.anaGoto(node.id);
			return true;
		},

		studyOpenNewChapter() {
			this.studyNewChapter = { open: true, title: 'Chapter ' + (this.studyChapters.length + 1), from: 'here', sfn: '', error: '' };
		},

		/** Add a chapter from the selected position, the standard start, a
		 *  pasted SFN or the editor's position. */
		async studyCreateChapter() {
			const nc = this.studyNewChapter;
			nc.error = '';
			if (!this.studyCanEdit()) return;
			if (this.studyChapters.length >= STUDY_MAX_CHAPTERS) { nc.error = 'A study holds at most ' + STUDY_MAX_CHAPTERS + ' chapters.'; return; }
			let sfn = '';
			let silenced = null;
			if (nc.from === 'here') {
				const node = this._anaNode();
				if (!node) { nc.error = 'No position is selected.'; return; }
				sfn = node.sfn;
				silenced = node.silenced;
			} else if (nc.from === 'start') {
				sfn = studyStartSfn();
			} else {
				sfn = String(nc.sfn || '').trim();
				const check = analysisValidateSfn(sfn);
				const fatal = check.errors.filter((e) => !/already decided|does not survive/.test(e));
				if (fatal.length) { nc.error = fatal.join(' '); return; }
			}
			const db = firebase.database();
			const base = 'studies/' + this.studyId;
			const ch = db.ref(base + '/chapterList').push().key;
			const order = this.studyChapters.reduce((m, c) => Math.max(m, c.order || 0), -1) + 1;
			const title = String(nc.title || '').trim().slice(0, STUDY_TITLE_MAX) || ('Chapter ' + (this.studyChapters.length + 1));
			const root = { sfn, by: this.studyUid, at: studyTs() };
			const s = studySilencedCode(silenced);
			if (s) root.s = s;
			const u = {};
			u[base + '/chapterList/' + ch] = { title, order, by: this.studyUid, created: studyTs() };
			u[base + '/chapters/' + ch + '/nodes/root'] = root;
			this._studyTouch(u);
			try {
				await db.ref().update(u);
			} catch (e) {
				nc.error = 'The chapter was not saved: ' + ((e && e.message) || e);
				return;
			}
			this.studyNewChapter = { open: false, title: '', from: 'here', sfn: '', error: '' };
			this.studyOpenChapter(ch, '');
		},

		studyChapterTitle() {
			const c = this.studyChapters.find((x) => x.id === this.studyChapter);
			return c ? c.title : '';
		},

		studyStartRename() {
			this.studyRename = { open: true, title: this.studyChapterTitle() };
		},

		async studySaveRename() {
			const title = String(this.studyRename.title || '').trim().slice(0, STUDY_TITLE_MAX);
			if (!title || !this.studyCanEdit()) return;
			const u = { ['studies/' + this.studyId + '/chapterList/' + this.studyChapter + '/title']: title };
			this._studyTouch(u);
			await this._studyWrite(u);
			this.studyRename.open = false;
		},

		/** Move the chapter in view up (-1) or down (+1) the list. */
		async studyMoveChapter(dir) {
			const list = this.studyChapters;
			const i = list.findIndex((c) => c.id === this.studyChapter);
			const j = i + dir;
			if (i < 0 || j < 0 || j >= list.length || !this.studyCanEdit()) return;
			const base = 'studies/' + this.studyId + '/chapterList/';
			// Renumber the whole list, so equal orders from old clients sort too.
			const ids = list.map((c) => c.id);
			[ids[i], ids[j]] = [ids[j], ids[i]];
			const u = {};
			ids.forEach((id, k) => { u[base + id + '/order'] = k; });
			await this._studyWrite(u);
		},

		async studyDeleteChapter() {
			if (!this.studyCanEdit() || this.studyChapters.length <= 1) return;
			if (!window.confirm('Delete the chapter "' + this.studyChapterTitle() + '" with all its turns and comments?')) return;
			const base = 'studies/' + this.studyId;
			const ch = this.studyChapter;
			const u = {};
			u[base + '/chapterList/' + ch] = null;
			u[base + '/chapters/' + ch] = null;
			u[base + '/notes/' + ch] = null;
			this._studyTouch(u);
			await this._studyWrite(u);
		},

		// ---------------- comments ----------------

		/** The comments on the selected node, oldest first. */
		studyNodeNotes() {
			const node = this._anaNode();
			return node && node.key ? (this.studyNotes[node.key] || []) : [];
		},

		studyMyNote() {
			return this.studyNodeNotes().find((x) => x.uid === this.studyUid) || null;
		},

		_studyLoadNoteDraft() {
			const mine = this.studyMyNote();
			this.studyNoteDraft = mine ? mine.text : '';
			this.studyNoteEditing = false;
		},

		studyCanComment() {
			const node = this._anaNode();
			return !!(this.studyId && this.studyCanEdit() && node && node.key && !node.deleted);
		},

		async studySaveNote() {
			const node = this._anaNode();
			if (!this.studyCanComment()) return;
			const text = String(this.studyNoteDraft || '').trim().slice(0, STUDY_NOTE_MAX);
			const path = 'studies/' + this.studyId + '/notes/' + this.studyChapter + '/' + node.key + '/' + this.studyUid;
			const u = { [path]: text ? { text, name: this.studyUserName, at: studyTs() } : null };
			this._studyTouch(u);
			await this._studyWrite(u);
			this.studyNoteEditing = false;
		},

		async studyDeleteNote(uid) {
			const node = this._anaNode();
			if (!node || !node.key) return;
			if (uid !== this.studyUid && this.studyRole !== 'owner') return;
			await this._studyWrite({ ['studies/' + this.studyId + '/notes/' + this.studyChapter + '/' + node.key + '/' + uid]: null });
			if (uid === this.studyUid) this.studyNoteDraft = '';
		},

		studyNoteWhen(at) {
			if (!at) return '';
			const d = new Date(at);
			return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		},

		// ---------------- presence ----------------

		_studyStartPresence() {
			if (!this.studyUid || _studyPresenceRef) return;
			const ref = firebase.database().ref('study_presence/' + this.studyId + '/' + this.studyUid);
			_studyPresenceRef = ref;
			ref.onDisconnect().remove().catch(() => {});
			this._studyPresenceWrite();
			window.addEventListener('pagehide', () => { ref.remove().catch(() => {}); });
		},

		_studyPresenceSoon() {
			if (!_studyPresenceRef) return;
			clearTimeout(this._studyPresenceTimer);
			this._studyPresenceTimer = setTimeout(() => this._studyPresenceWrite(), 600);
		},

		_studyPresenceWrite() {
			const ref = _studyPresenceRef;
			if (!ref) return;
			const node = this._anaNode();
			const v = { name: this.studyUserName, at: studyTs() };
			if (this.studyChapter) v.ch = this.studyChapter;
			if (node && node.key) v.node = node.key;
			ref.set(v).catch(() => {});
		},

		/** Jump to where another viewer is. */
		studyGoToPerson(p) {
			if (!p || p.me || !p.ch) return;
			if (p.ch !== this.studyChapter) {
				this.studyOpenChapter(p.ch, p.node || '');
				return;
			}
			const id = p.node ? this._studyKeyToId.get(p.node) : 0;
			if (id !== undefined) this.anaGoto(id);
		},

		studyPresenceText(p) {
			const c = this.studyChapters.find((x) => x.id === p.ch);
			return p.name + (p.me ? ' (you)' : '') + (c ? ': ' + c.title : '');
		},

		// ---------------- sharing and settings ----------------

		/** analysis-board's URL sync: the study, chapter and node. */
		_studySyncUrl() {
			if (!this.studyId) return false;
			const node = this._anaNode();
			try {
				const u = new URL(window.location.href);
				for (const k of ['sfn', 'mode', 'line']) u.searchParams.delete(k);
				u.searchParams.set('study', this.studyId);
				if (this.studyChapter) u.searchParams.set('chapter', this.studyChapter);
				if (node && node.key && node.key !== 'root') u.searchParams.set('node', node.key);
				else u.searchParams.delete('node');
				history.replaceState(null, '', u.toString());
			} catch (e) { /* ignore */ }
			this._studyPresenceSoon();
			return true;
		},

		studyShareUrl(withNode) {
			const u = new URL('analysis.html', window.location.href);
			u.searchParams.set('study', this.studyId);
			if (withNode) {
				const node = this._anaNode();
				if (this.studyChapter) u.searchParams.set('chapter', this.studyChapter);
				if (node && node.key && node.key !== 'root') u.searchParams.set('node', node.key);
			}
			return u.toString();
		},

		studyCopy(text, which) {
			if (!text || !navigator.clipboard) return;
			navigator.clipboard.writeText(text).then(() => {
				this.studyLinkCopied = which;
				setTimeout(() => { if (this.studyLinkCopied === which) this.studyLinkCopied = ''; }, 2000);
			}).catch(() => {});
		},

		studyVisibilities() {
			return STUDY_VISIBILITIES;
		},

		studyVisibilityLabel() {
			const v = STUDY_VISIBILITIES.find((x) => this.studyMeta && x.v === this.studyMeta.visibility);
			return v ? v.label : '';
		},

		studyRoleLabel() {
			return { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' }[this.studyRole] || '';
		},

		_studyResetSettings() {
			const m = this.studyMeta || {};
			this.studySettings = { title: m.title || '', desc: m.desc || '', visibility: m.visibility || 'unlisted', saving: false, msg: '' };
		},

		/** Owner: title, description and visibility (with the public listing). */
		async studySaveSettings() {
			if (this.studyRole !== 'owner') return;
			const s = this.studySettings;
			const title = String(s.title || '').trim().slice(0, STUDY_TITLE_MAX);
			if (!title) { s.msg = 'The study needs a title.'; return; }
			const vis = STUDY_VISIBILITIES.some((x) => x.v === s.visibility) ? s.visibility : 'unlisted';
			const base = 'studies/' + this.studyId;
			const u = {};
			u[base + '/meta/title'] = title;
			u[base + '/meta/desc'] = String(s.desc || '').trim().slice(0, 1000) || null;
			u[base + '/meta/visibility'] = vis;
			u[base + '/meta/updated'] = studyTs();
			u['study_index/' + this.studyId] = vis === 'public'
				? { title, ownerName: this.studyMeta.ownerName || this.studyUserName, owner: this.studyUid, updated: studyTs(), chapters: this.studyChapters.length }
				: null;
			u['user_studies/' + this.studyUid + '/' + this.studyId] = { title, role: 'owner', at: studyTs() };
			s.saving = true;
			s.msg = '';
			try {
				await firebase.database().ref().update(u);
				s.msg = 'Saved.';
			} catch (e) {
				s.msg = 'Not saved: ' + ((e && e.message) || e);
			}
			s.saving = false;
		},

		/** Owner: the invite links (made on first use). */
		async studyLoadLinks(rotate) {
			if (this.studyRole !== 'owner') return;
			const db = firebase.database();
			const ref = db.ref('study_secrets/' + this.studyId);
			this.studyLinks.loading = true;
			try {
				let v = (await ref.once('value')).val() || {};
				if (rotate || !v.editor || !v.viewer) {
					v = { editor: studyToken(), viewer: studyToken() };
					await ref.set(v);
				}
				const link = (role, token) => {
					const u = new URL('analysis.html', window.location.href);
					u.searchParams.set('study', this.studyId);
					u.searchParams.set('join', role);
					u.searchParams.set('token', token);
					return u.toString();
				};
				this.studyLinks = { editor: link('editor', v.editor), viewer: link('viewer', v.viewer), loading: false };
			} catch (e) {
				this.studyLinks.loading = false;
				this.studyError = 'Could not make the invite links: ' + ((e && e.message) || e);
			}
		},

		/** Owner: invite a player by their name, as an editor or a viewer. */
		async studyInviteByName() {
			const inv = this.studyInvite;
			inv.msg = '';
			const name = String(inv.name || '').trim();
			if (!name || this.studyRole !== 'owner') return;
			const db = firebase.database();
			inv.busy = true;
			try {
				const uid = (await db.ref('usernames/' + name.toLowerCase()).once('value')).val();
				if (!uid) { inv.msg = 'No player is called ' + name + '.'; return; }
				if (uid === this.studyUid) { inv.msg = 'That is you.'; return; }
				const shown = (await db.ref('users/' + uid + '/displayName').once('value')).val() || name;
				const role = inv.role === 'viewer' ? 'viewer' : 'editor';
				const u = {};
				u['studies/' + this.studyId + '/members/' + uid] = { role, name: String(shown).slice(0, 30), at: studyTs() };
				u['user_studies/' + uid + '/' + this.studyId] = { title: this.studyMeta.title, role, at: studyTs() };
				await db.ref().update(u);
				inv.msg = shown + ' is now ' + (role === 'editor' ? 'an editor' : 'a viewer') + '.';
				inv.name = '';
			} catch (e) {
				inv.msg = 'Could not invite: ' + ((e && e.message) || e);
			} finally {
				inv.busy = false;
			}
		},

		async studySetMemberRole(uid, role) {
			if (this.studyRole !== 'owner' || (role !== 'editor' && role !== 'viewer')) return;
			await this._studyWrite({ ['studies/' + this.studyId + '/members/' + uid + '/role']: role });
		},

		async studyRemoveMember(uid) {
			if (this.studyRole !== 'owner') return;
			const u = {};
			u['studies/' + this.studyId + '/members/' + uid] = null;
			u['user_studies/' + uid + '/' + this.studyId] = null;
			await this._studyWrite(u);
		},

		/** A member leaves (their list entry goes too). */
		async studyLeave() {
			if (this.studyRole === 'owner' || !this.studyMembers.some((m) => m.uid === this.studyUid)) return;
			if (!window.confirm('Leave this study? You will need a new invite to edit it again.')) return;
			const u = {};
			u['studies/' + this.studyId + '/members/' + this.studyUid] = null;
			u['user_studies/' + this.studyUid + '/' + this.studyId] = null;
			await this._studyWrite(u);
		},

		studyIsMember() {
			return this.studyMembers.some((m) => m.uid === this.studyUid);
		},

		/** Follow a public or unlisted study: it joins the player's list. */
		async studyBookmark() {
			if (!this.studyUid || !this.studyMeta) return;
			await this._studyWrite({ ['user_studies/' + this.studyUid + '/' + this.studyId]: { title: this.studyMeta.title, role: 'viewer', at: studyTs() } });
			this.studyLinkCopied = 'bookmark';
		},

		async studyDelete() {
			if (this.studyRole !== 'owner') return;
			if (!window.confirm('Delete the study "' + this.studyMeta.title + '" for everyone? This cannot be undone.')) return;
			const u = {};
			u['studies/' + this.studyId] = null;
			u['study_secrets/' + this.studyId] = null;
			u['study_index/' + this.studyId] = null;
			u['study_joins/' + this.studyId] = null;
			u['user_studies/' + this.studyUid + '/' + this.studyId] = null;
			try {
				if (_studyPresenceRef) await _studyPresenceRef.remove();
				_studyPresenceRef = null;
				await firebase.database().ref().update(u);
				window.location.href = 'studies.html';
			} catch (e) {
				this.studyError = 'The study was not deleted: ' + ((e && e.message) || e);
			}
		},

		// ---------------- the plain board: save to a study ----------------

		/** Open the panel and list the studies this player may add to. */
		async studySaveOpen() {
			const s = this.studySave;
			s.open = !s.open;
			if (!s.open) return;
			s.msg = '';
			s.chapterTitle = s.chapterTitle || 'Chapter';
			if (s.loaded) return;
			const user = await firebaseAuthSettled();
			if (!user) { s.list = []; s.loaded = true; s.target = 'new'; return; }
			try {
				const v = (await firebase.database().ref('user_studies/' + user.uid).once('value')).val() || {};
				s.list = Object.keys(v).filter((sid) => v[sid].role === 'owner' || v[sid].role === 'editor')
					.map((sid) => ({ sid, title: v[sid].title || 'Study' }))
					.sort((a, b) => (a.title < b.title ? -1 : 1));
			} catch (e) { s.list = []; }
			s.target = s.list.length ? s.list[0].sid : 'new';
			s.loaded = true;
		},

		/** Save the whole tree (from its start) as a new study or as a new
		 *  chapter of an existing one, then open it there. */
		async studySaveTree() {
			const s = this.studySave;
			s.msg = '';
			const user = await firebaseAuthSettled();
			if (s.target === 'new' && (!user || user.isAnonymous)) {
				s.msg = 'Sign in (Account page) to create a study.';
				return;
			}
			if (!user) { s.msg = 'Sign in to save to a study.'; return; }
			if (!this.anaTree.length) return;
			const db = firebase.database();
			s.busy = true;
			try {
				const newKey = () => db.ref('studies').push().key;
				const chapterTitle = String(s.chapterTitle || '').trim().slice(0, STUDY_TITLE_MAX) || 'Chapter 1';
				const { nodes, count } = studyChapterNodes(this.anaTree, 0, user.uid, newKey);
				if (count > STUDY_MAX_NODES) { s.msg = 'The tree has ' + count + ' turns; a chapter holds ' + STUDY_MAX_NODES + '.'; return; }
				let sid, ch;
				if (s.target === 'new') {
					({ sid, ch } = await studyCreate(user, { title: s.title || 'Untitled study', visibility: s.visibility, chapterTitle, nodes }));
				} else {
					sid = s.target;
					const base = 'studies/' + sid;
					const listed = (await db.ref(base + '/chapterList').once('value')).val() || {};
					if (Object.keys(listed).length >= STUDY_MAX_CHAPTERS) { s.msg = 'That study is full (' + STUDY_MAX_CHAPTERS + ' chapters).'; return; }
					const order = Object.values(listed).reduce((m, c) => Math.max(m, (c && c.order) || 0), -1) + 1;
					ch = db.ref(base + '/chapterList').push().key;
					const u = {};
					u[base + '/chapterList/' + ch] = { title: chapterTitle, order, by: user.uid, created: studyTs() };
					for (const k of Object.keys(nodes)) u[base + '/chapters/' + ch + '/nodes/' + k] = nodes[k];
					u[base + '/meta/updated'] = studyTs();
					await db.ref().update(u);
				}
				window.location.href = 'analysis.html?study=' + encodeURIComponent(sid) + '&chapter=' + encodeURIComponent(ch);
			} catch (e) {
				s.msg = 'Not saved: ' + ((e && e.message) || e);
			} finally {
				s.busy = false;
			}
		},
	};
}

if (typeof module !== 'undefined' && module.exports) {
	module.exports = { studySilencedCode, studySilencedFromCode, studyMarksToList, studyListToMarks, studyOrderNodes, studyChapterNodes, studySlimTurn };
}
