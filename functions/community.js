'use strict';
/**
 * The community's server side (index.js wires the triggers):
 *
 *   - the inbox, notifications/{uid}/{key}: one entry per thing to tell,
 *     written only here (the rules let the owner mark read or delete), and
 *     pushed to the player's browsers when the admins have turned inbox
 *     pushes on (community_config/push) and the player has not turned that
 *     type off (notify_prefs/{uid}/{type}). Keys are fixed per subject
 *     ("forum-{thread}"), so a retried event writes the same entry and a
 *     busy thread is one entry with a count.
 *   - private messages: a push to the recipient (the inbox does not list
 *     messages; inbox.html counts unread conversations itself).
 *   - forums: the reply count, and the thread's author and recent posters
 *     told of a reply. Blogs: the author told of a comment.
 *   - teams: the member count; join requests to the staff; acceptance and
 *     role changes to the player; battle invitations to the invited
 *     leaders; disbanding (disbandTeam).
 *   - team battles: the roster, each rated game scored (team-battle.js),
 *     and the start and the result announced to the teams (battleTick).
 *   - correspondence game results in the inbox.
 *   - account deletion: deletionUpdates.
 *
 * Other server code (tournaments, when there are some) tells a player
 * something with notify(db, uid, key, entry, { send, push }).
 */

const { AI_UID } = require('./rating');
const { sendPush } = require('./notify');
const { battleTeams, battleTeamOf, teamBattleStandings } = require('./engine-loader').requireShared('team-battle.js');

const PUSH_TTL_S = 24 * 3600;
// Events a collapsed inbox entry remembers (so a retried one counts once).
const EVENTS_KEPT = 20;
// Posters of a thread told of a reply, besides its author (the latest).
const THREAD_NOTIFY_MAX = 20;
// Members of a team told of a battle starting or ending.
const BATTLE_NOTIFY_MAX = 300;
// A battle is closed this long after its end: games that ended in time are
// still being recorded and rated (recordRoom waits, rateGame queues).
const BATTLE_GRACE_MS = 10 * 60000;
// A battleTick step not finished within this long is taken up again.
const CLAIM_MS = 10 * 60000;

