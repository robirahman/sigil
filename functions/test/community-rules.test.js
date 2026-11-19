'use strict';
// The community rules (database.rules.json: messages, inbox, forums, blogs,
// teams, content reports) against the Realtime Database emulator:
//   cd functions && npm run test:rules

const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const assert = require('assert');
const { ref, set, get, update, remove, serverTimestamp } = require('firebase/database');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
let env;

test.before(async () => {
	const [host, port] = (process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000').split(':');
	// Its own project, so its database is not rules.test.js's: node --test
	// runs the files at once and each clears its database between tests.
	env = await initializeTestEnvironment({
		projectId: 'demo-sigil-community',
		database: { rules: RULES, host, port: Number(port) },
	});
});
test.after(() => env && env.cleanup());
test.beforeEach(() => env.clearDatabase());

const TS = serverTimestamp();
// A signed-in account (the rules tell a guest by its sign-in provider).
const db = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'password' } }).database();
const guest = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).database();
const seed = (data) => env.withSecurityRulesDisabled((ctx) => update(ref(ctx.database()), data));
const read = async (p) => { let v; await env.withSecurityRulesDisabled(async (ctx) => { v = (await get(ref(ctx.database(), p))).val(); }); return v; };
const profile = (name) => ({ displayName: name, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: 1 });
const people = () => seed({ 'users/alice': profile('Alice'), 'users/bob': profile('Bob'), 'users/carol': profile('Carol'), 'users/dave': profile('Dave') });
// A first write under a rate limit (the window starts now).
const lim = (uid, kind) => ({ ['rate_limits/' + uid + '/' + kind]: { at: TS, n: 1, since: TS } });
const clearLimits = (uid) => seed({ ['rate_limits/' + uid]: null });

// ---- Private messages ----

// What community.js sendMessage writes.
function message(from, to, mid, text, first) {
	const cid = from < to ? from + '_' + to : to + '_' + from;
	const u = Object.assign({
		['dm_messages/' + cid + '/' + mid]: { from, to, text, at: TS },
		['dm_index/' + from + '/' + cid + '/with']: to,
		['dm_index/' + from + '/' + cid + '/last']: TS,
		['dm_index/' + from + '/' + cid + '/lastFrom']: from,
		['dm_index/' + from + '/' + cid + '/lastMsg']: mid,
		['dm_index/' + from + '/' + cid + '/read']: TS,
		['dm_index/' + to + '/' + cid + '/with']: from,
		['dm_index/' + to + '/' + cid + '/last']: TS,
		['dm_index/' + to + '/' + cid + '/lastFrom']: from,
		['dm_index/' + to + '/' + cid + '/lastMsg']: mid,
	}, lim(from, 'dm'));
	if (first) Object.assign(u, { ['dm_convos/' + cid]: { a: from < to ? from : to, b: from < to ? to : from, at: TS } }, lim(from, 'dmnew'));
	return u;
}

