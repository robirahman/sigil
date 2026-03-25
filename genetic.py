"""
Genetic algorithm for evolving Sigil gameplay strategies.

Each genome is a vector of weights controlling:
- How valuable each node is to control (39 weights)
- How urgently to cast each spell (15 weights)
- How valuable it is to have each spell charged (15 weights)
- How valuable it is to disrupt opponent spell charges (15 weights)
- Strategic preferences (stone count, mana, aggression, etc.)

Fitness is determined by tournament play between genomes.

Usage:
    python genetic.py --generations 50 --population 40 --games-per-match 4
"""

import argparse
import json
import os
import random
import time
import copy

import numpy as np

from simboard import SimBoard, CompleteTurn, Action, NODE_ORDER, ADJACENCY, POSITIONS, CORE_SPELLS
from search import _apply_turn
from selfplay import random_core_spells, MAX_TURNS

# -------------------------------------------------------------------
# Genome layout
# -------------------------------------------------------------------
# 39 node values         (how desirable is controlling this node)
# 15 spell cast priorities (priority for casting each spell)
# 15 spell charge values  (value of having each spell charged)
# 15 spell disruption     (value of disrupting opponent's spell charge)
# 16 strategic weights:
#   0: stone_diff_weight        (value of being ahead in stones)
#   1: mana_weight              (value of controlling mana nodes)
#   2: spell_charge_weight      (value of having more charged spells than opponent)
#   3: aggression_weight        (preference for hard moves / pushing)
#   4: territory_weight         (value of spreading across zones)
#   5: dash_threshold           (willingness to dash — higher = more willing)
#   6: lock_penalty             (penalty for moving into locked spell position)
#   7: center_bonus             (bonus for controlling center nodes a1/b1/c1)
#   8: spell_counter_urgency    (urgency modifier based on spell counter)
#   9: defense_weight           (penalty for exposed stones)
#  10: connectivity_weight      (value of connected stone clusters)
#  11: threat_weight            (penalty for opponent threats)
#  12: tempo_weight             (bonus for maintaining initiative)
#  13: endgame_aggression       (extra stone_diff weight when game is advanced)
#  14: spell_synergy_weight     (bonus for controlling multiple spell positions)
#  15: opponent_response_weight (how much to discount for opponent's best reply)

NUM_NODES = 39
NUM_SPELLS = 15
NUM_SPELL_CHARGE = 15
NUM_SPELL_DISRUPT = 15
NUM_STRATEGIC = 16
GENOME_SIZE = NUM_NODES + NUM_SPELLS + NUM_SPELL_CHARGE + NUM_SPELL_DISRUPT + NUM_STRATEGIC  # 100

CORE_SPELL_NAMES = [
    'Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning',
    'Grow', 'Fireblast', 'Hail_Storm', 'Meteor', 'Seal_of_Wind',
    'Sprout', 'Slash', 'Surge', 'Comet', 'Seal_of_Summer',
]

# Precompute zone membership
ZONE_NODES = {'a': [], 'b': [], 'c': []}
for n in NODE_ORDER:
    ZONE_NODES[n[0]].append(n)


