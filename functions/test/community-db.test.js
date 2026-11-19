'use strict';
// community.js against the Realtime Database emulator (admin rights, as the
// functions run; pushes go to a stub):
//   firebase emulators:exec --only database --project demo-sigil 'node --test test/community-db.test.js'

const test = require('node:test');
const assert = require('node:assert');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getDatabaseWithUrl } = require('firebase-admin/database');
const community = require('../community');

const app = initializeApp({ projectId: 'demo-sigil' }, 'community-db');
const db = getDatabaseWithUrl('https://community-db-test.firebaseio.com', app);
test.after(() => deleteApp(app));
test.beforeEach(() => db.ref().set(null));

const HOUR = 3_600_000;
const profile = (name) => ({ displayName: name, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: 1 });
const get = async (p) => (await db.ref(p).once('value')).val();

// A stand-in for FCM: records each push, every token alive.
function stubSend() {
	const sent = [];
	const send = async (tokens, message) => { sent.push({ tokens, message }); return tokens.map(() => ({ success: true })); };
	return { sent, send };
}

async function people() {
	await db.ref().update({
		'users/alice': profile('Alice'), 'users/bob': profile('Bob'), 'users/carol': profile('Carol'), 'users/dave': profile('Dave'),
		'push_tokens/alice/t1': { token: 'tok-alice', created: 1 },
		'push_tokens/bob/t1': { token: 'tok-bob', created: 1 },
	});
}

test('inbox: written once per subject, pushed only when switched on', async () => {
	await people();
	const { sent, send } = stubSend();
	await db.ref('follows/bob/alice').set(true);
	await community.onFollow(db, 'alice', 'bob', 1000, send);
	assert.deepStrictEqual(await get('notifications/alice/follow-bob'), { type: 'follow', actor: 'bob', at: 1000 });
	// The site switch is off: no push.
	assert.strictEqual(sent.length, 0);
	await db.ref('community_config/push').set(true);
	const DAY = 86_400_000;
	await community.onFollow(db, 'alice', 'bob', 1000 + DAY + 1, send);
	assert.strictEqual(sent.length, 1);
	assert.deepStrictEqual(sent[0].tokens, ['tok-alice']);
	assert.strictEqual(sent[0].message.data.title, 'New follower');
	assert.match(sent[0].message.data.body, /Bob follows you/);
	// Unfollow and follow again: the entry moves, no second push that day.
	await community.onFollow(db, 'alice', 'bob', 5000 + DAY, send);
	assert.strictEqual(sent.length, 1);
	assert.strictEqual((await get('notifications/alice/follow-bob')).at, 5000 + DAY);
	// Turned off by the player, for that type only.
	await db.ref('notify_prefs/alice/follow').set(false);
	await community.onFollow(db, 'alice', 'bob', 10 * DAY, send);
	assert.strictEqual(sent.length, 1);
	// An unfollow before the event: nothing new.
	await db.ref('follows/carol/alice').set(null);
	assert.strictEqual(await community.onFollow(db, 'alice', 'carol', 4000, send), null);
	// Blocked actors, AIs and deleted accounts are never told or telling.
	await db.ref('blocks/alice/dave').set(true);
	assert.strictEqual(await community.notify(db, 'alice', 'x', { type: 'follow', actor: 'dave', at: 1 }), null);
	assert.strictEqual(await community.notify(db, '__ai_rust_hard__', 'x', { type: 'follow', actor: 'bob', at: 1 }), null);
	await db.ref('deleted_users/carol').set(1);
	assert.strictEqual(await community.notify(db, 'carol', 'x', { type: 'follow', actor: 'bob', at: 1 }), null);
	// Collapsed entries count unread repeats, and start over once read; only
	// the first unread one is pushed.
	const p = { title: 'Reply', body: 'x' };
	const before = sent.length;
	await community.notify(db, 'bob', 'forum-t1', { type: 'forum', actor: 'alice', at: 1 }, { collapse: true, send, push: p });
	await community.notify(db, 'bob', 'forum-t1', { type: 'forum', actor: 'carol', at: 2 }, { collapse: true, send, push: p });
	assert.strictEqual((await get('notifications/bob/forum-t1')).n, 2);
	assert.strictEqual(sent.length, before + 1);
	await db.ref('notifications/bob/forum-t1/read').set(true);
	await community.notify(db, 'bob', 'forum-t1', { type: 'forum', actor: 'dave', at: 3 }, { collapse: true, send, push: p });
	const e = await get('notifications/bob/forum-t1');
	assert.deepStrictEqual([e.n, e.actor, e.read], [1, 'dave', undefined]);
	assert.strictEqual(sent.length, before + 2);
});