test('messages: a conversation, read only by its two members', async () => {
	await people();
	const cid = 'alice_bob';
	await assertFails(update(ref(guest('alice')), message('alice', 'bob', 'm1', 'hi', true)));
	// The conversation is created with its first message.
	await assertFails(update(ref(db('alice')), message('alice', 'bob', 'm1', 'hi', false)));
	await assertSucceeds(update(ref(db('alice')), message('alice', 'bob', 'm1', 'hi', true)));
	await assertSucceeds(get(ref(db('bob'), 'dm_messages/' + cid)));
	await assertSucceeds(get(ref(db('alice'), 'dm_convos/' + cid)));
	await assertFails(get(ref(db('carol'), 'dm_messages/' + cid)));
	await assertFails(get(ref(db('carol'), 'dm_index/bob')));
	await assertSucceeds(get(ref(db('bob'), 'dm_index/bob')));
	// Too soon after the last one (one a second), then fine.
	await assertFails(update(ref(db('alice')), message('alice', 'bob', 'm2', 'again', false)));
	await clearLimits('alice');
	await assertSucceeds(update(ref(db('alice')), message('alice', 'bob', 'm2', 'again', false)));
	await assertSucceeds(update(ref(db('bob')), message('bob', 'alice', 'm3', 'hello', false)));
	// Not as someone else, not to a third player, not without the indexes.
	await assertFails(update(ref(db('carol')), message('carol', 'bob', 'mc', 'x', false)));
	await clearLimits('alice');
	const forged = message('alice', 'bob', 'm4', 'x', false);
	forged['dm_messages/' + cid + '/m4'].from = 'bob';
	await assertFails(update(ref(db('alice')), forged));
	const noIndex = message('alice', 'bob', 'm4', 'x', false);
	delete noIndex['dm_index/bob/' + cid + '/lastMsg'];
	await assertFails(update(ref(db('alice')), noIndex));
	// Too long.
	await assertFails(update(ref(db('alice')), message('alice', 'bob', 'm4', 'x'.repeat(2001), false)));
	// Messages are never edited.
	await assertFails(set(ref(db('alice'), 'dm_messages/' + cid + '/m1/text'), 'edited'));
	// A conversation id must be the sorted pair.
	await clearLimits('carol');
	const bad = message('carol', 'alice', 'm5', 'x', true);
	bad['dm_convos/alice_carol'] = { a: 'carol', b: 'alice', at: TS };
	await assertFails(update(ref(db('carol')), bad));
	// The index: bob marks it read; alice cannot bump it without a message.
	await assertSucceeds(set(ref(db('bob'), 'dm_index/bob/' + cid + '/read'), TS));
	await assertFails(set(ref(db('bob'), 'dm_index/bob/' + cid + '/read'), 5));
	await assertFails(set(ref(db('alice'), 'dm_index/bob/' + cid + '/read'), TS));
	await assertFails(update(ref(db('alice'), 'dm_index/bob/' + cid), { last: TS, lastFrom: 'alice' }));
	// Bob removes it from his list; the next message brings it back.
	await assertSucceeds(remove(ref(db('bob'), 'dm_index/bob/' + cid)));
	await clearLimits('alice');
	await assertSucceeds(update(ref(db('alice')), message('alice', 'bob', 'm6', 'still there?', false)));
	assert.strictEqual((await read('dm_index/bob/' + cid)).lastMsg, 'm6');
});

test('messages: blocks, the recipient\'s setting and mutes', async () => {
	await people();
	await seed({ 'blocks/bob/alice': true });
	await assertFails(update(ref(db('alice')), message('alice', 'bob', 'm1', 'hi', true)));
	await assertFails(update(ref(db('bob')), message('bob', 'alice', 'm1', 'hi', true)));
	await seed({ 'blocks/bob/alice': null, 'community_prefs/bob/dm': 'follows' });
	await clearLimits('alice');
	await assertFails(update(ref(db('alice')), message('alice', 'bob', 'm1', 'hi', true)));
	// Nor by opening an empty conversation first and writing into it.
	await assertFails(update(ref(db('alice')), Object.assign({ 'dm_convos/alice_bob': { a: 'alice', b: 'bob', at: TS } }, lim('alice', 'dmnew'))));
	await seed({ 'follows/bob/alice': true });
	await assertSucceeds(update(ref(db('alice')), message('alice', 'bob', 'm1', 'hi', true)));
	// Bob started nothing, but a started conversation goes on.
	await seed({ 'follows/bob/alice': null });
	await clearLimits('alice');
	await assertSucceeds(update(ref(db('alice')), message('alice', 'bob', 'm2', 'hi', false)));
	await seed({ 'community_prefs/bob/dm': 'none' });
	await clearLimits('alice');
	await assertFails(update(ref(db('alice')), message('alice', 'bob', 'm3', 'hi', false)));
	// A muted player sends nothing until the mute ends.
	await seed({ 'community_prefs/bob/dm': null, 'community_mutes/alice': { until: Date.now() + 60000, by: 'admin', at: 1 } });
	await clearLimits('alice');
	await assertFails(update(ref(db('alice')), message('alice', 'bob', 'm3', 'hi', false)));
	await seed({ 'community_mutes/alice/until': Date.now() - 1000 });
	await clearLimits('alice');
	await assertSucceeds(update(ref(db('alice')), message('alice', 'bob', 'm3', 'hi', false)));
	// No messages to an AI or a deleted account.
	await seed({ 'users/__ai_rust_hard__': profile('Hard AI'), 'deleted_users/dave': 1 });
	await clearLimits('carol');
	await assertFails(update(ref(db('carol')), message('carol', 'dave', 'm1', 'hi', true)));
	// Every message counts against the hourly allowance.
	await seed({ 'rate_limits/carol/dm': { at: 1, n: 200, since: Date.now() - 1000 } });
	await assertFails(update(ref(db('carol')), Object.assign(message('carol', 'bob', 'm1', 'hi', true),
		{ 'rate_limits/carol/dm': { at: TS, n: 201, since: Date.now() - 1000 } })));
});