const val = (db, p) => db.ref(p).once('value').then((s) => s.val());
const human = (uid) => typeof uid === 'string' && uid !== '' && uid !== 'deleted' && !AI_UID.test(uid);
const cut = (s, n) => {
	const t = String(s || '').replace(/\s+/g, ' ').trim();
	return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// ---- Inbox and push ----

/** May `uid` be pushed a `type` notice? The site switch, then their own. */
async function pushAllowed(db, uid, type) {
	const [on, pref] = await Promise.all([val(db, 'community_config/push'), val(db, 'notify_prefs/' + uid + '/' + type)]);
	return on === true && pref !== false;
}

/** Push {title, body, url, tag} to uid's browsers if allowed (sendPush). */
async function pushNotice(db, uid, type, p, send) {
	if (!send || !(await pushAllowed(db, uid, type))) return null;
	return sendPush(db, uid, {
		data: { title: p.title, body: p.body || '', url: p.url || 'inbox.html', tag: p.tag || 'sigil-inbox' },
		webpush: { headers: { Urgency: 'normal', TTL: String(PUSH_TTL_S) } },
	}, send);
}

/**
 * Write notifications/{uid}/{key} = entry (+ n, the count of unread repeats
 * when opts.collapse) and push opts.push. Nothing for an AI, a deleted
 * account, or when uid has blocked entry.actor. Resolves to the entry
 * written or null.
 *
 * A collapsed entry pushes only its first unread repeat (one push for a busy
 * thread until it is read); opts.quietMs pushes again only that long after
 * the entry's last write (a follow toggled on and off).
 */
async function notify(db, uid, key, entry, opts) {
	const o = opts || {};
	if (!human(uid) || entry.actor === uid) return null;
	const [deleted, blocked] = await Promise.all([
		val(db, 'deleted_users/' + uid),
		entry.actor ? val(db, 'blocks/' + uid + '/' + entry.actor) : null,
	]);
	if (deleted || blocked) return null;
	const ref = db.ref('notifications/' + uid + '/' + key);
	let written = Object.assign({}, entry);
	let fresh = true;
	if (o.collapse) {
		// o.event names the thing told (a post, a requester): a retried
		// event is counted once (the last EVENTS_KEPT are remembered).
		const ev = o.event ? String(o.event) : null;
		let repeat = false;
		const res = await ref.transaction((cur) => {
			const open = cur && !cur.read;
			repeat = !!(open && ev && cur.ev && cur.ev[ev]);
			if (repeat) return undefined;
			const seen = Object.assign({}, open ? cur.ev : null);
			if (ev) seen[ev] = entry.at;
			const keep = Object.keys(seen).sort((a, b) => seen[b] - seen[a]).slice(0, EVENTS_KEPT);
			return Object.assign({}, entry, { n: open ? (cur.n || 1) + 1 : 1, ev: keep.length ? Object.fromEntries(keep.map((k) => [k, seen[k]])) : null });
		});
		written = res.snapshot.val();
		fresh = !repeat && res.committed && (written && written.n) === 1;
	} else {
		if (o.quietMs) {
			const prev = await val(db, 'notifications/' + uid + '/' + key);
			fresh = !(prev && typeof prev.at === 'number' && prev.at > entry.at - o.quietMs);
		}
		await ref.set(entry);
	}
	if (o.push && fresh) await pushNotice(db, uid, entry.type, o.push, o.send).catch(() => null);
	return written;
}

// ---- Follows and challenges ----

async function onFollow(db, target, follower, now, send) {
	if (!(await val(db, 'follows/' + follower + '/' + target))) return null;
	const name = (await val(db, 'users/' + follower + '/displayName')) || 'A player';
	return notify(db, target, 'follow-' + follower, { type: 'follow', actor: follower, at: now }, {
		send, quietMs: 86400000, push: { title: 'New follower', body: name + ' follows you on Sigil.', url: 'profile.html?uid=' + encodeURIComponent(follower), tag: 'sigil-follow-' + follower },
	});
}

/** The inbox entry of a challenge (notify.js notifyChallenge pushes it). */
async function onChallenge(db, target, room, now) {
	const ch = await val(db, 'challenges/' + target + '/' + room);
	if (!ch || !human(ch.from)) return null;
	return notify(db, target, 'challenge-' + room, { type: 'challenge', actor: ch.from, room, at: now });
}

// ---- Private messages ----

async function onMessage(db, cid, mid, msg, send) {
	if (!msg || !human(msg.to) || !human(msg.from)) return null;
	// Read again: gone (the sender's account deleted since) means no push.
	const [still, deleted, blocked, name] = await Promise.all([
		val(db, 'dm_messages/' + cid + '/' + mid + '/from'),
		val(db, 'deleted_users/' + msg.from),
		val(db, 'blocks/' + msg.to + '/' + msg.from),
		val(db, 'users/' + msg.from + '/displayName'),
	]);
	if (still !== msg.from || deleted || blocked) return null;
	return pushNotice(db, msg.to, 'message', {
		title: 'Message from ' + (name || 'a player'),
		body: cut(msg.text, 120),
		url: 'inbox.html?tab=messages&c=' + encodeURIComponent(cid),
		tag: 'sigil-dm-' + cid,
	}, send);
}

// ---- Forums and blogs ----

/**
 * A new post: recount the thread's replies; on a reply, tell the thread's
 * author and its latest posters (THREAD_NOTIFY_MAX).
 */
async function onForumPost(db, cat, tid, pid, post, now, send) {
	const [thread, postsSnap] = await Promise.all([
		val(db, 'forum_threads/' + cat + '/' + tid),
		db.ref('forum_posts/' + cat + '/' + tid).once('value'),
	]);
	if (!thread || !post) return null;
	const posts = [];
	postsSnap.forEach((c) => { posts.push(Object.assign({ id: c.key }, c.val())); });
	await db.ref('forum_threads/' + cat + '/' + tid + '/replies').set(Math.max(0, posts.length - 1));
	const first = posts.reduce((a, p) => (!a || (p.at || 0) < (a.at || 0) ? p : a), null);
	if (!first || first.id === pid) return { replies: posts.length - 1, told: 0 };
	const recent = posts.filter((p) => p.id !== pid).sort((a, b) => (b.at || 0) - (a.at || 0)).map((p) => p.by);
	const tell = [...new Set([thread.by].concat(recent))].filter((u) => human(u) && u !== post.by).slice(0, THREAD_NOTIFY_MAX + 1);
	const name = (await val(db, 'users/' + post.by + '/displayName')) || 'A player';
	const url = 'forum.html?c=' + encodeURIComponent(cat) + '&t=' + encodeURIComponent(tid) + '#p-' + pid;
	let told = 0;
	for (const uid of tell) {
		const w = await notify(db, uid, 'forum-' + tid, { type: 'forum', actor: post.by, cat, thread: tid, post: pid, title: cut(thread.title, 120), at: now }, {
			send, collapse: true, event: pid, push: { title: 'Reply in “' + cut(thread.title, 60) + '”', body: name + ': ' + cut(post.text, 100), url, tag: 'sigil-forum-' + tid },
		});
		if (w) told++;
	}
	return { replies: posts.length - 1, told };
}

async function onBlogComment(db, pid, cid, comment, now, send) {
	const post = await val(db, 'blog_posts/' + pid);
	if (!post || !comment || post.by === comment.by) return null;
	const name = (await val(db, 'users/' + comment.by + '/displayName')) || 'A player';
	return notify(db, post.by, 'blog-' + pid, { type: 'blog', actor: comment.by, post: pid, title: cut(post.title, 120), at: now }, {
		send, collapse: true, event: cid, push: { title: 'Comment on “' + cut(post.title, 60) + '”', body: name + ': ' + cut(comment.text, 100), url: 'blog.html?p=' + encodeURIComponent(pid) + '#comments', tag: 'sigil-blog-' + pid },
	});
}

// ---- Teams ----

async function teamStaff(db, tid) {
	const members = (await val(db, 'team_members/' + tid)) || {};
	return Object.keys(members).filter((u) => members[u] && (members[u].role === 'leader' || members[u].role === 'mod'));
}

/**
 * A membership changed: the member count, and the player told of being
 * admitted (by someone else) or of a new role.
 */
async function onTeamMember(db, tid, uid, before, after, now, send) {
	const [team, members] = await Promise.all([val(db, 'teams/' + tid), val(db, 'team_members/' + tid)]);
	if (!team) return null;
	const count = Object.keys(members || {}).length;
	if (team.memberCount !== count) await db.ref('teams/' + tid + '/memberCount').set(count);
	if (!before && after) await joinRunningBattles(db, tid, uid, after.joined, now);
	const url = 'teams.html?id=' + encodeURIComponent(tid);
	const base = { type: 'team', team: tid, teamName: cut(team.name, 40), at: now };
	if (!before && after && after.by && after.by !== uid) {
		await notify(db, uid, 'team-' + tid, Object.assign({ event: 'accepted', actor: after.by }, base), {
			send, push: { title: 'Welcome to ' + cut(team.name, 40), body: 'Your request to join was accepted.', url, tag: 'sigil-team-' + tid },
		});
	} else if (before && after && before.role !== after.role) {
		await notify(db, uid, 'team-' + tid, Object.assign({ event: 'role', role: after.role }, base), {
			send, push: { title: cut(team.name, 40), body: 'You are now ' + (after.role === 'leader' ? 'the leader' : after.role === 'mod' ? 'a moderator' : 'a member') + '.', url, tag: 'sigil-team-' + tid },
		});
	}
	return { count };
}

/**
 * A player who joins `tid` while a battle it plays in is running goes on
 * that battle's roster (from now), unless already on it. Rosters not yet
 * written are left alone: they will be built with this membership.
 */
async function joinRunningBattles(db, tid, uid, joined, now) {
	const snap = await db.ref('team_battles').orderByChild('end').startAt(now).once('value');
	const running = [];
	snap.forEach((c) => {
		const b = c.val();
		if (b && b.start <= now && b.teams && b.teams[tid] === 'accepted') running.push(c.key);
	});
	for (const bid of running) {
		const base = 'team_battle_scores/' + bid;
		if (!(await val(db, base + '/rosterAt'))) continue;
		const since = typeof joined === 'number' ? joined : now;
		await db.ref(base + '/roster/' + uid).transaction((cur) => (cur ? undefined : { team: tid, since }));
	}
	return running.length;
}

async function onTeamRequest(db, tid, uid, now, send) {
	// From an account being deleted (its deletion may have missed this
	// request, not yet indexed): the request goes.
	if (await val(db, 'deleted_users/' + uid)) {
		await db.ref('team_requests/' + tid + '/' + uid).remove();
		return 0;
	}
	// Who asked where (server-only), for account deletion.
	await db.ref('team_request_index/' + uid + '/' + tid).set(now);
	const [team, name] = await Promise.all([val(db, 'teams/' + tid), val(db, 'users/' + uid + '/displayName')]);
	if (!team) return 0;
	let told = 0;
	for (const staff of await teamStaff(db, tid)) {
		const w = await notify(db, staff, 'teamreq-' + tid, { type: 'team', event: 'request', team: tid, teamName: cut(team.name, 40), actor: uid, at: now }, {
			send, collapse: true, event: uid, push: { title: cut(team.name, 40), body: (name || 'A player') + ' asks to join.', url: 'teams.html?id=' + encodeURIComponent(tid) + '#requests', tag: 'sigil-teamreq-' + tid },
		});
		if (w) told++;
	}
	return told;
}

/** A new battle: each invited team's leader is asked. */
async function onBattleCreated(db, bid, battle, now, send) {
	if (!battle || !battle.teams) return 0;
	const host = (await val(db, 'teams/' + battle.host + '/name')) || battle.host;
	let told = 0;
	for (const t of Object.keys(battle.teams)) {
		if (battle.teams[t] !== 'invited') continue;
		const leader = await val(db, 'teams/' + t + '/leader');
		const w = await notify(db, leader, 'battleinv-' + bid, { type: 'team', event: 'invite', battle: bid, name: cut(battle.name, 80), team: t, host: battle.host, hostName: cut(host, 40), at: now }, {
			send, push: { title: 'Team battle invitation', body: cut(host, 40) + ' invites your team to “' + cut(battle.name, 60) + '”.', url: 'teams.html?battle=' + encodeURIComponent(bid), tag: 'sigil-battle-' + bid },
		});
		if (w) told++;
	}
	return told;
}

/**
 * Tell the battle's players (its roster, up to BATTLE_NOTIFY_MAX a team; the
 * accepted teams' members if it has none).
 */
async function tellBattleTeams(db, bid, battle, entry, push, send) {
	const roster = (await val(db, 'team_battle_scores/' + bid + '/roster')) || {};
	const byTeam = {};
	for (const t of battleTeams(battle)) byTeam[t] = [];
	Object.keys(roster).forEach((uid) => { if (roster[uid] && byTeam[roster[uid].team]) byTeam[roster[uid].team].push(uid); });
	let told = 0;
	for (const t of Object.keys(byTeam)) {
		const players = byTeam[t].length ? byTeam[t] : Object.keys((await val(db, 'team_members/' + t)) || {});
		for (const uid of players.slice(0, BATTLE_NOTIFY_MAX)) {
			if (await notify(db, uid, 'battle-' + bid, Object.assign({ team: t }, entry), { send, push })) told++;
		}
	}
	return told;
}

/**
 * Every few minutes: announce battles that have started (and fix their
 * rosters), and close those that ended BATTLE_GRACE_MS ago (team_battles/
 * {id}/result, the final standings; a game rated later still counts and
 * rewrites them).
 */
async function battleTick(db, now, send) {
	const snap = await db.ref('team_battles').orderByChild('end').startAt(now - 7 * 86400000).once('value');
	const battles = [];
	snap.forEach((c) => { battles.push([c.key, c.val()]); });
	const out = { started: 0, finished: 0 };
	for (const [bid, b] of battles) {
		if (!b || b.finished) continue;
		const url = 'teams.html?battle=' + encodeURIComponent(bid);
		if (now >= b.end + BATTLE_GRACE_MS) {
			if (!(await claimStep(db, bid, 'closing', now))) continue;
			const first = await writeResult(db, bid, b, now);
			const standings = first || ((await val(db, 'team_battles/' + bid + '/result')) || {}).standings || [];
			await announceEnd(db, bid, b, standings, now, send, false);
			await db.ref('team_battles/' + bid + '/finished').set(now);
			// Once more after the mark: a game scored while closing that did
			// not see the result yet is in now (see scoreGame).
			const last = await writeResult(db, bid, b, now);
			if (last && winnerOf(last) !== winnerOf(standings)) await announceEnd(db, bid, b, last, now, send, true);
			out.finished++;
		} else if (now >= b.start && now < b.end && !b.startedAt) {
			if (!(await claimStep(db, bid, 'starting', now))) continue;
			await ensureRoster(db, bid, b, now);
			await tellBattleTeams(db, bid, b, { type: 'team', event: 'battle-start', battle: bid, name: cut(b.name, 80), at: now },
				{ title: 'Team battle started', body: '“' + cut(b.name, 60) + '” is on: rated games against the other teams count.', url, tag: 'sigil-battle-' + bid }, send);
			await db.ref('team_battles/' + bid + '/startedAt').set(now);
			out.started++;
		}
	}
	return out;
}

/**
 * One tick's claim on a battle's start or close (team_battles/{id}/{step}):
 * the step is marked done (startedAt, finished) only after its writes and
 * notices, so a tick that fails part-way is retried by a later one once its
 * claim is CLAIM_MS old.
 */
async function claimStep(db, bid, step, now) {
	const res = await db.ref('team_battles/' + bid + '/' + step).transaction((cur) => (typeof cur === 'number' && cur > now - CLAIM_MS ? undefined : now));
	return res.committed;
}

/**
 * The battle's roster, team_battle_scores/{id}/roster/{uid} = {team, since}:
 * who plays for which team, fixed when the battle starts (written then by
 * battleTick, or by the first game scored if that comes first) from the
 * accepted teams' members at that moment; players who join one of them
 * during the battle are added by onTeamMember. Leaving a team later does
 * not take a player off the roster, and a game counts only if both players
 * were on it (`since`) when it ended.
 */
async function ensureRoster(db, bid, battle, now) {
	const base = 'team_battle_scores/' + bid;
	if (await val(db, base + '/rosterAt')) return (await val(db, base + '/roster')) || {};
	const accepted = battleTeams(battle);
	const joined = {};   // uid -> {team: joinedAt}
	for (const t of accepted) {
		const members = (await val(db, 'team_members/' + t)) || {};
		Object.keys(members).forEach((uid) => {
			if (human(uid) && members[uid] && typeof members[uid].joined === 'number') (joined[uid] = joined[uid] || {})[t] = members[uid].joined;
		});
	}
	const updates = { [base + '/rosterAt']: now };
	const roster = {};
	Object.keys(joined).forEach((uid) => {
		const team = battleTeamOf(joined[uid], accepted);
		roster[uid] = { team, since: joined[uid][team] };
		updates[base + '/roster/' + uid] = roster[uid];
	});
	// Child paths, so two first writers merge rather than clobber.
	await db.ref().update(updates);
	return (await val(db, base + '/roster')) || {};
}

/**
 * Score a rated game for every battle it was played in (it ended between
 * the battle's start and end, whenever the event arrives): the player's
 * points (1 a win) for their roster team, if the opponent is on the roster
 * of another team. Safe to repeat (each game is counted once). A battle
 * already closed gets its final standings rewritten.
 */
async function scoreGame(db, uid, gameId, entry, now, send) {
	if (!entry || entry.rated !== true || entry.opponentIsAI || !human(uid) || !human(entry.opponentUid)) return [];
	const ts = entry.timestamp;
	if (typeof ts !== 'number') return [];
	const snap = await db.ref('team_battles').orderByChild('end').startAt(ts).once('value');
	const battles = [];
	snap.forEach((c) => {
		const b = c.val();
		if (b && b.start <= ts && ts < b.end) battles.push([c.key, b]);
	});
	const scored = [];
	for (const [bid, b] of battles) {
		const roster = await ensureRoster(db, bid, b, typeof now === 'number' ? now : Date.now());
		const me = roster[uid];
		const them = roster[entry.opponentUid];
		if (!me || !them || !me.team || !them.team || me.team === them.team) continue;
		if (!(me.since <= ts) || !(them.since <= ts)) continue;
		const win = entry.result === 'win';
		const res = await db.ref('team_battle_scores/' + bid + '/players/' + uid).transaction((cur) => {
			const p = cur || { team: me.team, points: 0, games: 0 };
			if (p.seen && p.seen[gameId]) return undefined;
			return Object.assign({}, p, { team: me.team, points: (p.points || 0) + (win ? 1 : 0), games: (p.games || 0) + 1, seen: Object.assign({}, p.seen, { [gameId]: true }) });
		});
		const after = res.snapshot.val();
		// Counted by an earlier try of this event: the steps below may not
		// have finished then, so they run again (they are safe to repeat).
		const counted = !!(after && after.seen && after.seen[gameId]);
		if (!res.committed && !counted) continue;
		if (res.committed) scored.push({ battle: bid, team: me.team, win });
		// Closed (or closing) by now? Read afresh, after the score is in:
		// either this sees the close's result and rewrites it, or the close
		// rewrites it after marking the battle finished (battleTick), and
		// reads this score then.
		const state = (await val(db, 'team_battles/' + bid)) || {};
		if (state.finished || state.result) {
			const before = winnerOf((state.result || {}).standings);
			const standings = await writeResult(db, bid, b, now);
			if (standings && winnerOf(standings) !== before) await announceEnd(db, bid, b, standings, now, send, true);
		}
	}
	return scored;
}

/**
 * team_battles/{id}/result: the standings as they are now, with the number
 * of games they count. Two writers racing keep the one that counts more
 * (scores only grow), so a stale read never overwrites a newer result.
 * Resolves to the standings written, or null when a newer result stands.
 */
async function writeResult(db, bid, battle, now) {
	const players = (await val(db, 'team_battle_scores/' + bid + '/players')) || {};
	const full = teamBattleStandings(battle, players);
	const games = Object.keys(players).reduce((n, u) => n + ((players[u] && players[u].games) || 0), 0);
	const standings = full.map((s) => ({ team: s.team, score: s.score, points: s.points, players: s.players.length }));
	const res = await db.ref('team_battles/' + bid + '/result').transaction((cur) => (
		cur && (cur.games || 0) > games ? undefined : { standings, games, at: typeof now === 'number' ? now : Date.now() }));
	return res.committed ? standings : null;
}

/** The winning team of final standings, or null (no points, or a tie). */
function winnerOf(standings) {
	const s = standings || [];
	return s[0] && s[0].score > 0 && (!s[1] || s[0].score > s[1].score) ? s[0].team : null;
}

/** The battle-end notice to its roster (again, `corrected`, when a late game changed the winner). */
async function announceEnd(db, bid, battle, standings, now, send, corrected) {
	const win = winnerOf(standings);
	const winName = win ? (await val(db, 'teams/' + win + '/name')) || win : null;
	const url = 'teams.html?battle=' + encodeURIComponent(bid);
	return tellBattleTeams(db, bid, battle, {
		type: 'team', event: 'battle-end', battle: bid, name: cut(battle.name, 80), winner: win, winnerName: winName ? cut(winName, 40) : null, at: now,
	}, { title: corrected ? 'Team battle result corrected' : 'Team battle over', body: '“' + cut(battle.name, 60) + '”: ' + (winName ? cut(winName, 40) + ' won.' : 'a tie.'), url, tag: 'sigil-battle-' + bid }, send);
}

/** A correspondence game's result in the inbox (realtime ones are seen live). */
async function gameResultNotice(db, uid, gameId, entry, now, send) {
	if (!entry || !entry.roomCode || !human(uid) || entry.opponentIsAI) return null;
	const type = await val(db, 'rooms/' + entry.roomCode + '/timeControl/type');
	if (type !== 'correspondence') return null;
	const won = entry.result === 'win';
	const change = typeof entry.eloChange === 'number' ? entry.eloChange : null;
	return notify(db, uid, 'game-' + gameId, {
		type: 'game', event: 'result', result: won ? 'win' : 'loss', opponent: cut(entry.opponent, 30), actor: human(entry.opponentUid) ? entry.opponentUid : null,
		room: entry.roomCode, eloChange: change, at: now,
	}, {
		send, push: { title: won ? 'You won' : 'Game over', body: (won ? 'You beat ' : 'You lost to ') + cut(entry.opponent, 30) + (change !== null ? ' (' + (change >= 0 ? '+' : '') + change + ')' : '') + '.', url: 'multiplayer.html?id=' + encodeURIComponent(entry.roomCode), tag: 'sigil-game-' + gameId },
	});
}

/** A new user_games entry: team battles, then the inbox. */
async function onUserGame(db, uid, gameId, entry, now, send) {
	const scored = await scoreGame(db, uid, gameId, entry, now, send);
	const notice = await gameResultNotice(db, uid, gameId, entry, now, send);
	return { scored, notified: !!notice };
}

// ---- Disbanding a team ----

/**
 * Remove team `tid` and everything of it: members (and their indexes),
 * requests, bans, its forum, and battles it hosts that have not started.
 * By its leader or an admin. Resolves to the number of members removed.
 */
async function disbandTeam(db, tid, uid, now) {
	if (typeof tid !== 'string' || !/^[a-z0-9-]{3,30}$/.test(tid)) throw Object.assign(new Error('No such team.'), { code: 'not-found' });
	const [team, admin] = await Promise.all([val(db, 'teams/' + tid), val(db, 'admins/' + uid)]);
	if (!team) throw Object.assign(new Error('No such team.'), { code: 'not-found' });
	if (team.leader !== uid && admin !== true) throw Object.assign(new Error('Only the leader disbands a team.'), { code: 'permission-denied' });
	const members = Object.keys((await val(db, 'team_members/' + tid)) || {});
	const updates = {};
	members.forEach((m) => { updates['user_teams/' + m + '/' + tid] = null; });
	await teamRemoval(db, tid, now, updates);
	await db.ref().update(updates);
	return members.length;
}

/**
 * Add to `updates` the removal of team `tid`: the team, its members,
 * requests, bans, forum, and the battles it hosts that have not started.
 * (The members' user_teams entries are the caller's.)
 */
async function teamRemoval(db, tid, now, updates) {
	Object.assign(updates, {
		['teams/' + tid]: null,
		['team_members/' + tid]: null,
		['team_requests/' + tid]: null,
		['team_bans/' + tid]: null,
		['forum_threads/team:' + tid]: null,
		['forum_posts/team:' + tid]: null,
	});
	const hosted = await db.ref('team_battles').orderByChild('start').startAt(now).once('value');
	hosted.forEach((c) => { if (c.val() && c.val().host === tid) updates['team_battles/' + c.key] = null; });
	return updates;
}

// ---- Account deletion ----

/**
 * Add to deleteUserData's `updates` what the community holds of `uid`: the
 * inbox and settings, every conversation (both sides: a deleted account's
 * messages are not kept), blog posts with their comments, team places (a
 * leader hands the team to its senior moderator or member; a team left
 * empty goes). Forum posts and comments elsewhere stay, under "Deleted
 * player" (the name is read from the profile, which goes).
 */
async function deletionUpdates(db, uid, updates) {
	for (const p of ['notifications', 'notify_prefs', 'community_prefs', 'rate_limits', 'community_mutes', 'forum_mods', 'dm_index', 'user_teams']) {
		updates[p + '/' + uid] = null;
	}
	// Every conversation: the index lists the ones not hidden, the
	// conversations themselves (by member) all of them.
	const [index, asA, asB, teams, posts] = await Promise.all([
		val(db, 'dm_index/' + uid),
		db.ref('dm_convos').orderByChild('a').equalTo(uid).once('value'),
		db.ref('dm_convos').orderByChild('b').equalTo(uid).once('value'),
		val(db, 'user_teams/' + uid),
		db.ref('blog_posts').orderByChild('by').equalTo(uid).once('value'),
	]);
	const convos = {};   // cid -> the other member
	Object.keys(index || {}).forEach((cid) => { convos[cid] = index[cid] && index[cid].with; });
	asA.forEach((c) => { convos[c.key] = (c.val() || {}).b; });
	asB.forEach((c) => { convos[c.key] = (c.val() || {}).a; });
	Object.keys(convos).forEach((cid) => {
		const other = convos[cid];
		updates['dm_convos/' + cid] = null;
		updates['dm_messages/' + cid] = null;
		updates['dm_flags/' + cid] = null;
		if (typeof other === 'string' && other && other !== uid) updates['dm_index/' + other + '/' + cid] = null;
	});
	posts.forEach((c) => {
		updates['blog_posts/' + c.key] = null;
		updates['blog_comments/' + c.key] = null;
	});
	for (const tid of Object.keys(teams || {})) {
		const [team, members] = await Promise.all([val(db, 'teams/' + tid), val(db, 'team_members/' + tid)]);
		const rest = Object.keys(members || {}).filter((m) => m !== uid)
			.sort((a, b) => ((members[b].role === 'mod') - (members[a].role === 'mod')) || ((members[a].joined || 0) - (members[b].joined || 0)));
		if (team && !rest.length) {
			// The last member: the team goes, as if disbanded.
			await teamRemoval(db, tid, Date.now(), updates);
			continue;
		}
		updates['team_members/' + tid + '/' + uid] = null;
		if (team && team.leader === uid) {
			updates['teams/' + tid + '/leader'] = rest[0];
			updates['team_members/' + tid + '/' + rest[0] + '/role'] = 'leader';
		}
	}
	// Requests to join closed teams (team_request_index, kept by onTeamRequest).
	const asked = (await val(db, 'team_request_index/' + uid)) || {};
	Object.keys(asked).forEach((tid) => {
		if (updates['team_requests/' + tid] !== null) updates['team_requests/' + tid + '/' + uid] = null;
	});
	updates['team_request_index/' + uid] = null;
	return updates;
}

module.exports = {
	notify, pushAllowed, pushNotice, ensureRoster, joinRunningBattles,
	onFollow, onChallenge, onMessage, onForumPost, onBlogComment,
	onTeamMember, onTeamRequest, onBattleCreated, battleTick,
	scoreGame, gameResultNotice, onUserGame, disbandTeam, deletionUpdates,
};