def random_genome():
    """Create a random genome with sensible initialization."""
    g = np.zeros(GENOME_SIZE, dtype=np.float32)
    # Node values: higher for center and spell positions
    for i, name in enumerate(NODE_ORDER):
        base = 0.5
        if name in ('a1', 'b1', 'c1'):
            base = 1.5  # mana nodes are valuable
        elif int(name[1:]) <= 6:
            base = 0.8  # ritual positions
        elif int(name[1:]) <= 10:
            base = 0.7  # sorcery positions
        g[i] = base + np.random.uniform(-0.5, 0.5)
    g[:NUM_NODES] = np.maximum(g[:NUM_NODES], 0.0)

    # Spell cast priorities
    off = NUM_NODES
    g[off:off + NUM_SPELLS] = np.random.uniform(0.5, 3.0, NUM_SPELLS).astype(np.float32)

    # Spell charge values
    off += NUM_SPELLS
    g[off:off + NUM_SPELL_CHARGE] = np.random.uniform(0.0, 2.0, NUM_SPELL_CHARGE).astype(np.float32)

    # Spell disruption values
    off += NUM_SPELL_CHARGE
    g[off:off + NUM_SPELL_DISRUPT] = np.random.uniform(0.0, 1.5, NUM_SPELL_DISRUPT).astype(np.float32)

    # Strategic weights
    off += NUM_SPELL_DISRUPT
    defaults = [
        2.0,  # stone_diff_weight
        1.5,  # mana_weight
        1.0,  # spell_charge_weight
        0.8,  # aggression_weight
        0.5,  # territory_weight
        0.3,  # dash_threshold
        0.5,  # lock_penalty
        1.0,  # center_bonus
        0.5,  # spell_counter_urgency
        0.5,  # defense_weight
        0.4,  # connectivity_weight
        0.8,  # threat_weight
        0.3,  # tempo_weight
        1.0,  # endgame_aggression
        0.3,  # spell_synergy_weight
        0.3,  # opponent_response_weight
    ]
    for j, d in enumerate(defaults):
        g[off + j] = d + np.random.uniform(-0.5, 0.5)

    return g


def crossover(parent1, parent2):
    """Two-point crossover between two parents."""
    size = GENOME_SIZE
    pt1, pt2 = sorted(random.sample(range(size), 2))
    child = parent1.copy()
    child[pt1:pt2] = parent2[pt1:pt2]
    return child


def mutate(genome, mutation_rate=0.15, mutation_strength=0.3):
    """Gaussian mutation with per-gene probability."""
    g = genome.copy()
    mask = np.random.rand(GENOME_SIZE) < mutation_rate
    g[mask] += np.random.randn(mask.sum()).astype(np.float32) * mutation_strength
    # Clamp node values and spell priorities/charges to be non-negative
    clamp_end = NUM_NODES + NUM_SPELLS + NUM_SPELL_CHARGE + NUM_SPELL_DISRUPT
    g[:clamp_end] = np.maximum(g[:clamp_end], 0.0)
    return g


# -------------------------------------------------------------------
# Genome-parameterized policy
# -------------------------------------------------------------------