test('messages: a reported message opens its conversation to the admins', async () => {
	await people();
	await seed({ 'admins/carol': true });
	await assertSucceeds(update(ref(db('alice')), message('alice', 'bob', 'm1', 'rude words', true)));
	await assertFails(get(ref(db('carol'), 'dm_messages/alice_bob')));
	const report = (by, target, msg) => ({
		['content_reports/r1']: { by, target, kind: 'dm', conv: 'alice_bob', msg, reason: 'abuse', at: TS },
		['dm_flags/alice_bob/' + msg]: TS,
		['report_limits/' + by]: TS,
	});
	// Only its recipient reports it, about its sender.
	await assertFails(update(ref(db('alice')), report('alice', 'bob', 'm1')));
	await assertFails(update(ref(db('bob')), report('bob', 'carol', 'm1')));
	await assertFails(update(ref(db('carol')), report('carol', 'alice', 'm1')));
	await assertSucceeds(update(ref(db('bob')), report('bob', 'alice', 'm1')));
	await assertSucceeds(get(ref(db('carol'), 'dm_messages/alice_bob')));
	await assertSucceeds(get(ref(db('carol'), 'content_reports')));
	await assertFails(get(ref(db('bob'), 'content_reports')));
	// Admins resolve it; the report itself stays as filed.
	await assertSucceeds(update(ref(db('carol'), 'content_reports/r1'), { resolved: true, resolvedBy: 'carol', resolvedAt: TS, adminNote: 'muted', action: 'muted' }));
	await assertFails(update(ref(db('carol'), 'content_reports/r1'), { target: 'bob' }));
	await assertFails(update(ref(db('bob'), 'content_reports/r1'), { resolved: false }));
	// The admins' access ends with the flag.
	await assertSucceeds(remove(ref(db('carol'), 'dm_flags/alice_bob')));
	await assertFails(get(ref(db('carol'), 'dm_messages/alice_bob')));
});

// ---- Inbox ----

test('inbox: server-written, the owner marks read or clears', async () => {
	await people();
	await seed({ 'notifications/alice/n1': { type: 'follow', actor: 'bob', at: 5 } });
	await assertFails(set(ref(db('bob'), 'notifications/alice/n2'), { type: 'follow', actor: 'bob', at: 5 }));
	await assertFails(set(ref(db('alice'), 'notifications/alice/n2'), { type: 'follow', actor: 'bob', at: 5 }));
	await assertFails(get(ref(db('bob'), 'notifications/alice')));
	await assertSucceeds(get(ref(db('alice'), 'notifications/alice')));
	await assertSucceeds(set(ref(db('alice'), 'notifications/alice/n1/read'), true));
	await assertFails(set(ref(db('alice'), 'notifications/alice/n1/type'), 'game'));
	// No stub from a read mark on a removed entry.
	await assertFails(set(ref(db('alice'), 'notifications/alice/n9/read'), true));
	await assertSucceeds(remove(ref(db('alice'), 'notifications/alice/n1')));
	await assertSucceeds(remove(ref(db('alice'), 'notifications/alice')));
	// Settings: push types and who may message.
	await assertSucceeds(set(ref(db('alice'), 'notify_prefs/alice'), { forum: false, message: true }));
	await assertFails(set(ref(db('alice'), 'notify_prefs/alice/nonsense'), true));
	await assertFails(set(ref(db('bob'), 'notify_prefs/alice/forum'), true));
	await assertSucceeds(set(ref(db('alice'), 'community_prefs/alice/dm'), 'follows'));
	await assertFails(set(ref(db('alice'), 'community_prefs/alice/dm'), 'friends'));
	await assertFails(set(ref(guest('alice'), 'community_prefs/alice/dm'), 'none'));
	// The push switch is the admins'.
	await seed({ 'admins/carol': true });
	await assertFails(set(ref(db('alice'), 'community_config/push'), true));
	await assertSucceeds(set(ref(db('carol'), 'community_config/push'), true));
	await assertSucceeds(get(ref(guest('x'), 'community_config/push')));
});

// ---- Forums ----

