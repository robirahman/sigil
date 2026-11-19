'use strict';
// Studies and classes in database.rules.json, against the Realtime Database
// emulator (run with rules.test.js: cd functions && npm run test:rules).

const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { ref, set, get, update, remove, serverTimestamp } = require('firebase/database');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
let env;

test.before(async () => {
	const [host, port] = (process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000').split(':');
	env = await initializeTestEnvironment({
		projectId: 'demo-sigil',
		database: { rules: RULES, host, port: Number(port) },
	});
});
test.after(() => env && env.cleanup());
test.beforeEach(() => env.clearDatabase());

const db = (uid, opts) => (uid ? env.authenticatedContext(uid, opts) : env.unauthenticatedContext()).database();
const guest = (uid) => db(uid, { firebase: { sign_in_provider: 'anonymous' } });
const seedAt = (p, v) => env.withSecurityRulesDisabled((ctx) => set(ref(ctx.database(), p), v));

const SFN = 'r............b........................./Starfall,Flourish,Carnage,Hail_Storm,Fireblast,Meteor,Seal_of_Summer,Sprout,Slash r 0 0:0 -:- -:- b1';
const T = () => serverTimestamp();

/** A new study by `owner` as study.js studyCreate writes it. */
function createUpdate(owner, sid, visibility, extra) {
	const u = {};
	u['studies/' + sid + '/meta'] = { title: 'Openings', owner, ownerName: 'Olga', visibility, created: T(), updated: T() };
	u['studies/' + sid + '/chapterList/c1'] = { title: 'Chapter 1', order: 0, by: owner, created: T() };
	u['studies/' + sid + '/chapters/c1/nodes/root'] = { sfn: SFN, by: owner, at: T() };
	u['user_studies/' + owner + '/' + sid] = { title: 'Openings', role: 'owner', at: T() };
	if (visibility === 'public') u['study_index/' + sid] = { title: 'Openings', ownerName: 'Olga', owner, updated: T(), chapters: 1 };
	return Object.assign(u, extra || {});
}

test('studies: an account creates one in a single write; guests cannot; nobody takes over another', async () => {
	await assertSucceeds(update(ref(db('olga')), createUpdate('olga', 's1', 'unlisted')));
	await assertFails(update(ref(guest('gina')), createUpdate('gina', 's2', 'unlisted')));
	// Someone else's id, or their meta.
	await assertFails(update(ref(db('mallory')), createUpdate('mallory', 's1', 'unlisted')));
	await assertFails(set(ref(db('mallory'), 'studies/s1/meta/owner'), 'mallory'));
	await assertFails(set(ref(db('mallory'), 'studies/s1/meta/title'), 'Mine now'));
	// A meta claiming another owner, or a created time from the past.
	await assertFails(update(ref(db('mallory')), createUpdate('olga', 's3', 'unlisted')));
	const back = createUpdate('olga', 's4', 'unlisted');
	back['studies/s4/meta'].created = 5;
	await assertFails(update(ref(db('olga')), back));
	// A public study needs its listing to be public, and only public ones are listed.
	await assertSucceeds(update(ref(db('olga')), createUpdate('olga', 's5', 'public')));
	const listed = createUpdate('olga', 's6', 'unlisted');
	listed['study_index/s6'] = { title: 'Openings', ownerName: 'Olga', owner: 'olga', updated: T(), chapters: 1 };
	await assertFails(update(ref(db('olga')), listed));
	// Turning a public study private must take it off the list in the same write.
	await assertFails(set(ref(db('olga'), 'studies/s5/meta/visibility'), 'private'));
	await assertSucceeds(update(ref(db('olga')), { 'studies/s5/meta/visibility': 'private', 'study_index/s5': null }));
});

test('studies: who reads them (public, unlisted, private) and the public list', async () => {
	await update(ref(db('olga')), createUpdate('olga', 'pub', 'public'));
	await update(ref(db('olga')), createUpdate('olga', 'unl', 'unlisted'));
	await update(ref(db('olga')), createUpdate('olga', 'prv', 'private'));
	await seedAt('studies/prv/members/vic', { role: 'viewer', name: 'Vic', at: 1 });
	await assertSucceeds(get(ref(db(null), 'studies/pub')));
	await assertSucceeds(get(ref(guest('gina'), 'studies/unl/chapters/c1')));
	await assertFails(get(ref(db('mallory'), 'studies/prv/meta')));
	await assertFails(get(ref(db(null), 'studies/prv')));
	await assertSucceeds(get(ref(db('vic'), 'studies/prv')));
	await assertSucceeds(get(ref(db('olga'), 'studies/prv')));
	// Not listable; the index is.
	await assertFails(get(ref(db('olga'), 'studies')));
	await assertSucceeds(get(ref(db(null), 'study_index')));
	// A player's list is theirs.
	await assertSucceeds(get(ref(db('olga'), 'user_studies/olga')));
	await assertFails(get(ref(db('vic'), 'user_studies/olga')));
	// The invite tokens: the owner's only.
	await assertSucceeds(set(ref(db('olga'), 'study_secrets/prv'), { editor: 'e'.repeat(24), viewer: 'v'.repeat(24) }));
	await assertSucceeds(get(ref(db('olga'), 'study_secrets/prv')));
	await assertFails(get(ref(db('vic'), 'study_secrets/prv')));
	await assertFails(set(ref(db('vic'), 'study_secrets/prv'), { editor: 'x'.repeat(24), viewer: 'y'.repeat(24) }));
	await assertFails(get(ref(db('vic'), 'study_joins/prv')));
});

test('studies: an invite link makes a member only with its token, and a viewer cannot become an editor', async () => {
	await update(ref(db('olga')), createUpdate('olga', 's', 'private'));
	await set(ref(db('olga'), 'study_secrets/s'), { editor: 'E'.repeat(24), viewer: 'V'.repeat(24) });
	const join = (uid, role, token, ctx) => {
		const u = {};
		u['study_joins/s/' + uid] = token;
		u['studies/s/members/' + uid] = { role, name: 'X', at: T() };
		u['user_studies/' + uid + '/s'] = { title: 'Openings', role, at: T() };
		return update(ref(ctx || db(uid)), u);
	};
	await assertFails(join('mallory', 'editor', 'wrong'.repeat(5)));
	await assertFails(join('mallory', 'editor', 'V'.repeat(24)));
	await assertSucceeds(join('vic', 'viewer', 'V'.repeat(24)));
	// Guests may follow a link too.
	await assertSucceeds(join('gina', 'editor', 'E'.repeat(24), guest('gina')));
	// The viewer cannot raise their own role without the editor token.
	await assertFails(set(ref(db('vic'), 'studies/s/members/vic/role'), 'editor'));
	await assertFails(set(ref(db('vic'), 'studies/s/members/vic'), { role: 'editor', name: 'Vic', at: T() }));
	// Nor make anyone else a member.
	await assertFails(set(ref(db('vic'), 'studies/s/members/mallory'), { role: 'viewer', name: 'M', at: T() }));
	// Without tokens at all (none made yet) nobody joins by themselves.
	await update(ref(db('olga')), createUpdate('olga', 't', 'private'));
	const u = {};
	u['studies/t/members/mallory'] = { role: 'editor', name: 'M', at: T() };
	await assertFails(update(ref(db('mallory')), u));
	// The owner invites by name and removes; a member leaves.
	await assertSucceeds(update(ref(db('olga')), {
		'studies/s/members/ed': { role: 'editor', name: 'Ed', at: T() },
		'user_studies/ed/s': { title: 'Openings', role: 'editor', at: T() },
	}));
	await assertFails(set(ref(db('olga'), 'studies/s/members/olga'), { role: 'editor', name: 'Olga', at: T() }));
	await assertFails(set(ref(db('olga'), 'user_studies/ed/s'), { title: 'Openings', role: 'owner', at: T() }));
	await assertSucceeds(remove(ref(db('olga'), 'studies/s/members/gina')));
	await assertSucceeds(remove(ref(db('vic'), 'studies/s/members/vic')));
	await assertFails(remove(ref(db('vic'), 'studies/s/members/ed')));
});

test('studies: editors change the tree, chapters and symbols; viewers and strangers cannot', async () => {
	await update(ref(db('olga')), createUpdate('olga', 's', 'public'));
	await update(ref(db('olga')), {
		'studies/s/members/ed': { role: 'editor', name: 'Ed', at: 1 },
		'studies/s/members/vic': { role: 'viewer', name: 'Vic', at: 1 },
	});
	const node = (by, extra) => Object.assign({ p: 'root', sfn: SFN.replace(' 0 ', ' 1 '), t: JSON.stringify({ color: 'red', turnNumber: 1, kind: 'input', actions: ['a2', 'pass'] }), by, at: T() }, extra || {});
	await assertSucceeds(update(ref(db('ed')), { 'studies/s/chapters/c1/nodes/n1': node('ed'), 'studies/s/meta/updated': T() }));
	await assertFails(set(ref(db('vic'), 'studies/s/chapters/c1/nodes/n2'), node('vic')));
	await assertFails(set(ref(db('mallory'), 'studies/s/chapters/c1/nodes/n2'), node('mallory')));
	await assertFails(set(ref(db('vic'), 'studies/s/meta/updated'), T()));
	// The shape: a parent that exists, the author's own uid, nothing else.
	await assertFails(set(ref(db('ed'), 'studies/s/chapters/c1/nodes/n3'), node('ed', { p: 'nope' })));
	await assertFails(set(ref(db('ed'), 'studies/s/chapters/c1/nodes/n3'), node('olga')));
	await assertFails(set(ref(db('ed'), 'studies/s/chapters/c1/nodes/n3'), node('ed', { extra: 1 })));
	await assertFails(set(ref(db('ed'), 'studies/s/chapters/c1/nodes/n3'), node('ed', { t: 'x'.repeat(7000) })));
	// A child and its parent in one write.
	await assertSucceeds(update(ref(db('ed')), {
		'studies/s/chapters/c1/nodes/n4': node('ed', { p: 'n1' }),
		'studies/s/chapters/c1/nodes/n5': node('ed', { p: 'n4' }),
	}));
	// Symbols and marks; the position and parent of a node never change.
	await assertSucceeds(set(ref(db('ed'), 'studies/s/chapters/c1/nodes/n1/g'), '!?'));
	await assertFails(set(ref(db('ed'), 'studies/s/chapters/c1/nodes/n1/g'), '!!!'));
	await assertFails(set(ref(db('vic'), 'studies/s/chapters/c1/nodes/n1/g'), '?'));
	await assertSucceeds(set(ref(db('olga'), 'studies/s/chapters/c1/nodes/n1/m'), { 'a1-b2': 'green', 'c3-c3': 'red' }));
	await assertFails(set(ref(db('olga'), 'studies/s/chapters/c1/nodes/n1/m'), { 'a1-b2': 'purple' }));
	await assertFails(set(ref(db('olga'), 'studies/s/chapters/c1/nodes/n1/m'), { '<script>': 'green' }));
	await assertFails(set(ref(db('ed'), 'studies/s/chapters/c1/nodes/n1/sfn'), SFN));
	await assertFails(set(ref(db('ed'), 'studies/s/chapters/c1/nodes/n1/p'), 'n4'));
	// Chapters.
	await assertSucceeds(update(ref(db('ed')), {
		'studies/s/chapterList/c2': { title: 'Endgames', order: 1, by: 'ed', created: T() },
		'studies/s/chapters/c2/nodes/root': { sfn: SFN, by: 'ed', at: T() },
	}));
	await assertFails(set(ref(db('vic'), 'studies/s/chapterList/c3'), { title: 'Mine', order: 2, by: 'vic', created: T() }));
	await assertSucceeds(set(ref(db('ed'), 'studies/s/chapterList/c2/title'), 'Endings'));
	// Deleting turns with their comments.
	await assertFails(set(ref(db('vic'), 'studies/s/notes/c1/n5/vic'), { text: 'hm', name: 'Vic', at: T() }));
	await assertSucceeds(set(ref(db('ed'), 'studies/s/notes/c1/n5/ed'), { text: 'Why not a3?', name: 'Ed', at: T() }));
	await assertFails(remove(ref(db('ed'), 'studies/s/notes/c1/n5')));
	await assertSucceeds(update(ref(db('ed')), {
		'studies/s/chapters/c1/nodes/n4': null, 'studies/s/chapters/c1/nodes/n5': null, 'studies/s/notes/c1/n5': null,
	}));
	// Deleting a chapter.
	await assertFails(update(ref(db('vic')), { 'studies/s/chapterList/c2': null, 'studies/s/chapters/c2': null }));
	await assertSucceeds(update(ref(db('ed')), { 'studies/s/chapterList/c2': null, 'studies/s/chapters/c2': null, 'studies/s/notes/c2': null }));
	// Only the owner deletes the study.
	await assertFails(remove(ref(db('ed'), 'studies/s')));
	await assertSucceeds(update(ref(db('olga')), { 'studies/s': null, 'study_secrets/s': null, 'study_index/s': null, 'study_joins/s': null, 'user_studies/olga/s': null }));
});

test('studies: comments are their author\'s; the owner may remove any', async () => {
	await update(ref(db('olga')), createUpdate('olga', 's', 'unlisted'));
	await update(ref(db('olga')), {
		'studies/s/members/ed': { role: 'editor', name: 'Ed', at: 1 },
		'studies/s/members/eve': { role: 'editor', name: 'Eve', at: 1 },
	});
	const note = (text) => ({ text, name: 'Ed', at: T() });
	await assertSucceeds(set(ref(db('ed'), 'studies/s/notes/c1/root/ed'), note('A sharp start.')));
	await assertFails(set(ref(db('eve'), 'studies/s/notes/c1/root/ed'), note('Ed says hi')));
	await assertFails(remove(ref(db('eve'), 'studies/s/notes/c1/root/ed')));
	await assertFails(set(ref(db('ed'), 'studies/s/notes/c1/root/ed'), note('x'.repeat(2001))));
	await assertFails(set(ref(db('ed'), 'studies/s/notes/c1/nonode/ed'), note('On nothing')));
	await assertSucceeds(remove(ref(db('olga'), 'studies/s/notes/c1/root/ed')));
});

test('studies: presence is per uid, only where the study can be read', async () => {
	await update(ref(db('olga')), createUpdate('olga', 'pub', 'unlisted'));
	await update(ref(db('olga')), createUpdate('olga', 'prv', 'private'));
	await assertSucceeds(set(ref(guest('gina'), 'study_presence/pub/gina'), { name: 'Guest', ch: 'c1', at: T() }));
	await assertFails(set(ref(guest('gina'), 'study_presence/pub/olga'), { name: 'Olga', at: T() }));
	await assertFails(set(ref(db('mallory'), 'study_presence/prv/mallory'), { name: 'M', at: T() }));
	await assertFails(get(ref(db('mallory'), 'study_presence/prv')));
	await assertSucceeds(get(ref(db(null), 'study_presence/pub')));
});

// ---------------- classes ----------------

function classUpdate(teacher, cid, code) {
	const u = {};
	u['classes/' + cid + '/info'] = { name: 'Tuesday club', teacher, teacherName: 'Tess', created: T() };
	u['classes/' + cid + '/code'] = code;
	u['class_codes/' + code] = { cid, name: 'Tuesday club', teacherName: 'Tess' };
	u['user_classes/' + teacher + '/' + cid] = { name: 'Tuesday club', role: 'teacher', at: T() };
	return u;
}
function joinUpdate(uid, cid, code) {
	const u = {};
	u['classes/' + cid + '/members/' + uid] = { name: uid, joined: T(), code };
	u['user_classes/' + uid + '/' + cid] = { name: 'Tuesday club', role: 'student', at: T() };
	return u;
}

test('classes: a teacher with an account creates one; students join only with its code', async () => {
	await assertSucceeds(update(ref(db('tess')), classUpdate('tess', 'k1', 'ABC123')));
	await assertFails(update(ref(guest('gina')), classUpdate('gina', 'k2', 'GUEST1')));
	// A code is the class's: another teacher cannot take it over.
	await assertFails(update(ref(db('mallory')), classUpdate('mallory', 'k3', 'ABC123')));
	await assertFails(set(ref(db('mallory'), 'classes/k1/info/name'), 'Mine'));
	await assertSucceeds(update(ref(db('sam')), joinUpdate('sam', 'k1', 'ABC123')));
	await assertFails(update(ref(db('sue')), joinUpdate('sue', 'k1', 'WRONG1')));
	await assertFails(update(ref(guest('gina')), joinUpdate('gina', 'k1', 'ABC123')));
	// Nobody adds someone else; the teacher is not their own student.
	await assertFails(update(ref(db('tess')), joinUpdate('sue', 'k1', 'ABC123')));
	await assertFails(update(ref(db('tess')), joinUpdate('tess', 'k1', 'ABC123')));
	// A list entry claims only a class one is in.
	await assertFails(set(ref(db('sue'), 'user_classes/sue/k1'), { name: 'Tuesday club', role: 'student', at: T() }));
	await assertFails(set(ref(db('sam'), 'user_classes/sam/k1'), { name: 'Tuesday club', role: 'teacher', at: T() }));
	// Anyone signed in reads a code (to see what they join), not the list of codes.
	await assertSucceeds(get(ref(db('sue'), 'class_codes/ABC123')));
	await assertFails(get(ref(db('sue'), 'class_codes')));
	await assertFails(get(ref(db(null), 'class_codes/ABC123')));
	// A new code: the teacher's only.
	await assertSucceeds(update(ref(db('tess')), { 'class_codes/ABC123': null, 'class_codes/XYZ789': { cid: 'k1', name: 'Tuesday club', teacherName: 'Tess' }, 'classes/k1/code': 'XYZ789' }));
	await assertFails(update(ref(db('sue')), joinUpdate('sue', 'k1', 'ABC123')));
	await assertFails(set(ref(db('mallory'), 'class_codes/XYZ789'), null));
});

test('classes: students see the class and their own entry, never each other; the teacher sees all', async () => {
	await update(ref(db('tess')), classUpdate('tess', 'k', 'ABC123'));
	await update(ref(db('sam')), joinUpdate('sam', 'k', 'ABC123'));
	await update(ref(db('sue')), joinUpdate('sue', 'k', 'ABC123'));
	await assertSucceeds(get(ref(db('tess'), 'classes/k/members')));
	await assertSucceeds(get(ref(db('tess'), 'classes/k/code')));
	await assertSucceeds(get(ref(db('sam'), 'classes/k/info')));
	await assertSucceeds(get(ref(db('sam'), 'classes/k/members/sam')));
	await assertFails(get(ref(db('sam'), 'classes/k/members')));
	await assertFails(get(ref(db('sam'), 'classes/k/members/sue')));
	await assertFails(get(ref(db('sam'), 'classes/k/code')));
	await assertFails(get(ref(db('sam'), 'classes/k')));
	await assertFails(get(ref(db('mallory'), 'classes/k/info')));
	await assertFails(get(ref(db('mallory'), 'classes/k/assignments')));
	await assertFails(get(ref(db('sam'), 'user_classes/sue')));
});

test('classes: assignments are the teacher\'s; each student marks their own done', async () => {
	await update(ref(db('tess')), classUpdate('tess', 'k', 'ABC123'));
	await update(ref(db('sam')), joinUpdate('sam', 'k', 'ABC123'));
	await update(ref(db('sue')), joinUpdate('sue', 'k', 'ABC123'));
	const puzzles = { kind: 'puzzles', title: 'Mates in one', puzzles: { '-OpR7rVvVhnRGqacO-p9-t16': 0, 'p2': 1 }, created: T() };
	await assertSucceeds(set(ref(db('tess'), 'classes/k/assignments/a1'), puzzles));
	await assertFails(set(ref(db('sam'), 'classes/k/assignments/a2'), puzzles));
	await assertFails(set(ref(db('tess'), 'classes/k/assignments/a3'), { kind: 'puzzles', title: 'None', created: T() }));
	await assertSucceeds(set(ref(db('tess'), 'classes/k/assignments/a4'), { kind: 'link', title: 'Lesson 3', url: 'tutorial.html?lesson=3', created: T() }));
	await assertFails(set(ref(db('tess'), 'classes/k/assignments/a5'), { kind: 'link', title: 'Elsewhere', url: 'https://example.com/x.html', created: T() }));
	await assertFails(set(ref(db('tess'), 'classes/k/assignments/a5'), { kind: 'link', title: 'Script', url: 'javascript:alert(1)', created: T() }));
	await assertSucceeds(set(ref(db('tess'), 'classes/k/assignments/a6'), { kind: 'study', title: 'Read this', study: 'stud1', created: T() }));
	await assertSucceeds(get(ref(db('sam'), 'classes/k/assignments')));
	await assertSucceeds(set(ref(db('sam'), 'classes/k/done/a4/sam'), T()));
	await assertFails(set(ref(db('sam'), 'classes/k/done/a4/sue'), T()));
	await assertFails(set(ref(db('sam'), 'classes/k/done/nope/sam'), T()));
	await assertFails(set(ref(db('mallory'), 'classes/k/done/a4/mallory'), T()));
	await assertSucceeds(get(ref(db('tess'), 'classes/k/done/a4')));
	await assertSucceeds(get(ref(db('sam'), 'classes/k/done/a4/sam')));
	await assertFails(get(ref(db('sam'), 'classes/k/done/a4')));
	await assertFails(get(ref(db('sue'), 'classes/k/done/a4/sam')));
});

test('classes: students leave, the teacher removes them or closes the class', async () => {
	await update(ref(db('tess')), classUpdate('tess', 'k', 'ABC123'));
	await update(ref(db('sam')), joinUpdate('sam', 'k', 'ABC123'));
	await update(ref(db('sue')), joinUpdate('sue', 'k', 'ABC123'));
	await assertSucceeds(update(ref(db('sam')), { 'classes/k/members/sam': null, 'user_classes/sam/k': null }));
	await assertFails(remove(ref(db('sam'), 'classes/k/members/sue')));
	await assertSucceeds(remove(ref(db('tess'), 'classes/k/members/sue')));
	await assertFails(remove(ref(db('sue'), 'classes/k')));
	await assertSucceeds(update(ref(db('tess')), { 'classes/k': null, 'class_codes/ABC123': null, 'user_classes/tess/k': null }));
});