test('challenges and messages', async () => {
	await people();
	const { sent, send } = stubSend();
	await db.ref('challenges/bob/ROOM1').set({ from: 'alice', at: 5 });
	await community.onChallenge(db, 'bob', 'ROOM1', 10);
	assert.deepStrictEqual(await get('notifications/bob/challenge-ROOM1'), { type: 'challenge', actor: 'alice', room: 'ROOM1', at: 10 });
	await db.ref('community_config/push').set(true);
	const msg = { from: 'alice', to: 'bob', text: 'Hello Bob, '.repeat(30), at: 1 };
	await community.onMessage(db, 'alice_bob', 'm1', msg, send);
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].message.data.title, 'Message from Alice');
	assert.ok(sent[0].message.data.body.length <= 120);
	assert.strictEqual(sent[0].message.data.url, 'inbox.html?tab=messages&c=alice_bob');
	// Messages are not inbox entries.
	assert.strictEqual(await get('notifications/bob/m1'), null);
	await db.ref('blocks/bob/alice').set(true);
	await community.onMessage(db, 'alice_bob', 'm2', msg, send);
	await db.ref('notify_prefs/alice/message').set(false);
	await community.onMessage(db, 'alice_bob', 'm3', { from: 'bob', to: 'alice', text: 'x', at: 2 }, send);
	assert.strictEqual(sent.length, 1);
});

test('forums: the reply count, and who is told of a reply', async () => {
	await people();
	await db.ref().update({
		'forum_threads/general/t1': { title: 'Openings', by: 'alice', at: 1, lastAt: 3, lastBy: 'carol', lastPost: 'p3' },
		'forum_posts/general/t1': {
			p1: { by: 'alice', at: 1, text: 'What do you open with?' },
			p2: { by: 'bob', at: 2, text: 'Sprout.' },
			p3: { by: 'carol', at: 3, text: 'Charge!' },
		},
	});
	// The first post: a thread, nobody to tell.
	const first = await community.onForumPost(db, 'general', 't1', 'p1', { by: 'alice', at: 1, text: 'x' }, 10);
	assert.deepStrictEqual(first, { replies: 2, told: 0 });
	assert.strictEqual(await get('forum_threads/general/t1/replies'), 2);
	const res = await community.onForumPost(db, 'general', 't1', 'p3', { by: 'carol', at: 3, text: 'Charge!' }, 20);
	assert.strictEqual(res.told, 2);
	const a = await get('notifications/alice/forum-t1');
	assert.deepStrictEqual([a.type, a.actor, a.cat, a.thread, a.post, a.title, a.n], ['forum', 'carol', 'general', 't1', 'p3', 'Openings', 1]);
	assert.ok(await get('notifications/bob/forum-t1'));
	assert.strictEqual(await get('notifications/carol/forum-t1'), null);
	// A blog comment tells the post's author, not the commenter.
	await db.ref('blog_posts/b1').set({ by: 'bob', title: 'My games', body: 'x', at: 1 });
	await community.onBlogComment(db, 'b1', 'c1', { by: 'alice', text: 'Nice', at: 2 }, 30);
	assert.strictEqual((await get('notifications/bob/blog-b1')).actor, 'alice');
	assert.strictEqual(await community.onBlogComment(db, 'b1', 'c2', { by: 'bob', text: 'Thanks', at: 3 }, 31), null);
});