function newThread(uid, cat, tid, pid, title, text) {
	return Object.assign({
		['forum_threads/' + cat + '/' + tid]: { title, by: uid, at: TS, lastAt: TS, lastBy: uid, lastPost: pid },
		['forum_posts/' + cat + '/' + tid + '/' + pid]: { by: uid, at: TS, text },
	}, lim(uid, 'forum'));
}
function reply(uid, cat, tid, pid, text) {
	return Object.assign({
		['forum_posts/' + cat + '/' + tid + '/' + pid]: { by: uid, at: TS, text },
		['forum_threads/' + cat + '/' + tid + '/lastAt']: TS,
		['forum_threads/' + cat + '/' + tid + '/lastBy']: uid,
		['forum_threads/' + cat + '/' + tid + '/lastPost']: pid,
	}, lim(uid, 'forum'));
}

test('forums: threads, replies, edits and removals', async () => {
	await people();
	await assertFails(update(ref(guest('alice')), newThread('alice', 'general', 't1', 'p1', 'Hello there', 'First!')));
	await assertFails(update(ref(db('alice')), newThread('alice', 'nonsense', 't1', 'p1', 'Hello there', 'First!')));
	await assertFails(update(ref(db('alice')), newThread('alice', 'general', 't1', 'p1', 'Hi', 'title too short')));
	await assertSucceeds(update(ref(db('alice')), newThread('alice', 'general', 't1', 'p1', 'Hello there', 'First!')));
	// Anyone reads, guests too.
	await assertSucceeds(get(ref(guest('g'), 'forum_threads/general')));
	await assertSucceeds(get(ref(guest('g'), 'forum_posts/general/t1')));
	// A reply moves the thread's last post with it.
	await assertSucceeds(update(ref(db('bob')), reply('bob', 'general', 't1', 'p2', 'Welcome')));
	await clearLimits('bob');
	const noBump = reply('bob', 'general', 't1', 'p3', 'x');
	delete noBump['forum_threads/general/t1/lastPost'];
	await assertFails(update(ref(db('bob')), noBump));
	// Bumping without a post, or as someone else.
	await assertFails(update(ref(db('bob'), 'forum_threads/general/t1'), { lastAt: TS, lastBy: 'bob' }));
	await assertFails(update(ref(db('bob')), Object.assign(reply('bob', 'general', 't1', 'p3', 'x'), { 'forum_posts/general/t1/p3': { by: 'alice', at: TS, text: 'x' } })));
	// The reply count is the server's.
	await assertFails(set(ref(db('alice'), 'forum_threads/general/t1/replies'), 99));
	// Edits: the author's, with the time.
	await assertSucceeds(update(ref(db('bob'), 'forum_posts/general/t1/p2'), { text: 'Welcome!', editedAt: TS }));
	await assertFails(update(ref(db('bob'), 'forum_posts/general/t1/p2'), { text: 'Welcome!!' }));
	await assertFails(update(ref(db('alice'), 'forum_posts/general/t1/p2'), { text: 'hacked', editedAt: TS }));
	await assertFails(update(ref(db('bob'), 'forum_posts/general/t1/p2'), { by: 'alice', editedAt: TS }));
	// The title: its author's (or a moderator's).
	await assertFails(set(ref(db('bob'), 'forum_threads/general/t1/title'), 'Bob was here'));
	await assertSucceeds(set(ref(db('alice'), 'forum_threads/general/t1/title'), 'Hello everyone'));
	// Removal: the text goes, the post stays as a stub.
	await assertFails(update(ref(db('alice'), 'forum_posts/general/t1/p2'), { text: null, removed: { by: 'alice', at: TS } }));
	await assertSucceeds(update(ref(db('bob'), 'forum_posts/general/t1/p2'), { text: null, editedAt: null, removed: { by: 'bob', at: TS } }));
	await assertFails(update(ref(db('bob'), 'forum_posts/general/t1/p2'), { text: 'back', removed: null, editedAt: TS }));
	await assertFails(remove(ref(db('alice'), 'forum_posts/general/t1/p1')));
	// Pin and lock are the moderators'.
	await assertFails(set(ref(db('alice'), 'forum_threads/general/t1/locked'), true));
	await seed({ 'forum_mods/carol': true });
	await assertSucceeds(set(ref(db('carol'), 'forum_threads/general/t1/locked'), true));
	await assertSucceeds(set(ref(db('carol'), 'forum_threads/general/t1/pinned'), true));
	// Deleting the flag is no way around it.
	await assertFails(remove(ref(db('bob'), 'forum_threads/general/t1/locked')));
	await assertFails(remove(ref(db('bob'), 'forum_threads/general/t1/pinned')));
	await assertFails(update(ref(db('bob')), Object.assign(reply('bob', 'general', 't1', 'p4', 'unlocked?'), { 'forum_threads/general/t1/locked': null })));
	await clearLimits('bob');
	await assertFails(update(ref(db('bob')), reply('bob', 'general', 't1', 'p4', 'locked out')));
	await assertFails(update(ref(db('alice'), 'forum_posts/general/t1/p1'), { text: 'edit while locked', editedAt: TS }));
	await clearLimits('carol');
	await assertSucceeds(update(ref(db('carol')), reply('carol', 'general', 't1', 'p4', 'Locked: see the rules.')));
	// A moderator removes anyone's post, and deletes the thread with its posts.
	await assertSucceeds(update(ref(db('carol'), 'forum_posts/general/t1/p1'), { text: null, removed: { by: 'carol', at: TS } }));
	await assertFails(remove(ref(db('carol'), 'forum_threads/general/t1')));
	await assertFails(remove(ref(db('alice'), 'forum_posts/general/t1')));
	await assertSucceeds(update(ref(db('carol')), { 'forum_threads/general/t1': null, 'forum_posts/general/t1': null }));
});

