/**
 * team-battle.js — how a team battle is scored, one copy for teams.html and
 * the server (functions/community.js, which records the points).
 *
 * A battle (team_battles/{id}) runs from `start` to `end` between its
 * accepted teams. Every rated online game between members of two different
 * accepted teams scores: 1 point for the winner (team_battle_scores/{id}/
 * players/{uid} = {team, points, games}). A player plays for one team per
 * battle, fixed by their first scored game: of their accepted teams, the one
 * they joined first. A team's score is the sum of its topN best players'
 * points, so a big team does not win by numbers alone.
 *
 * An arena tournament (when the site has them) plugs in the same way: its
 * per-player scores go into `players` and teamBattleStandings sums them.
 */

/** The accepted team ids of a battle, host first. */
function battleTeams(battle) {
	const teams = (battle && battle.teams) || {};
	return Object.keys(teams).filter((t) => teams[t] === 'accepted')
		.sort((a, b) => (b === battle.host) - (a === battle.host) || a.localeCompare(b));
}

/** 'upcoming', 'running' or 'finished' at server time `now`. */
function battleState(battle, now) {
	if (!battle) return 'finished';
	if (battle.finished || now >= battle.end) return 'finished';
	return now >= battle.start ? 'running' : 'upcoming';
}

/**
 * The team a player scores for: of the battle's accepted teams they are a
 * member of ({teamId: joinedAt}), the one they joined first; null if none.
 */
function battleTeamOf(memberships, accepted) {
	let best = null;
	for (const t of accepted || []) {
		const joined = memberships && memberships[t];
		if (typeof joined !== 'number') continue;
		if (best === null || joined < memberships[best] || (joined === memberships[best] && t < best)) best = t;
	}
	return best;
}

/**
 * The standings: [{ team, score, points, players: [{uid, points, games}],
 * counted }] best first. `score` sums the topN best players; ties go to the
 * team with more points in all, then by id.
 */
function teamBattleStandings(battle, players) {
	const teams = battleTeams(battle);
	const topN = Math.max(1, Math.floor((battle && battle.topN) || 5));
	const by = {};
	teams.forEach((t) => { by[t] = []; });
	Object.keys(players || {}).forEach((uid) => {
		const p = players[uid];
		if (p && by[p.team]) by[p.team].push({ uid, points: Number(p.points) || 0, games: Number(p.games) || 0 });
	});
	return teams.map((team) => {
		const list = by[team].sort((a, b) => b.points - a.points || a.games - b.games || a.uid.localeCompare(b.uid));
		const top = list.slice(0, topN);
		return {
			team,
			score: top.reduce((s, p) => s + p.points, 0),
			points: list.reduce((s, p) => s + p.points, 0),
			counted: top.length,
			players: list,
		};
	}).sort((a, b) => b.score - a.score || b.points - a.points || a.team.localeCompare(b.team));
}

if (typeof module !== 'undefined' && module.exports) {
	module.exports = { battleTeams, battleState, battleTeamOf, teamBattleStandings };
}