test('teams: the member count, requests, acceptance and roles', async () => {
	await people();
	await db.ref().update({
		'teams/reds': { name: 'Reds', leader: 'alice', created: 1, open: false },
		'team_members/reds/alice': { role: 'leader', joined: 1, by: 'alice' },
		'team_members/reds/carol': { role: 'mod', joined: 2, by: 'carol' },
		'user_teams/alice/reds': true, 'user_teams/carol/reds': true,
		'team_requests/reds/bob': { at: 5, message: 'hi' },
	});
	assert.strictEqual(await community.onTeamRequest(db, 'reds', 'bob', 10), 2);
	const r = await get('notifications/carol/teamreq-reds');
	assert.deepStrictEqual([r.event, r.actor, r.teamName], ['request', 'bob', 'Reds']);
	// Admitted by the leader.
	const joined = { role: 'member', joined: 20, by: 'alice' };
	await db.ref().update({ 'team_members/reds/bob': joined, 'user_teams/bob/reds': true, 'team_requests/reds/bob': null });
	await community.onTeamMember(db, 'reds', 'bob', null, joined, 21);
	assert.strictEqual(await get('teams/reds/memberCount'), 3);
	assert.strictEqual((await get('notifications/bob/team-reds')).event, 'accepted');
	// Promoted.
	await community.onTeamMember(db, 'reds', 'bob', joined, Object.assign({}, joined, { role: 'mod' }), 22);
	const p = await get('notifications/bob/team-reds');
	assert.deepStrictEqual([p.event, p.role], ['role', 'mod']);
	// Joining an open team alone tells nobody.
	await community.onTeamMember(db, 'reds', 'dave', null, { role: 'member', joined: 30, by: 'dave' }, 31);
	assert.strictEqual(await get('notifications/dave'), null);
});