test('forums: rate limits, announcements, team forums and mutes', async () => {
	await people();
	await assertSucceeds(update(ref(db('alice')), newThread('alice', 'general', 't1', 'p1', 'One', 'a')));
	// Ten seconds between posts.
	await assertFails(update(ref(db('alice')), Object.assign(newThread('alice', 'general', 't2', 'p2', 'Two', 'b'),
		{ 'rate_limits/alice/forum': { at: TS, n: 2, since: (await read('rate_limits/alice/forum')).since } })));
	// Thirty an hour.
	await seed({ 'rate_limits/alice/forum': { at: 1, n: 30, since: Date.now() - 60000 } });
	await assertFails(update(ref(db('alice')), Object.assign(newThread('alice', 'general', 't2', 'p2', 'Two', 'b'),
		{ 'rate_limits/alice/forum': { at: TS, n: 31, since: Date.now() - 60000 } })));
	// The window restarts after an hour.
	await seed({ 'rate_limits/alice/forum': { at: 1, n: 30, since: Date.now() - 3700000 } });
	await assertSucceeds(update(ref(db('alice')), newThread('alice', 'general', 't2', 'p2', 'Two', 'b')));
	// Nobody else writes your limiter, or resets it.
	await assertFails(set(ref(db('bob'), 'rate_limits/alice/forum'), { at: TS, n: 1, since: TS }));
	await assertFails(remove(ref(db('alice'), 'rate_limits/alice/forum')));
	// Announcements: moderators start them, anyone replies.
	await assertFails(update(ref(db('bob')), newThread('bob', 'announcements', 'a1', 'q1', 'News', 'x')));
	await seed({ 'admins/carol': true });
	await assertSucceeds(update(ref(db('carol')), newThread('carol', 'announcements', 'a1', 'q1', 'News', 'x')));
	await assertSucceeds(update(ref(db('bob')), reply('bob', 'announcements', 'a1', 'q2', 'Thanks')));
	// A team's forum: its members post, its staff moderate.
	await seed({ 'teams/red-team': { name: 'Red Team', leader: 'dave', created: 1, open: true }, 'team_members/red-team/dave': { role: 'leader', joined: 1, by: 'dave' } });
	await clearLimits('bob');
	await assertFails(update(ref(db('bob')), newThread('bob', 'team:red-team', 'x1', 'y1', 'Team talk', 'x')));
	await assertFails(update(ref(db('bob')), newThread('bob', 'team:blue-team', 'x1', 'y1', 'No such team', 'x')));
	await seed({ 'team_members/red-team/bob': { role: 'member', joined: 1, by: 'bob' } });
	await assertSucceeds(update(ref(db('bob')), newThread('bob', 'team:red-team', 'x1', 'y1', 'Team talk', 'x')));
	await assertSucceeds(set(ref(db('dave'), 'forum_threads/team:red-team/x1/pinned'), true));
	await assertFails(set(ref(db('alice'), 'forum_threads/team:red-team/x1/pinned'), false));
	// Muted: no posts.
	await seed({ 'community_mutes/bob': { until: Date.now() + 60000, by: 'carol', at: 1 } });
	await clearLimits('bob');
	await assertFails(update(ref(db('bob')), reply('bob', 'general', 't1', 'p9', 'muted')));
});

// ---- Blogs ----

function blogPost(uid, pid, extra) {
	return Object.assign({ ['blog_posts/' + pid]: Object.assign({ by: uid, title: 'My first post', body: '**Hello**', at: TS }, extra || {}) }, lim(uid, 'blog'));
}