class GeneticPolicy:
    """A policy parameterized by an evolved genome."""

    def __init__(self, genome):
        self.genome = genome

        # Parse genome sections
        self.node_values = {NODE_ORDER[i]: genome[i] for i in range(NUM_NODES)}

        off = NUM_NODES
        self.spell_priorities = {CORE_SPELL_NAMES[i]: genome[off + i]
                                 for i in range(NUM_SPELLS)}

        off += NUM_SPELLS
        self.spell_charge_values = {CORE_SPELL_NAMES[i]: genome[off + i]
                                    for i in range(NUM_SPELL_CHARGE)}

        off += NUM_SPELL_CHARGE
        self.spell_disrupt_values = {CORE_SPELL_NAMES[i]: genome[off + i]
                                     for i in range(NUM_SPELL_DISRUPT)}

        off += NUM_SPELL_DISRUPT
        sw = genome[off:]
        self.stone_diff_w = sw[0]
        self.mana_w = sw[1]
        self.spell_charge_w = sw[2]
        self.aggression_w = sw[3]
        self.territory_w = sw[4]
        self.dash_threshold = sw[5]
        self.lock_penalty = sw[6]
        self.center_bonus = sw[7]
        self.spell_counter_urgency = sw[8]
        self.defense_w = sw[9]
        self.connectivity_w = sw[10]
        self.threat_w = sw[11]
        self.tempo_w = sw[12]
        self.endgame_aggression = sw[13]
        self.spell_synergy_w = sw[14]
        self.opponent_response_w = sw[15]

    def choose_turn(self, board, color):
        turns = list(board.get_legal_turns(color))
        if not turns:
            return CompleteTurn([Action('pass')])

        best_turn = turns[0]
        best_score = -1e9

        for turn in turns:
            score = self._evaluate_turn(board, turn, color)
            if score > best_score:
                best_score = score
                best_turn = turn

        return best_turn

    def _evaluate_turn(self, board, turn, color):
        """Score a turn by simulating it properly, then evaluating the board."""
        enemy = 'blue' if color == 'red' else 'red'

        # Properly simulate the turn on a copy
        b = board.copy()
        _apply_turn(b, turn, color)
        b.update()

        # If this turn wins the game, score it very high
        b.check_game_over(color)
        if b.gameover:
            if b.winner == color:
                return 1000.0
            elif b.winner == enemy:
                return -1000.0

        score = 0.0

        # ---- Action-type bonuses ----
        has_cast = False
        has_dash = False
        for action in turn.actions:
            if action.type == 'hard_move' or action.type == 'blink':
                score += self.aggression_w
            elif action.type == 'cast':
                spell_name = action.spell
                priority = self.spell_priorities.get(spell_name, 1.0)
                score += priority
                has_cast = True
                # Urgency bonus based on spell counter
                own_sc = b.spell_counter.get(color, 0)
                score += self.spell_counter_urgency * (own_sc / 6.0)
            elif action.type in ('dash', 'dash_lightning'):
                score += self.dash_threshold - 1.0
                has_dash = True

        # ---- Board state evaluation ----
        own_stones = b.totalstones[color]
        enemy_stones = b.totalstones[enemy]

        # Game progress factor (0.0 early, 1.0 late)
        progress = min(1.0, b.turn_counter / 100.0)

        # Stone differential — more important in endgame
        diff_w = self.stone_diff_w + self.endgame_aggression * progress
        score += diff_w * (own_stones - enemy_stones)

        # Mana control
        own_mana = b.mana[color]
        enemy_mana = b.mana[enemy]
        score += self.mana_w * (own_mana - enemy_mana)

        # Center control (a1, b1, c1)
        for cn in ('a1', 'b1', 'c1'):
            if b.stones[cn] == color:
                score += self.center_bonus
            elif b.stones[cn] == enemy:
                score -= self.center_bonus * 0.5

        # Spell charge evaluation — use per-spell charge values
        for spell_name in b.charged_spells[color]:
            score += self.spell_charge_values.get(spell_name, 0.5)
        for spell_name in b.charged_spells[enemy]:
            score -= self.spell_charge_values.get(spell_name, 0.5) * 0.5

        # Overall charged spell differential
        own_charged = len(b.charged_spells[color])
        enemy_charged = len(b.charged_spells[enemy])
        score += self.spell_charge_w * (own_charged - enemy_charged)

        # Spell disruption — bonus for nodes that break opponent spell charges
        score += self._eval_spell_disruption(board, b, color, enemy)

        # Territory spread — count zones with significant presence
        zone_counts = {'a': 0, 'b': 0, 'c': 0}
        for name in NODE_ORDER:
            if b.stones[name] == color:
                zone_counts[name[0]] += 1
        zones_occupied = sum(1 for v in zone_counts.values() if v > 0)
        score += self.territory_w * zones_occupied

        # Connectivity — count connected stone clusters
        score += self.connectivity_w * self._eval_connectivity(b, color)

        # Defense — penalty for exposed stones (enemy adjacent, no friendly support)
        exposed = 0
        for name in NODE_ORDER:
            if b.stones[name] == color:
                has_friendly = False
                has_enemy_nb = False
                for nb in ADJACENCY.get(name, []):
                    if b.stones[nb] == color:
                        has_friendly = True
                    elif b.stones[nb] == enemy:
                        has_enemy_nb = True
                if has_enemy_nb and not has_friendly:
                    exposed += 1
        score -= self.defense_w * exposed

        # Threat awareness — penalty for opponent threats
        score -= self.threat_w * self._eval_threats(b, color, enemy)

        # Tempo — bonus for having more moves available
        score += self.tempo_w * (own_stones - enemy_stones) * 0.1

        # Spell synergy — bonus for partial spell charges
        score += self.spell_synergy_w * self._eval_spell_progress(b, color)

        # 1-ply opponent response discount
        if self.opponent_response_w > 0.1 and not b.gameover:
            opp_score = self._eval_opponent_response(b, color, enemy)
            score -= self.opponent_response_w * opp_score

        return score

    def _eval_spell_disruption(self, old_board, new_board, color, enemy):
        """Bonus for disrupting opponent's spell charges."""
        bonus = 0.0
        for i, spell_name in enumerate(new_board.spell_names):
            pos_idx = i + 1
            nodes = POSITIONS[pos_idx]
            # Count how many of this spell's nodes the enemy held before vs after
            old_enemy = sum(1 for n in nodes if old_board.stones[n] == enemy)
            new_enemy = sum(1 for n in nodes if new_board.stones[n] == enemy)
            if new_enemy < old_enemy:
                # We disrupted enemy progress on this spell
                disrupt_val = self.spell_disrupt_values.get(spell_name, 0.5)
                # More valuable if they were close to charging
                progress_factor = old_enemy / len(nodes)
                bonus += disrupt_val * progress_factor
        return bonus

    def _eval_connectivity(self, board, color):
        """Count average cluster size for our stones. Larger clusters = better."""
        visited = set()
        cluster_sizes = []
        for name in NODE_ORDER:
            if board.stones[name] == color and name not in visited:
                # BFS to find cluster
                cluster = set()
                queue = [name]
                while queue:
                    n = queue.pop()
                    if n in cluster:
                        continue
                    cluster.add(n)
                    for nb in ADJACENCY.get(n, []):
                        if board.stones[nb] == color and nb not in cluster:
                            queue.append(nb)
                visited |= cluster
                cluster_sizes.append(len(cluster))
        if not cluster_sizes:
            return 0.0
        # Reward fewer, larger clusters (penalize fragmentation)
        largest = max(cluster_sizes)
        total = sum(cluster_sizes)
        return largest / max(total, 1) * len(cluster_sizes)

    def _eval_threats(self, board, color, enemy):
        """Evaluate how threatening the opponent's position is."""
        threat_score = 0.0

        # Check if enemy is close to charging dangerous spells
        for i, spell_name in enumerate(board.spell_names):
            info = CORE_SPELLS.get(spell_name)
            if info is None or info['static']:
                continue
            pos_idx = i + 1
            nodes = POSITIONS[pos_idx]
            enemy_count = sum(1 for n in nodes if board.stones[n] == enemy)
            total = len(nodes)
            if enemy_count == total:
                # Already charged — this is a threat
                threat_score += 2.0
            elif enemy_count == total - 1:
                # One node away from charging
                threat_score += 1.0
            elif enemy_count >= total - 2 and total >= 3:
                # Two nodes away
                threat_score += 0.3

        # Enemy stone advantage threat
        stone_diff = board.totalstones[enemy] - board.totalstones[color]
        if stone_diff > 0:
            threat_score += stone_diff * 0.3

        return threat_score

    def _eval_spell_progress(self, board, color):
        """Bonus for making progress toward charging spells."""
        bonus = 0.0
        for i, spell_name in enumerate(board.spell_names):
            pos_idx = i + 1
            nodes = POSITIONS[pos_idx]
            own_count = sum(1 for n in nodes if board.stones[n] == color)
            total = len(nodes)
            if own_count > 0 and own_count < total:
                # Partial progress — quadratic reward for being closer
                progress = own_count / total
                charge_val = self.spell_charge_values.get(spell_name, 0.5)
                bonus += charge_val * progress * progress
        return bonus

    def _eval_opponent_response(self, board, color, enemy):
        """Estimate opponent's best response score (lightweight 1-ply)."""
        b = board.copy()
        b.advance_turn()

        turns = list(b.get_legal_turns(enemy))
        if not turns:
            return 0.0

        # Sample a subset of opponent turns for speed
        sample_size = min(len(turns), 8)
        sampled = random.sample(turns, sample_size) if len(turns) > sample_size else turns

        best_opp = -1e9
        for turn in sampled:
            b2 = b.copy()
            _apply_turn(b2, turn, enemy)
            b2.update()

            # Simple evaluation from opponent's perspective
            opp_stones = b2.totalstones[enemy]
            own_stones = b2.totalstones[color]
            opp_mana = b2.mana[enemy]
            opp_charged = len(b2.charged_spells[enemy])

            opp_score = (opp_stones - own_stones) + opp_mana * 0.5 + opp_charged * 0.3
            if opp_score > best_opp:
                best_opp = opp_score

        return max(best_opp, 0.0)