test('team battles: scored games, the start, the result', async () => {
	await people();
	const now = Date.now();
	await db.ref().update({
		'teams/reds': { name: 'Reds', leader: 'alice', created: 1, open: true },
		'teams/blues': { name: 'Blues', leader: 'bob', created: 1, open: true },
		'team_members/reds/alice': { role: 'leader', joined: 1, by: 'alice' },
		'team_members/reds/carol': { role: 'member', joined: 2, by: 'carol' },
		'team_members/blues/bob': { role: 'leader', joined: 1, by: 'bob' },
		// Dave is in both: he plays for the one he joined first.
		'team_members/blues/dave': { role: 'member', joined: 3, by: 'dave' },
		'team_members/reds/dave': { role: 'member', joined: 9, by: 'dave' },
		'user_teams/alice/reds': true, 'user_teams/carol/reds': true, 'user_teams/bob/blues': true,
		'user_teams/dave/blues': true, 'user_teams/dave/reds': true,
		'team_battles/tb1': { name: 'Reds vs Blues', host: 'reds', by: 'alice', created: now - 2 * HOUR, start: now - HOUR, end: now + HOUR, topN: 1, teams: { reds: 'accepted', blues: 'accepted' } },
		// Another battle, over before these games.
		'team_battles/old': { name: 'Old', host: 'reds', by: 'alice', created: 1, start: now - 5 * HOUR, end: now - 4 * HOUR, topN: 3, teams: { reds: 'accepted', blues: 'accepted' } },
	});
	assert.strictEqual(await community.onBattleCreated(db, 'tb1', Object.assign({}, await get('team_battles/tb1'), { teams: { reds: 'accepted', blues: 'invited' } }), now), 1);
	assert.strictEqual((await get('notifications/bob/battleinv-tb1')).event, 'invite');
	const game = (opp, result, extra) => Object.assign({ timestamp: now, opponentUid: opp, opponent: opp, rated: true, result, color: 'red', opponentIsAI: false }, extra || {});
	// Alice beats Bob: a point for the reds.
	assert.deepStrictEqual(await community.scoreGame(db, 'alice', 'g1', game('bob', 'win')), [{ battle: 'tb1', team: 'reds', win: true }]);
	assert.deepStrictEqual(await community.scoreGame(db, 'bob', 'g1', game('alice', 'loss')), [{ battle: 'tb1', team: 'blues', win: false }]);
	// Counted once, however often the event comes.
	await community.scoreGame(db, 'alice', 'g1', game('bob', 'win'));
	assert.strictEqual(await get('team_battle_scores/tb1/players/alice/points'), 1);
	assert.strictEqual(await get('team_battle_scores/tb1/players/alice/games'), 1);
	// Teammates, unrated games, AIs and games outside the battle don't count.
	assert.deepStrictEqual(await community.scoreGame(db, 'alice', 'g2', game('carol', 'win')), []);
	assert.deepStrictEqual(await community.scoreGame(db, 'alice', 'g3', game('bob', 'win', { rated: false })), []);
	assert.deepStrictEqual(await community.scoreGame(db, 'alice', 'g4', game('__ai_rust_hard__', 'win', { opponentIsAI: true })), []);
	assert.deepStrictEqual(await community.scoreGame(db, 'alice', 'g5', game('bob', 'win', { timestamp: now + 2 * HOUR })), []);
	// Dave scores for the blues (joined first), against Carol of the reds.
	assert.deepStrictEqual(await community.scoreGame(db, 'dave', 'g6', game('carol', 'win')), [{ battle: 'tb1', team: 'blues', win: true }]);
	await community.scoreGame(db, 'dave', 'g7', game('alice', 'win'));
	// The start is announced once, to both teams' members (and the old
	// battle, never closed, is closed).
	const tick = await community.battleTick(db, now, null);
	assert.deepStrictEqual(tick, { started: 1, finished: 1 });
	assert.strictEqual((await get('notifications/carol/battle-tb1')).event, 'battle-start');
	assert.deepStrictEqual(await community.battleTick(db, now + 1000, null), { started: 0, finished: 0 });
	// The end: top 1 counts, so blues (Dave, 2) beat reds (Alice, 1).
	const end = await community.battleTick(db, now + 2 * HOUR, null);
	assert.deepStrictEqual(end, { started: 0, finished: 1 });
	const result = await get('team_battles/tb1/result');
	assert.deepStrictEqual(result.standings.map((s) => [s.team, s.score]), [['blues', 2], ['reds', 1]]);
	const n = await get('notifications/alice/battle-tb1');
	assert.deepStrictEqual([n.event, n.winner, n.winnerName], ['battle-end', 'blues', 'Blues']);
	// No game counts after the battle closed.
	assert.deepStrictEqual(await community.scoreGame(db, 'bob', 'g8', game('alice', 'win')), []);
});

test('a correspondence result goes to the inbox; a realtime one does not', async () => {
	await people();
	await db.ref().update({
		'rooms/CORR1/timeControl': { type: 'correspondence', moveTimeout: 86400000 },
		'rooms/LIVE1/timeControl': { type: 'realtime', initialTime: 300000, increment: 0 },
	});
	const entry = (room) => ({ roomCode: room, timestamp: 1, opponent: 'Bob', opponentUid: 'bob', result: 'win', rated: true, eloChange: 12 });
	await community.onUserGame(db, 'alice', 'g1', entry('CORR1'), 50, null);
	const n = await get('notifications/alice/game-g1');
	assert.deepStrictEqual([n.type, n.result, n.opponent, n.eloChange, n.room], ['game', 'win', 'Bob', 12, 'CORR1']);
	await community.onUserGame(db, 'alice', 'g2', entry('LIVE1'), 50, null);
	assert.strictEqual(await get('notifications/alice/game-g2'), null);
});