test('blogs: posts, the site blog and comments', async () => {
	await people();
	await seed({ 'admins/carol': true });
	await assertFails(update(ref(guest('alice')), blogPost('alice', 'b1')));
	await assertSucceeds(update(ref(db('alice')), blogPost('alice', 'b1')));
	await assertSucceeds(get(ref(guest('g'), 'blog_posts/b1')));
	// The site blog is the admins'.
	await assertFails(update(ref(db('bob')), blogPost('bob', 'b2', { site: true })));
	await assertSucceeds(update(ref(db('carol')), blogPost('carol', 'b2', { site: true })));
	// Edits: the author's, stamped; never as or into another's.
	await assertSucceeds(update(ref(db('alice'), 'blog_posts/b1'), { body: 'Edited', editedAt: TS }));
	await assertFails(update(ref(db('alice'), 'blog_posts/b1'), { body: 'Edited again' }));
	await assertFails(update(ref(db('bob'), 'blog_posts/b1'), { body: 'Mine now', editedAt: TS }));
	await assertFails(update(ref(db('alice'), 'blog_posts/b1'), { site: true, editedAt: TS }));
	await assertFails(update(ref(db('alice'), 'blog_posts/b1'), { body: 'x'.repeat(40001), editedAt: TS }));
	// Comments: one each 5 s, not when the author turned them off or blocked you.
	const comment = (uid, cid, text) => Object.assign({ ['blog_comments/b1/' + cid]: { by: uid, text, at: TS } }, lim(uid, 'comment'));
	await assertSucceeds(update(ref(db('bob')), comment('bob', 'c1', 'Nice')));
	await assertFails(update(ref(db('bob')), comment('dave', 'c2', 'As dave')));
	await assertFails(update(ref(db('bob'), 'blog_comments/b1/c1'), { text: 'edited' }));
	await seed({ 'blocks/alice/dave': true });
	await assertFails(update(ref(db('dave')), comment('dave', 'c3', 'blocked')));
	await assertSucceeds(update(ref(db('alice'), 'blog_posts/b1'), { comments: false, editedAt: TS }));
	await assertFails(update(ref(db('carol')), comment('carol', 'c4', 'closed')));
	// Comments are removed by their writer, the post's author or a moderator.
	await assertSucceeds(remove(ref(db('alice'), 'blog_comments/b1/c1')));
	await seed({ 'blog_comments/b1/c5': { by: 'bob', text: 'x', at: 1 } });
	await assertFails(remove(ref(db('dave'), 'blog_comments/b1/c5')));
	// A post goes with its comments.
	await assertFails(remove(ref(db('alice'), 'blog_posts/b1')));
	await assertFails(update(ref(db('bob')), { 'blog_posts/b1': null, 'blog_comments/b1': null }));
	await assertSucceeds(update(ref(db('alice')), { 'blog_posts/b1': null, 'blog_comments/b1': null }));
	// An admin removes anyone's.
	await clearLimits('bob');
	await assertSucceeds(update(ref(db('bob')), blogPost('bob', 'b3')));
	await assertSucceeds(update(ref(db('carol')), { 'blog_posts/b3': null, 'blog_comments/b3': null }));
});

test('content reports: each kind names the real author', async () => {
	await people();
	await seed({
		'forum_threads/general/t1': { title: 'Hello', by: 'alice', at: 1, lastAt: 1, lastBy: 'alice', lastPost: 'p1' },
		'forum_posts/general/t1/p1': { by: 'alice', at: 1, text: 'spam spam' },
		'blog_posts/b1': { by: 'bob', title: 'Post', body: 'x', at: 1 },
		'blog_comments/b1/c1': { by: 'dave', text: 'spam', at: 1 },
	});
	const rep = (by, body) => ({ ['content_reports/r_' + by]: Object.assign({ by, reason: 'spam', at: TS }, body), ['report_limits/' + by]: TS });
	await assertSucceeds(update(ref(db('carol')), rep('carol', { kind: 'forum', target: 'alice', cat: 'general', thread: 't1', post: 'p1', note: 'Advertising' })));
	await assertFails(update(ref(db('bob')), rep('bob', { kind: 'forum', target: 'carol', cat: 'general', thread: 't1', post: 'p1' })));
	await assertSucceeds(update(ref(db('alice')), rep('alice', { kind: 'blog', target: 'bob', post: 'b1' })));
	await assertSucceeds(update(ref(db('bob')), rep('bob', { kind: 'comment', target: 'dave', post: 'b1', comment: 'c1' })));
	await assertFails(update(ref(guest('g')), rep('g', { kind: 'blog', target: 'bob', post: 'b1' })));
	// Yourself, a made-up kind, a bad reason, the one-a-minute limit.
	await assertFails(update(ref(db('dave')), rep('dave', { kind: 'comment', target: 'dave', post: 'b1', comment: 'c1' })));
	await assertFails(update(ref(db('dave')), rep('dave', { kind: 'profile', target: 'bob', post: 'b1' })));
	await assertFails(update(ref(db('dave')), rep('dave', { kind: 'blog', target: 'bob', post: 'b1', reason: 'boring' })));
	await assertFails(update(ref(db('carol')), { 'content_reports/r_carol2': { by: 'carol', kind: 'blog', target: 'bob', post: 'b1', reason: 'spam', at: TS }, 'report_limits/carol': TS }));
});