# -------------------------------------------------------------------
# Tournament
# -------------------------------------------------------------------

def play_match(policy1, policy2, num_games=2, spell_names=None):
    """Play num_games between two policies. Returns (p1_wins, p2_wins, draws)."""
    p1_wins = 0
    p2_wins = 0
    draws = 0

    for game_idx in range(num_games):
        spells = spell_names or random_core_spells()
        board = SimBoard(spells)
        board.setup_initial()

        # Alternate who plays red
        if game_idx % 2 == 0:
            red_policy, blue_policy = policy1, policy2
        else:
            red_policy, blue_policy = policy2, policy1

        turn_num = 0
        while not board.gameover and turn_num < MAX_TURNS:
            turn_num += 1
            board.turn_counter = turn_num
            color = 'red' if turn_num % 2 == 1 else 'blue'
            board.whose_turn = color

            policy = red_policy if color == 'red' else blue_policy
            turn = policy.choose_turn(board, color)

            # Apply turn properly
            _apply_turn(board, turn, color)
            board.update()
            board.check_game_over(color)

        if turn_num >= MAX_TURNS and not board.gameover:
            board.update()
            if board.totalstones['red'] > board.totalstones['blue'] + 1:
                board.winner = 'red'
            elif board.totalstones['blue'] + 1 > board.totalstones['red']:
                board.winner = 'blue'

        # Attribute win
        if game_idx % 2 == 0:
            if board.winner == 'red':
                p1_wins += 1
            elif board.winner == 'blue':
                p2_wins += 1
            else:
                draws += 1
        else:
            if board.winner == 'red':
                p2_wins += 1
            elif board.winner == 'blue':
                p1_wins += 1
            else:
                draws += 1

    return p1_wins, p2_wins, draws