test('disbanding a team, and deleting an account', async () => {
	await people();
	const now = Date.now();
	await db.ref().update({
		'teams/reds': { name: 'Reds', leader: 'alice', created: 1, open: true },
		'team_members/reds/alice': { role: 'leader', joined: 1, by: 'alice' },
		'team_members/reds/bob': { role: 'member', joined: 2, by: 'bob' },
		'user_teams/alice/reds': true, 'user_teams/bob/reds': true,
		'forum_threads/team:reds/t1': { title: 'Hi', by: 'bob', at: 1, lastAt: 1, lastBy: 'bob', lastPost: 'p1' },
		'forum_posts/team:reds/t1/p1': { by: 'bob', at: 1, text: 'x' },
		'team_battles/soon': { name: 'Soon', host: 'reds', by: 'alice', created: 1, start: now + HOUR, end: now + 3 * HOUR, topN: 3, teams: { reds: 'accepted' } },
	});
	await assert.rejects(community.disbandTeam(db, 'reds', 'bob', now), /Only the leader/);
	await assert.rejects(community.disbandTeam(db, 'nope', 'alice', now), /No such team/);
	assert.strictEqual(await community.disbandTeam(db, 'reds', 'alice', now), 2);
	for (const p of ['teams/reds', 'team_members/reds', 'user_teams/bob', 'forum_threads/team:reds', 'team_battles/soon']) assert.strictEqual(await get(p), null, p);

	// Deletion: alice leads a team with others, talks to bob, blogs, is in the inbox.
	await db.ref().update({
		'teams/blues': { name: 'Blues', leader: 'alice', created: 1, open: true },
		'team_members/blues/alice': { role: 'leader', joined: 1, by: 'alice' },
		'team_members/blues/bob': { role: 'member', joined: 3, by: 'bob' },
		'team_members/blues/carol': { role: 'mod', joined: 5, by: 'carol' },
		'teams/solo': { name: 'Solo', leader: 'alice', created: 1, open: true },
		'team_members/solo/alice': { role: 'leader', joined: 1, by: 'alice' },
		'user_teams/alice': { blues: true, solo: true }, 'user_teams/bob/blues': true, 'user_teams/carol/blues': true,
		'dm_convos/alice_bob': { a: 'alice', b: 'bob', at: 1 },
		'dm_messages/alice_bob/m1': { from: 'alice', to: 'bob', text: 'hi', at: 1 },
		'dm_index/alice/alice_bob': { with: 'bob', last: 1, lastFrom: 'alice', lastMsg: 'm1' },
		'dm_index/bob/alice_bob': { with: 'alice', last: 1, lastFrom: 'alice', lastMsg: 'm1' },
		'blog_posts/b1': { by: 'alice', title: 'Mine', body: 'x', at: 1 },
		'blog_comments/b1/c1': { by: 'bob', text: 'x', at: 2 },
		'blog_posts/b2': { by: 'bob', title: 'His', body: 'x', at: 1 },
		'blog_comments/b2/c1': { by: 'alice', text: 'kept, nameless', at: 2 },
		'notifications/alice/n1': { type: 'follow', actor: 'bob', at: 1 },
	});
	const updates = { 'users/alice': null };
	await community.deletionUpdates(db, 'alice', updates);
	// One multi-path update, as deleteUserData sends it.
	await db.ref().update(updates);
	for (const p of ['dm_convos/alice_bob', 'dm_messages/alice_bob', 'dm_index/bob/alice_bob', 'dm_index/alice', 'blog_posts/b1', 'blog_comments/b1',
		'notifications/alice', 'teams/solo', 'team_members/solo', 'user_teams/alice', 'team_members/blues/alice']) assert.strictEqual(await get(p), null, p);
	// The moderator takes the team over.
	assert.strictEqual(await get('teams/blues/leader'), 'carol');
	assert.strictEqual(await get('team_members/blues/carol/role'), 'leader');
	assert.ok(await get('blog_comments/b2/c1'));
	assert.ok(await get('blog_posts/b2'));
});