// ---- Teams ----

const founding = (uid, tid, open) => Object.assign({
	['teams/' + tid]: { name: 'The ' + tid, leader: uid, created: TS, open, description: 'We play.' },
	['team_members/' + tid + '/' + uid]: { role: 'leader', joined: TS, by: uid },
	['user_teams/' + uid + '/' + tid]: true,
}, lim(uid, 'team'));
const joining = (uid, tid, by) => ({
	['team_members/' + tid + '/' + uid]: { role: 'member', joined: TS, by: by || uid },
	['user_teams/' + uid + '/' + tid]: true,
});

test('teams: found, join, leave, staff and leadership', async () => {
	await people();
	await assertFails(update(ref(guest('alice')), founding('alice', 'reds', true)));
	await assertFails(update(ref(db('alice')), founding('alice', 'Bad Id', true)));
	await assertSucceeds(update(ref(db('alice')), founding('alice', 'reds', true)));
	// The id is taken.
	await assertFails(update(ref(db('bob')), founding('bob', 'reds', true)));
	// The member count is the server's.
	await assertFails(set(ref(db('alice'), 'teams/reds/memberCount'), 50));
	// Open: join and leave freely, both halves together.
	await assertSucceeds(update(ref(db('bob')), joining('bob', 'reds')));
	await assertFails(update(ref(db('carol')), { 'team_members/reds/carol': { role: 'member', joined: TS, by: 'carol' } }));
	await assertFails(update(ref(db('carol')), Object.assign(joining('carol', 'reds'), { 'team_members/reds/carol': { role: 'mod', joined: TS, by: 'carol' } })));
	await assertFails(update(ref(db('carol')), joining('dave', 'reds')));
	await assertSucceeds(update(ref(db('carol')), joining('carol', 'reds')));
	await assertSucceeds(update(ref(db('carol')), { 'team_members/reds/carol': null, 'user_teams/carol/reds': null }));
	// Staff: the leader makes bob a moderator; a moderator removes plain members only.
	await assertFails(set(ref(db('bob'), 'team_members/reds/bob/role'), 'mod'));
	await assertSucceeds(set(ref(db('alice'), 'team_members/reds/bob/role'), 'mod'));
	await assertFails(set(ref(db('alice'), 'team_members/reds/bob/role'), 'leader'));
	await assertSucceeds(update(ref(db('carol')), joining('carol', 'reds')));
	await assertSucceeds(update(ref(db('bob')), { 'team_members/reds/carol': null, 'user_teams/carol/reds': null, 'team_bans/reds/carol': TS }));
	await assertFails(update(ref(db('carol')), joining('carol', 'reds')));
	await assertFails(update(ref(db('bob')), { 'team_members/reds/alice': null, 'user_teams/alice/reds': null }));
	// The leader cannot just leave; they hand over first.
	await assertFails(update(ref(db('alice')), { 'team_members/reds/alice': null, 'user_teams/alice/reds': null }));
	await assertFails(update(ref(db('bob')), { 'teams/reds/leader': 'bob', 'team_members/reds/bob/role': 'leader', 'team_members/reds/alice/role': 'member' }));
	// Handing over without stepping down is refused (two leaders).
	await assertFails(update(ref(db('alice')), { 'teams/reds/leader': 'bob', 'team_members/reds/bob/role': 'leader' }));
	await assertSucceeds(update(ref(db('alice')), { 'teams/reds/leader': 'bob', 'team_members/reds/bob/role': 'leader', 'team_members/reds/alice/role': 'member' }));
	await assertSucceeds(update(ref(db('alice')), { 'team_members/reds/alice': null, 'user_teams/alice/reds': null }));
	// Edits: staff only, the fields the rules know.
	await assertSucceeds(update(ref(db('bob'), 'teams/reds'), { description: 'New text', open: false }));
	await assertFails(update(ref(db('carol'), 'teams/reds'), { description: 'Hijacked' }));
	await assertFails(update(ref(db('bob'), 'teams/reds'), { created: 5 }));
	await assertFails(remove(ref(db('bob'), 'teams/reds')));
});