def run_tournament(population, games_per_match=4, hall_of_fame=None):
    """Swiss-style tournament with optional hall-of-fame opponents.

    Returns list of (genome_idx, wins, losses, win_rate) sorted by win rate.
    """
    n = len(population)
    policies = [GeneticPolicy(g) for g in population]
    wins = [0] * n
    losses = [0] * n
    games = [0] * n

    # Round 1: Play against random subset of peers
    matchups_per_genome = min(n - 1, 6)
    for i in range(n):
        opponents = random.sample([j for j in range(n) if j != i], matchups_per_genome)
        for j in opponents:
            w1, w2, d = play_match(policies[i], policies[j], num_games=games_per_match)
            wins[i] += w1
            losses[i] += w2
            wins[j] += w2
            losses[j] += w1
            games[i] += games_per_match
            games[j] += games_per_match

    # Round 2: Top performers play against hall of fame (harder opponents)
    if hall_of_fame:
        hof_policies = [GeneticPolicy(g) for g in hall_of_fame]
        # Get preliminary rankings
        prelim = []
        for i in range(n):
            total = games[i] if games[i] > 0 else 1
            prelim.append((i, wins[i] / total))
        prelim.sort(key=lambda x: x[1], reverse=True)

        # Top half plays against hall of fame
        top_half = [idx for idx, _ in prelim[:n // 2]]
        for i in top_half:
            for hof_policy in hof_policies:
                w1, w2, d = play_match(policies[i], hof_policy, num_games=2)
                wins[i] += w1
                losses[i] += w2
                games[i] += 2

    results = []
    for i in range(n):
        total = games[i] if games[i] > 0 else 1
        win_rate = wins[i] / total
        results.append((i, wins[i], losses[i], win_rate))

    results.sort(key=lambda x: x[3], reverse=True)
    return results


# -------------------------------------------------------------------
# Evolution loop
# -------------------------------------------------------------------

def evolve(generations=50, population_size=40, games_per_match=4,
           mutation_rate=0.15, mutation_strength=0.3, elite_fraction=0.2,
           seed_genomes=None):
    """Run the genetic algorithm with adaptive mutation and hall-of-fame."""

    # Initialize population — seed with existing genomes + mutants + random
    population = []
    if seed_genomes:
        for g in seed_genomes:
            # Migrate old 64-element genomes to new 100-element format
            migrated = _migrate_genome(g)
            population.append(migrated)
            # Add mutated variants of each seed
            for _ in range(3):
                population.append(mutate(migrated, mutation_rate=0.3, mutation_strength=0.5))
        print(f"Seeded {len(population)} genomes from {len(seed_genomes)} seeds", flush=True)
    while len(population) < population_size:
        population.append(random_genome())
    population = population[:population_size]

    best_genome = population[0]
    best_win_rate = 0.0

    # Hall of fame: best genome from each generation
    hall_of_fame = []
    max_hof_size = 5

    print(f"Starting evolution: {generations} generations, pop={population_size}, "
          f"genome_size={GENOME_SIZE}", flush=True)
    start_time = time.time()

    stagnation_count = 0
    prev_best_rate = 0.0

    for gen in range(generations):
        gen_start = time.time()

        # Adaptive mutation: increase if stagnating
        gen_mutation_rate = mutation_rate
        gen_mutation_strength = mutation_strength
        if stagnation_count >= 3:
            gen_mutation_rate = min(0.4, mutation_rate * 1.5)
            gen_mutation_strength = min(0.8, mutation_strength * 1.5)
        elif stagnation_count >= 5:
            gen_mutation_rate = min(0.5, mutation_rate * 2.0)
            gen_mutation_strength = min(1.0, mutation_strength * 2.0)

        # Tournament
        results = run_tournament(population, games_per_match,
                                 hall_of_fame=hall_of_fame if hall_of_fame else None)

        # Track best
        top_idx, top_wins, top_losses, top_rate = results[0]
        if top_rate > best_win_rate:
            best_win_rate = top_rate
            best_genome = population[top_idx].copy()

        # Stagnation detection
        if abs(top_rate - prev_best_rate) < 0.01:
            stagnation_count += 1
        else:
            stagnation_count = 0
        prev_best_rate = top_rate

        # Update hall of fame
        gen_best = population[top_idx].copy()
        if len(hall_of_fame) < max_hof_size:
            hall_of_fame.append(gen_best)
        else:
            # Replace weakest hall of fame member
            hall_of_fame[gen % max_hof_size] = gen_best

        gen_time = time.time() - gen_start
        avg_rate = np.mean([r[3] for r in results])
        print(f"Gen {gen+1}/{generations}: "
              f"best={top_rate:.3f} (W:{top_wins} L:{top_losses}) "
              f"avg={avg_rate:.3f} "
              f"mut={gen_mutation_rate:.2f}/{gen_mutation_strength:.2f} "
              f"stag={stagnation_count} "
              f"[{gen_time:.1f}s]", flush=True)

        # Selection: keep top fraction as elites
        num_elite = max(2, int(population_size * elite_fraction))
        elite_indices = [r[0] for r in results[:num_elite]]
        elites = [population[i].copy() for i in elite_indices]

        # Create next generation
        new_population = list(elites)  # elites survive unchanged

        # Add a few random immigrants for diversity
        num_immigrants = max(1, population_size // 10)
        for _ in range(num_immigrants):
            new_population.append(random_genome())

        # Fill rest with crossover + mutation
        while len(new_population) < population_size:
            # Tournament selection for parents (pick best of 3 random)
            p1 = _tournament_select(elites, k=3)
            p2 = _tournament_select(elites, k=3)
            child = crossover(p1, p2)
            child = mutate(child, gen_mutation_rate, gen_mutation_strength)
            new_population.append(child)

        population = new_population[:population_size]

    total_time = time.time() - start_time
    print(f"\nEvolution complete in {total_time:.0f}s")
    print(f"Best win rate: {best_win_rate:.3f}")

    return best_genome, population


def _tournament_select(candidates, k=3):
    """Select the best of k random candidates."""
    selected = random.sample(candidates, min(k, len(candidates)))
    # Since we don't have scores here, just pick randomly from elites
    return random.choice(selected)


def _migrate_genome(old_genome):
    """Migrate an old 64-element genome to the new 100-element format."""
    old = np.array(old_genome, dtype=np.float32)
    new = random_genome()  # start with sensible defaults

    if len(old) >= 64:
        # Copy node values (39)
        new[:NUM_NODES] = old[:NUM_NODES]
        # Copy spell cast priorities (15)
        new[NUM_NODES:NUM_NODES + NUM_SPELLS] = old[NUM_NODES:NUM_NODES + NUM_SPELLS]
        # Old strategic weights (10) -> new strategic weights (first 10 of 16)
        old_strategic_start = NUM_NODES + NUM_SPELLS
        old_strategic = old[old_strategic_start:old_strategic_start + 10]
        new_strategic_start = NUM_NODES + NUM_SPELLS + NUM_SPELL_CHARGE + NUM_SPELL_DISRUPT
        new[new_strategic_start:new_strategic_start + 10] = old_strategic

    if len(old) >= GENOME_SIZE:
        return old[:GENOME_SIZE].copy()

    return new


def save_genome(genome, path):
    """Save a genome to a JSON file."""
    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else '.', exist_ok=True)
    with open(path, 'w') as f:
        json.dump({
            'genome': genome.tolist(),
            'genome_size': GENOME_SIZE,
            'version': 2,
        }, f)


def load_genome(path):
    """Load a genome from a JSON file, migrating if necessary."""
    with open(path) as f:
        data = json.load(f)
    genome = np.array(data['genome'], dtype=np.float32)
    version = data.get('version', 1)
    if version < 2 or len(genome) < GENOME_SIZE:
        genome = _migrate_genome(genome)
    return genome


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Evolve Sigil AI strategies')
    parser.add_argument('--generations', type=int, default=50)
    parser.add_argument('--population', type=int, default=40)
    parser.add_argument('--games-per-match', type=int, default=4)
    parser.add_argument('--mutation-rate', type=float, default=0.15)
    parser.add_argument('--mutation-strength', type=float, default=0.3)
    parser.add_argument('--output', type=str, default='models/best_genome.json')
    args = parser.parse_args()

    # Seed from existing genomes if available
    seed_genomes = []
    genome_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models')
    for fname in ['best_genome.json'] + [f'genome_top{i}.json' for i in range(1, 6)]:
        path = os.path.join(genome_dir, fname)
        if os.path.exists(path):
            try:
                seed_genomes.append(load_genome(path))
            except Exception:
                pass

    best_genome, final_pop = evolve(
        generations=args.generations,
        population_size=args.population,
        games_per_match=args.games_per_match,
        mutation_rate=args.mutation_rate,
        mutation_strength=args.mutation_strength,
        seed_genomes=seed_genomes if seed_genomes else None,
    )

    save_genome(best_genome, args.output)
    print(f"Best genome saved to {args.output}", flush=True)

    # Also save the top 5 from the final population for diversity
    for i, g in enumerate(final_pop[:5]):
        save_genome(g, f'models/genome_top{i+1}.json')
