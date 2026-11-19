"""Checks for fair_play_scan.py's selection and statistics (run: python test_fair_play_scan.py).

No engine needed: the per-turn rows are synthetic. A planted engine-like player must
be flagged against similarly rated players; honest players, short samples and the AI
anchors must not be.
"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fair_play_scan as fp  # noqa: E402

OPTS = dict(opening_turns=2, decided=600, cap=600, close=10, band=150, min_peers=8,
            min_games=5, min_turns=60, bootstrap=400)


def synth(seed=7):
    """lines + rows: 24 honest players (match rate and loss by rating), one engine
    user at 1250, one player with two games, the Hard AI as an anchor."""
    rng = random.Random(seed)
    lines, rows = {}, {}
    players = {f'u{k:02d}': 1000 + 20 * k for k in range(24)}
    players['cheat'] = 1250
    profile = {u: (0.25 + (r - 1000) / 2400, 70 - (r - 1000) / 12) for u, r in players.items()}
    profile['cheat'] = (0.82, 6)
    profile['__ai_rust_hard__'] = (0.9, 4)
    profile['short'] = (0.4, 40)
    gid = 0

    def game(red, blue, rr, rb, analyze, turns=24):
        nonlocal gid
        gid += 1
        g = f'g{gid:04d}'
        movers = ['red' if i % 2 == 0 else 'blue' for i in range(turns)]
        lines[g] = {'roomCode': 'R' + g, 'timestamp': 1_700_000_000_000 + gid, 'uids': {'red': red, 'blue': blue},
                    'ratings': {'red': rr, 'blue': rb}, 'analyze': analyze, 'movers': movers,
                    'positions': ['p'] * (turns + 1)}
        for i, c in enumerate(movers):
            if c not in analyze:
                continue
            uid = red if c == 'red' else blue
            p_match, mean_loss = profile[uid]
            match = rng.random() < p_match
            loss = 0 if match else int(rng.expovariate(1 / max(1, mean_loss)))
            rows[(g, i)] = {'g': g, 'i': i, 'd': 4, 'score': 50, 'played': 50 - loss, 'match': match,
                            'n': 40, 'mate': None}
    uids = sorted(players)
    for u in uids:
        for k in range(8):
            opp = uids[(uids.index(u) + 1 + k) % len(uids)]
            game(u, opp, players[u], players[opp], ['red'])
    game('short', 'u00', 1200, 1000, ['red'])
    game('short', 'u01', 1200, 1020, ['red'])
    for k in range(6):
        game('__ai_rust_hard__', uids[k], 1600, players[uids[k]], ['red'])
    return lines, rows


class Report(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lines, cls.rows = synth()
        cls.players, cls.anchors = fp.build_report(cls.lines, cls.rows, OPTS)
        cls.by = {p['uid']: p for p in cls.players}

    def test_engine_user_flagged(self):
        c = self.by['cheat']
        self.assertEqual(c['flag'], 'strong', c['why'])
        self.assertGreater(c['t1']['lo'], c['peers']['t1']['p95'])
        self.assertLess(c['acpl']['hi'], c['peers']['acpl']['p05'])
        self.assertGreaterEqual(c['peers']['n'], OPTS['min_peers'])
        self.assertTrue(all(abs(o['rating'] - c['rating']) <= c['peers']['band'] for o in self.players
                            if o['uid'] != 'cheat' and o['flag'] != 'insufficient') or c['peers']['band'] >= 150)
        self.assertGreater(c['z']['t1'], 3)

    def test_honest_players_not_flagged(self):
        flagged = [p['uid'] for p in self.players if p['flag'] in ('review', 'strong') and p['uid'] != 'cheat']
        self.assertLessEqual(len(flagged), 1, flagged)
        self.assertFalse(any(p['flag'] == 'strong' for p in self.players if p['uid'] != 'cheat'))

    def test_short_sample_and_anchor(self):
        self.assertEqual(self.by['short']['flag'], 'insufficient')
        self.assertEqual([a['uid'] for a in self.anchors], ['__ai_rust_hard__'])
        self.assertEqual(self.anchors[0]['flag'], 'anchor')
        self.assertNotIn('__ai_rust_hard__', self.by)

    def test_counts_and_intervals(self):
        p = self.by['u05']
        # 8 games x 12 turns as red, less each side's first two (the game's
        # last turn is blue's).
        self.assertEqual((p['games'], p['turns']), (8, 8 * 10))
        # Every game's last turn is left out (here red's fourth).
        movers = ['red', 'blue'] * 3 + ['red']
        one = {'g': {'roomCode': 'R', 'timestamp': 1, 'uids': {'red': 'x', 'blue': 'y'}, 'ratings': {'red': 1000, 'blue': 1000},
                     'analyze': ['red'], 'movers': movers, 'positions': ['p'] * 8}}
        rows = {('g', i): {'score': 0, 'played': 0, 'match': True, 'n': 9} for i in range(0, 7, 2)}
        b = fp.build_report(one, rows, dict(OPTS, opening_turns=0, min_games=1, min_turns=1, min_peers=1))[0]
        self.assertEqual([(x['uid'], x['turns']) for x in b], [('x', 3)])
        for key in ('t1', 'acpl', 'close'):
            self.assertLessEqual(p[key]['lo'], p[key]['est'])
            self.assertLessEqual(p[key]['est'], p[key]['hi'])
        self.assertEqual(len(p['gameList']), 8)
        self.assertEqual(p['rating'], 1100)
        # Strongest first among the unflagged, insufficient last.
        self.assertEqual(self.players[0]['uid'], 'cheat')
        self.assertEqual(self.players[-1]['flag'], 'insufficient')

    def test_thin_reference(self):
        def only(uids):
            keep = {g: v for g, v in self.lines.items() if v['uids']['red'] in uids}
            return fp.build_report(keep, self.rows, OPTS)[0]
        few = {p['uid']: p for p in only({'cheat', 'u10', 'u11', 'u12', 'u13', 'u14'})}
        self.assertEqual(few['cheat']['peers']['n'], 5)
        self.assertEqual(few['cheat']['flag'], 'review')
        self.assertTrue(any('Thin reference' in w for w in few['cheat']['why']))
        two = {p['uid']: p for p in only({'cheat', 'u10', 'u11'})}
        self.assertEqual(two['cheat']['flag'], 'none')
        self.assertTrue(any('No verdict' in w for w in two['cheat']['why']))

    def test_excluded_turns(self):
        m = fp.turn_measure
        self.assertEqual(m({'score': 50, 'played': 20, 'match': False, 'n': 9}, OPTS), (0, 30, 0))
        self.assertEqual(m({'score': 50, 'played': 45, 'match': True, 'n': 9}, OPTS), (1, 5, 1))
        # A played turn the engine scores above its own pick is no loss.
        self.assertEqual(m({'score': 50, 'played': 60, 'match': False, 'n': 9}, OPTS), (0, 0, 1))
        # Clamped: a blunder into a lost position costs at most cap + |best|.
        self.assertEqual(m({'score': 100, 'played': -9_999_996, 'match': False, 'n': 9}, OPTS), (0, 700, 0))
        self.assertIsNone(m({'score': 700, 'played': 690, 'match': True, 'n': 9}, OPTS))     # decided
        self.assertIsNone(m({'score': 50, 'played': 50, 'match': True, 'n': 1}, OPTS))       # forced
        self.assertIsNone(m({'score': 50, 'played': 50, 'match': True, 'mate': 3}, OPTS))    # forced result
        self.assertIsNone(m({'score': 50, 'played': None, 'match': False}, OPTS))
        # A fail-low bound is not a score: left out (eval re-searches those).
        self.assertIsNone(m({'score': 50, 'played': 40, 'match': False, 'n': 9, 'exact': False}, OPTS))
        self.assertEqual(m({'score': 50, 'played': 40, 'match': False, 'n': 9, 'exact': True}, OPTS), (0, 10, 1))
        self.assertIsNone(m({'error': 'x'}, OPTS))
        self.assertIsNone(m({'over': True}, OPTS))
        self.assertIsNone(m(None, OPTS))

    def test_mixed_rows_refused(self):
        rows = {(1, 0): {'d': 4, 'engine': 'a'}, (1, 1): {'d': 4, 'engine': 'a'}}
        self.assertIsNone(fp.mixed(rows))
        self.assertIn('--depth', fp.mixed(dict(rows, **{'x': {'d': 3, 'engine': 'a'}})))
        self.assertIn('--engine', fp.mixed(dict(rows, **{'x': {'d': 4, 'engine': 'b'}})))

    def test_percentile(self):
        self.assertEqual(fp.percentile([1, 2, 3, 4, 5], 0.5), 3)
        self.assertAlmostEqual(fp.percentile([1, 2, 3, 4], 0.95), 3.85)
        self.assertIsNone(fp.percentile([], 0.5))


class Select(unittest.TestCase):
    def test_choose_games(self):
        def rec(ts, red, blue, **kw):
            g = {'timestamp': ts, 'redUid': red, 'blueUid': blue, 'eloProcessed': True,
                 'redEloBefore': 1000, 'blueEloBefore': 1000, 'variant': 'standard'}
            g.update(kw)
            return g
        raw = {f'a{k}': rec(k, 'alice', 'bob') for k in range(5)}
        raw['b0'] = rec(10, 'alice', '__ai_rust_hard__')
        raw['u0'] = rec(11, 'alice', 'bob', unratedReason='casual')
        raw['u1'] = rec(12, 'alice', 'bob', eloProcessed=False)
        raw['p0'] = rec(13, 'alice', 'bob', variant='standard,pentagon')
        raw['d0'] = rec(14, 'alice', 'deleted')
        pick = fp.choose_games(raw, per_player=3, ai_games=1)
        # alice: d0, b0, a4; bob: a4, a3, a2; the AI: b0; nothing unrated, no pentagon game.
        self.assertEqual(dict(pick), {'d0': {'red'}, 'b0': {'red', 'blue'}, 'a4': {'red', 'blue'},
                                      'a3': {'blue'}, 'a2': {'blue'}})
        self.assertEqual(fp.choose_games(raw, per_player=3, ai_games=0)['b0'], {'red'})
        self.assertEqual(fp.choose_games(raw, 3, 1, since_ms=12)['d0'], {'red'})
        self.assertNotIn('a4', fp.choose_games(raw, 3, 1, since_ms=12))


if __name__ == '__main__':
    unittest.main()