test('teams: requests to join a closed team', async () => {
	await people();
	await assertSucceeds(update(ref(db('alice')), founding('alice', 'blues', false)));
	await assertFails(update(ref(db('bob')), joining('bob', 'blues')));
	const ask = (uid) => Object.assign({ ['team_requests/blues/' + uid]: { at: TS, message: 'Let me in' } }, lim(uid, 'team'));
	await assertSucceeds(update(ref(db('bob')), ask('bob')));
	await assertFails(get(ref(db('carol'), 'team_requests/blues')));
	await assertSucceeds(get(ref(db('alice'), 'team_requests/blues')));
	await assertSucceeds(get(ref(db('bob'), 'team_requests/blues/bob')));
	// Staff admit only a player who asked, and not one whose account is
	// being deleted.
	await assertFails(update(ref(db('alice')), joining('carol', 'blues', 'alice')));
	await seed({ 'team_requests/blues/dave': { at: 1 }, 'deleted_users/dave': 1 });
	await assertFails(update(ref(db('alice')), joining('dave', 'blues', 'alice')));
	await assertSucceeds(update(ref(db('alice')), Object.assign(joining('bob', 'blues', 'alice'), { 'team_requests/blues/bob': null })));
	// Nobody else adds you.
	await assertFails(update(ref(db('bob')), joining('carol', 'blues', 'bob')));
});

test('team battles: a leader hosts, invited leaders accept before the start', async () => {
	await people();
	await assertSucceeds(update(ref(db('alice')), founding('alice', 'reds', true)));
	await clearLimits('alice');
	await assertSucceeds(update(ref(db('bob')), founding('bob', 'blues', true)));
	await assertSucceeds(update(ref(db('carol')), joining('carol', 'reds')));
	const now = Date.now();
	const battle = (uid, extra) => Object.assign({ ['team_battles/tb1']: Object.assign({
		name: 'Reds vs Blues', host: 'reds', by: uid, created: TS, start: now + 3600000, end: now + 3 * 3600000, topN: 5,
		teams: { reds: 'accepted', blues: 'invited' },
	}, extra || {}) }, lim(uid, 'team'));
	await assertFails(update(ref(db('carol')), battle('carol')));
	await assertFails(update(ref(db('alice')), battle('alice', { teams: { reds: 'accepted', blues: 'accepted' } })));
	await assertFails(update(ref(db('alice')), battle('alice', { end: now + 3600000 + 60000 })));
	await assertFails(update(ref(db('alice')), battle('alice', { topN: 0 })));
	await assertFails(update(ref(db('alice')), battle('alice', { teams: { reds: 'accepted', nobody: 'invited' } })));
	await assertSucceeds(update(ref(db('alice')), battle('alice')));
	// Only the battle's teams' own leaders answer; nothing else changes.
	await assertFails(set(ref(db('alice'), 'team_battles/tb1/teams/blues'), 'accepted'));
	await assertFails(set(ref(db('carol'), 'team_battles/tb1/teams/blues'), 'accepted'));
	await assertSucceeds(set(ref(db('bob'), 'team_battles/tb1/teams/blues'), 'accepted'));
	await assertFails(remove(ref(db('bob'), 'team_battles/tb1/teams/blues')));
	await assertFails(set(ref(db('bob'), 'team_battles/tb1/teams/reds'), 'declined'));
	await assertFails(set(ref(db('alice'), 'team_battles/tb1/start'), now + 60000));
	await assertFails(set(ref(db('alice'), 'team_battles/tb1/finished'), true));
	// The host's leader cancels it before the start.
	await assertFails(remove(ref(db('bob'), 'team_battles/tb1')));
	await assertSucceeds(remove(ref(db('alice'), 'team_battles/tb1')));
	// Scores are the server's.
	await assertFails(set(ref(db('alice'), 'team_battle_scores/tb1/players/alice'), { points: 9 }));
});
