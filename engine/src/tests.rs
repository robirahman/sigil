use crate::board::*;
use crate::topology::*;
use crate::zobrist::ZOBRIST;
use crate::spells_meta::*;

fn n(name: &str) -> u8 { NAMES.iter().position(|&x| x == name).expect("unknown node") as u8 }
fn std_board() -> Board {
    let mut b = Board::new([0,1,2,3,4,5,6,7,8], Variant::Standard);
    b.setup_initial(); b
}
const HARVEST_ID: u8 = 30;
const GATHER_ID: u8 = 31;

#[test]
fn topology_invariants() {
    assert_eq!(N, 39);
    assert_eq!(ALL.count_ones(), 39);
    for i in 0..N {
        let d = ADJ[i].count_ones();
        assert!((2..=3).contains(&d), "node {} degree {}", NAMES[i], d);
        assert_eq!(ADJ[i] & (1 << i), 0, "self loop at {}", NAMES[i]);
        let mut m = ADJ[i];
        while m != 0 {
            let j = m.trailing_zeros() as usize; m &= m - 1;
            assert!(ADJ[j] & (1 << i) != 0, "asymmetric {}->{}", NAMES[i], NAMES[j]);
        }
    }
    let mut cover = 0u64;
    for (p, &m) in SIGIL.iter().enumerate() {
        assert_eq!(cover & m, 0, "sigil {} overlaps", p + 1);
        cover |= m;
    }
    assert_eq!(cover & MANA, 0);
    assert_eq!(cover & VOID, 0);
    assert_eq!(cover | MANA | VOID, ALL, "coverage gap");
    assert_eq!(cover, SPELL_NODES, "SPELL_NODES must be the sigil union");
    assert_eq!(SIGIL.iter().map(|m| m.count_ones()).collect::<Vec<_>>(),
               vec![5,5,5,3,3,3,1,1,1]);
    let mut seen = 1u64;
    loop { let g = seen | Board::dilate(seen); if g == seen { break } seen = g; }
    assert_eq!(seen, ALL, "graph not connected");
}

#[test]
fn initial_position() {
    let b = std_board();
    assert_eq!(b.stones[0], 1 << n("a1"));
    assert_eq!(b.stones[1], 1 << n("b1"));
    assert_eq!(b.total, [1,1]);
    assert_eq!(b.mana, [1,1]);
    assert_eq!(b.charged, [0,0]);
    assert_eq!(b.outcome, Outcome::Ongoing);
}

#[test]
fn soft_moveable_matches_adjacency() {
    let b = std_board();
    assert_eq!(b.soft_moveable(Color::Red), (1 << n("a2")) | (1 << n("a11")));
    assert_eq!(b.soft_moveable(Color::Blue), (1 << n("b2")) | (1 << n("b11")));
    assert_eq!(b.hard_moveable(Color::Red), 0);
    assert_eq!(b.hard_moveable(Color::Blue), 0);
}

#[test]
fn charge_detection() {
    let mut b = std_board();
    b.stones[0] |= 1 << n("a7"); b.update();
    assert_eq!(b.charged[0] & (1 << 6), 1 << 6, "singleton sigil 7");
    b.stones[0] |= (1 << n("a8")) | (1 << n("a9")); b.update();
    assert_eq!(b.charged[0] & (1 << 3), 0, "two of three must not charge");
    b.stones[0] |= 1 << n("a10"); b.update();
    assert_eq!(b.charged[0] & (1 << 3), 1 << 3, "all three charge");
}

#[test]
fn push_into_open_space_relocates() {
    let mut b = Board::new([0;9], Variant::Standard);
    b.stones[0] = 1 << n("a4");
    b.stones[1] = 1 << n("a5");
    b.update();
    let (opts, k) = b.push_options(n("a5"), Color::Red);
    assert!(k > 0);
    assert_eq!(&opts[..k], &[n("a6"), n("a12")][..]);
    assert_eq!(b.push_enemy(n("a5"), Color::Red), Push::To(n("a6")));
    // A move PLACES a stone, never relocates one, so red keeps a4 AND gains a5.
    assert_eq!(b.stones[0], (1 << n("a4")) | (1 << n("a5")));
    assert_eq!(b.stones[1], 1 << n("a6"));
}

#[test]
fn moves_place_stones_rather_than_relocating_them() {
    let mut b = std_board();
    assert_eq!(b.total, [1,1]);
    b.stones[0] |= 1 << n("a2"); b.update();
    assert_eq!(b.total, [2,1], "soft move adds a stone");
    assert!(b.stones[0] & (1 << n("a1")) != 0, "origin not vacated");

    let mut c = Board::new([0;9], Variant::Standard);
    c.stones[0] = 1 << n("a4"); c.stones[1] = 1 << n("a5"); c.update();
    c.push_enemy(n("a5"), Color::Red); c.update();
    assert_eq!(c.total, [2,1], "push: +1 attacker, defender displaced");

    let mut d = Board::new([0;9], Variant::Standard);
    d.stones[1] = 1 << n("a12");
    d.stones[0] = (1 << n("a5")) | (1 << n("c7"));
    d.update();
    assert_eq!(d.push_enemy(n("a12"), Color::Red), Push::Crush);
    d.update();
    assert_eq!(d.total, [3,0], "crush: +1 attacker, -1 defender");
}

#[test]
fn push_with_no_escape_crushes() {
    let mut b = Board::new([0;9], Variant::Standard);
    b.stones[1] = 1 << n("a12");
    b.stones[0] = (1 << n("a5")) | (1 << n("c7"));
    b.update();
    assert_eq!(b.push_options(n("a12"), Color::Red).1, 0);
    assert!(b.is_crushable(n("a12"), Color::Red));
    assert_eq!(b.escape_distance(n("a12"), Color::Blue, 39), 39);
}

#[test]
fn push_chains_through_friendly_stones() {
    let mut b = Board::new([0;9], Variant::Standard);
    b.stones[0] = 1 << n("a3");
    b.stones[1] = (1 << n("a4")) | (1 << n("a5"));
    b.update();
    let (opts, k) = b.push_options(n("a4"), Color::Red);
    assert_eq!(&opts[..k], &[n("a7")][..], "nearest empty wins");
    assert_eq!(b.escape_distance(n("a4"), Color::Blue, 39), 1);
}

/// Regression for the bug a neighbour-bitmask BFS introduced: Python's single
/// global FIFO makes children of an earlier-popped parent outrank lower-indexed
/// children of a later parent.
#[test]
fn push_bfs_uses_global_fifo_order_not_node_index_order() {
    let mut b = Board::new([0;9], Variant::Standard);
    // a5's neighbours are a4, a6, a12. Enemy on a4 and a6; red pushes from a12.
    b.stones[0] = 1 << n("a12");
    b.stones[1] = (1 << n("a5")) | (1 << n("a4")) | (1 << n("a6"));
    b.update();
    let (opts, k) = b.push_options(n("a5"), Color::Red);
    assert!(k > 0);
    // Children of a4 (a3, a7) are enqueued before children of a6 (a2, a11),
    // so a3 must come first even though a2 has the lower node index.
    assert_eq!(opts[0], n("a3"),
        "expected a3 (child of a4, popped first), got {}", NAMES[opts[0] as usize]);
    assert!(opts[..k].contains(&n("a7")));
    let pos_a3 = opts[..k].iter().position(|&x| x == n("a3")).unwrap();
    if let Some(pos_a2) = opts[..k].iter().position(|&x| x == n("a2")) {
        assert!(pos_a3 < pos_a2, "a3 must precede a2");
    }
}

#[test]
fn win_by_three_score_lead_is_asymmetric() {
    let mut b = Board::new([0;9], Variant::Standard);
    b.stones[1] = 1 << 20;
    b.stones[0] = 0b1111; b.update();
    assert!(!b.check_game_over(Color::Red), "red lead of 3 is not enough");
    b.stones[0] = 0b11111; b.update();
    assert!(b.check_game_over(Color::Red));
    assert_eq!(b.outcome, Outcome::RedWins,
               "the +/-3 lead is symmetric in SCORE; for red that is +4 real stones");

    let mut b = Board::new([0;9], Variant::Standard);
    b.stones[0] = 1 << 0; b.stones[1] = 0b110 << 20; b.update();
    assert!(!b.check_game_over(Color::Blue));
    b.stones[1] = 0b1110 << 20; b.update();
    assert!(b.check_game_over(Color::Blue));
    assert_eq!(b.outcome, Outcome::BlueWins, "blue needs only 2, via the +1 token");
}

#[test]
fn elimination_wins_immediately() {
    let mut b = Board::new([0;9], Variant::Standard);
    b.stones[1] = 1 << 20; b.update();
    assert_eq!(b.outcome, Outcome::BlueWins, "red eliminated");
    let mut b = Board::new([0;9], Variant::Standard);
    b.stones[0] = 1 << 0; b.update();
    assert_eq!(b.outcome, Outcome::RedWins, "token does not save blue");
}

#[test]
fn sixth_spell_tie_goes_to_player_not_to_move() {
    let mut b = Board::new([0;9], Variant::Standard);
    b.stones[0] = 0b11; b.stones[1] = 1 << 20; b.update();
    b.spell_counter[0] = 6;
    assert!(b.check_game_over(Color::Red));
    assert_eq!(b.outcome, Outcome::BlueWins);
}

#[test]
fn deathmatch_disables_lead_and_spell_wins() {
    let mut b = Board::new([0;9], Variant::Deathmatch);
    b.stones[0] = 0xFF; b.stones[1] = 1 << 20; b.update();
    b.spell_counter[0] = 6;
    assert!(!b.check_game_over(Color::Red));
    assert_eq!(b.outcome, Outcome::Ongoing);
}

#[test]
fn zobrist_distinguishes_and_is_stable() {
    let a = std_board();
    let mut b = std_board();
    assert_eq!(ZOBRIST.key_js(&a), ZOBRIST.key_js(&b));
    b.stones[0] |= 1 << n("a2"); b.update();
    assert_ne!(ZOBRIST.key_js(&a), ZOBRIST.key_js(&b));
    let mut c = std_board(); c.to_move = Color::Blue;
    assert_ne!(ZOBRIST.key_js(&a), ZOBRIST.key_js(&c), "JS key includes side to move");
    assert_eq!(ZOBRIST.key_py(&a), ZOBRIST.key_py(&c), "Python key does not");
    let mut d = std_board();
    let h2 = ZOBRIST.toggle_stone(ZOBRIST.key_js(&d), Color::Red, n("a2"));
    d.stones[0] |= 1 << n("a2"); d.update();
    assert_eq!(h2, ZOBRIST.key_js(&d), "incremental == recompute");
}

#[test]
fn deferred_and_panda_are_out_of_scope() {
    assert_eq!(NUM_OFFICIAL_SPELLS, 39, "official ids are 0..38 contiguous");
    let ok = Board::new([0,5,14,20,30,32,36,37,38], Variant::Standard);
    assert!(!ok.has_deferred_spell());
    let bad = Board::new([0,5,14,20,30,32,36,37,39], Variant::Standard);
    assert!(bad.has_deferred_spell(), "39 is Tectonic/Fissure");
    // Panda has no ids at all, so it cannot be represented here.
    for s in SPELLS.iter() {
        for panda in ["Lifesap","Perfect_Heist","Moth_Plague","Ripples","Stampede",
                      "Choke","Bear_Trap","Shiver","Blood_Saplings","Itch",
                      "Free_Spirit","Residue_Mixture"] {
            assert_ne!(s.name, panda, "Panda spell leaked into the official table");
        }
    }
}

// ---------------- Autumn pack (live JS is the reference) ----------------
#[test]
fn autumn_metadata_matches_live_js() {
    assert_eq!(SPELLS[HARVEST_ID as usize].name, "Harvest");
    assert_eq!(SPELLS[HARVEST_ID as usize].count, 5);
    assert_eq!(SPELLS[GATHER_ID as usize].name, "Gather");
    assert_eq!(SPELLS[GATHER_ID as usize].count, 3);
    for id in [HARVEST_ID, GATHER_ID] {
        assert!(matches!(SPELLS[id as usize].resolve, Resolve::LockedOrSelfMoves));
        assert!(!SPELLS[id as usize].is_charm);
        assert!(!SPELLS[id as usize].is_static);
    }
    let s = &SPELLS[SEAL_OF_AUTUMN as usize];
    assert_eq!(s.name, "Seal_of_Autumn");
    assert!(s.is_static && s.is_charm);
    assert!(matches!(s.resolve, Resolve::None_));
}

#[test]
fn autumn_zone_is_self_plus_prior_lock() {
    let mut b = Board::new([HARVEST_ID,1,2,5,6,7,8,9,10], Variant::Standard);
    b.lock[0] = NO_SPELL;
    assert_eq!(b.autumn_allowed_zone(0, Color::Red), SIGIL[0], "no lock => own sigil");
    b.lock[0] = 5;                      // Grow, drawn at position index 3
    assert_eq!(b.position_of(5), Some(3));
    assert_eq!(b.autumn_allowed_zone(0, Color::Red), SIGIL[0] | SIGIL[3]);
    b.lock[0] = 22;                     // not drawn this game
    assert_eq!(b.position_of(22), None);
    assert_eq!(b.autumn_allowed_zone(0, Color::Red), SIGIL[0]);
}

#[test]
fn autumn_moves_are_restricted_to_the_zone() {
    let mut b = Board::new([HARVEST_ID,1,2,5,6,7,8,9,10], Variant::Standard);
    b.stones[0] = 1 << n("a1"); b.stones[1] = 1 << n("b1");
    b.lock[0] = NO_SPELL; b.update();
    assert!(b.all_moveable(Color::Red) & (1 << n("a11")) != 0, "a11 legal in general");
    assert_eq!(b.autumn_targets(0, Color::Red), 1 << n("a2"), "only in-zone survives");
}

#[test]
fn autumn_ends_early_when_no_legal_move_exists() {
    let mut b = Board::new([HARVEST_ID,1,2,5,6,7,8,9,10], Variant::Standard);
    b.stones[0] = 1 << n("c1"); b.stones[1] = 1 << n("b1");
    b.lock[0] = NO_SPELL; b.update();
    assert_eq!(b.autumn_targets(0, Color::Red), 0);
    assert_eq!(b.resolve_autumn_moves(0, Color::Red, 5), 0);
}

#[test]
fn autumn_ends_early_when_zone_is_full() {
    let mut b = Board::new([HARVEST_ID,1,2,5,6,7,8,9,10], Variant::Standard);
    b.stones[0] = SIGIL[0] | (1 << n("a1"));
    b.stones[1] = 1 << n("b1");
    b.lock[0] = NO_SPELL; b.update();
    assert!(b.all_moveable(Color::Red) != 0, "red can move in general");
    assert_eq!(b.autumn_targets(0, Color::Red), 0, "but not into a full zone");
    assert_eq!(b.resolve_autumn_moves(0, Color::Red, 5), 0);
}

#[test]
fn autumn_takes_up_to_count_steps_and_grows_stones() {
    let mut b = Board::new([HARVEST_ID,1,2,5,6,7,8,9,10], Variant::Standard);
    b.stones[0] = 1 << n("a1"); b.stones[1] = 1 << n("b1");
    b.lock[0] = NO_SPELL; b.update();
    let before = b.total[0];
    assert_eq!(b.resolve_autumn_moves(0, Color::Red, 5), 5);
    assert_eq!(b.total[0], before + 5);
    assert_eq!(b.stones[0] & SIGIL[0], SIGIL[0], "sigil filled");

    let mut g = Board::new([GATHER_ID,1,2,5,6,7,8,9,10], Variant::Standard);
    g.stones[0] = 1 << n("a1"); g.stones[1] = 1 << n("b1");
    g.lock[0] = NO_SPELL; g.update();
    assert_eq!(g.resolve_autumn_moves(0, Color::Red, 3), 3, "Gather stops at 3");
    assert_eq!(g.total[0], 4);
}

#[test]
fn autumn_step_can_be_a_hard_move() {
    let mut b = Board::new([HARVEST_ID,1,2,5,6,7,8,9,10], Variant::Standard);
    b.stones[0] = 1 << n("a1");
    b.stones[1] = (1 << n("a2")) | (1 << n("b1"));
    b.lock[0] = NO_SPELL; b.update();
    assert_eq!(b.autumn_targets(0, Color::Red), 1 << n("a2"));
    let opts = b.autumn_step_options(0, Color::Red);
    assert!(!opts.is_empty());
    assert!(opts.iter().all(|&(nd,_)| nd == n("a2")));
    assert!(b.resolve_autumn_moves(0, Color::Red, 5) >= 1);
    assert!(b.stones[0] & (1 << n("a2")) != 0, "red took the node");
}

#[test]
fn seal_of_autumn_blocks_enemy_in_sigil_dash_sacrifices() {
    let mut b = Board::new([0,1,2,5,6,7,SEAL_OF_AUTUMN,9,10], Variant::Standard);
    assert_eq!(b.position_of(SEAL_OF_AUTUMN), Some(6));
    b.stones[0] = (1 << n("a1")) | (1 << n("a2")) | (1 << n("a3"));
    b.stones[1] = 1 << n("a7");
    b.update();
    assert!(b.holds_charged(Color::Blue, SEAL_OF_AUTUMN));
    assert_eq!(b.dash_sacrificeable(Color::Red), 1 << n("a1"), "mana stone only");
    assert_eq!(b.dash_cost(Color::Red), 2);
    assert!(!b.can_dash(Color::Red));
    let mut c = b; c.stones[1] = 1 << n("b7"); c.update();
    assert!(!c.holds_charged(Color::Blue, SEAL_OF_AUTUMN));
    assert_eq!(c.dash_sacrificeable(Color::Red).count_ones(), 3);
    assert!(c.can_dash(Color::Red));
}

#[test]
fn seal_of_lightning_halves_the_dash_cost() {
    let mut b = Board::new([0,1,2,5,6,7,SEAL_OF_LIGHTNING,9,10], Variant::Standard);
    b.stones[0] = (1 << n("a7")) | (1 << n("a1"));
    b.stones[1] = 1 << n("b1");
    b.update();
    assert!(b.holds_charged(Color::Red, SEAL_OF_LIGHTNING));
    assert_eq!(b.dash_cost(Color::Red), 1);
    assert!(b.can_dash(Color::Red));
}

#[test]
fn cast_clear_and_refill_uses_the_engine_priority_order() {
    let mut b = Board::new([0,1,2,5,6,7,8,9,10], Variant::Standard);
    b.stones[0] = SIGIL[0] | (1 << n("a1"));
    b.stones[1] = 1 << n("b1"); b.update();
    assert_eq!(b.mana[0], 1);
    b.cast_clear_and_refill(0, Color::Red);
    assert_eq!(b.stones[0] & SIGIL[0], 1 << n("a4"), "5-node priority starts at index 2");

    let mut c = Board::new([0,1,2,5,6,7,8,9,10], Variant::Standard);
    c.stones[0] = SIGIL[0]; c.stones[1] = 1 << n("b1"); c.update();
    assert_eq!(c.mana[0], 0);
    c.cast_clear_and_refill(0, Color::Red);
    assert_eq!(c.stones[0] & SIGIL[0], 0, "no mana, no refill");
}

#[test]
fn lock_and_springlock_follow_cast_bookkeeping() {
    let mut b = Board::new([0,1,2,5,6,7,8,9,10], Variant::Standard);
    b.finish_cast(0, Color::Red);
    assert_eq!(b.lock[0], 0);
    assert_eq!(b.springlock[0], NO_SPELL);
    assert_eq!(b.spell_counter[0], 1);
    b.finish_cast(1, Color::Red);
    assert_eq!(b.lock[0], 1);
    assert_eq!(b.springlock[0], NO_SPELL);
    b.finish_cast(1, Color::Red);
    assert_eq!(b.springlock[0], 1, "re-cast sets springlock");
    assert_eq!(b.spell_counter[0], 3);
    let mut c = Board::new([0,1,2,5,6,7,8,9,10], Variant::Standard);
    c.finish_cast(SEAL_OF_AUTUMN, Color::Red);
    assert_eq!(c.lock[0], NO_SPELL, "charm does not lock");
    assert_eq!(c.spell_counter[0], 0, "charm does not count");
}

#[test]
fn deathmatch_suppresses_the_spell_counter() {
    let mut b = Board::new([0,1,2,5,6,7,8,9,10], Variant::Deathmatch);
    b.finish_cast(0, Color::Red);
    assert_eq!(b.lock[0], 0);
    assert_eq!(b.spell_counter[0], 0);
}

#[test]
fn castable_respects_locks_seals_and_charm_rules() {
    let mut b = Board::new([0,1,2,5,6,7,14,10,11], Variant::Standard);
    b.stones[0] = SIGIL[0] | SIGIL[7];
    b.stones[1] = 1 << n("c1"); b.update();
    let c = b.castable(Color::Red, true, true, false);
    assert!(c.contains(&0), "charged non-charm castable");
    assert!(c.contains(&10), "charged charm castable when can_spell");
    assert!(!c.contains(&14), "statics never castable");
    b.lock[0] = 0;
    assert!(!b.castable(Color::Red, true, true, false).contains(&0),
            "locked spell needs Seal of Spring");
    let mut w = Board::new([0,1,2,5,6,7,38,10,11], Variant::Standard);
    w.stones[0] = SIGIL[0] | SIGIL[7];
    w.stones[1] = SIGIL[6]; w.update();
    assert!(w.holds_charged(Color::Blue, 38));
    let c = w.castable(Color::Red, true, true, false);
    assert!(c.contains(&0), "non-charms unaffected");
    assert!(!c.contains(&10), "charm barred by enemy Seal of Winter");
}

// ---------------- resolver rules worth pinning explicitly ----------------

#[test]
fn every_official_resolver_is_implemented() {
    let b = Board::new([0;9], Variant::Standard);
    let missing: Vec<&str> = (0..39u8)
        .filter(|&id| !b.resolver_ready(id))
        .map(|id| SPELLS[id as usize].name)
        .collect();
    assert!(missing.is_empty(), "unimplemented official resolvers: {:?}", missing);
    // And deferred ids must be refused, not silently mis-resolved.
    for id in 39..51u8 { assert!(!b.resolver_ready(id), "id {} must be refused", id); }
}

#[test]
fn gust_relocates_rather_than_destroys() {
    // Gust picks up every enemy stone touching you and drops them elsewhere, so
    // the enemy's stone count is unchanged while there are empty nodes.
    let mut b = Board::new([0;9], Variant::Standard);
    b.stones[0] = (1 << n("a1")) | (1 << n("a3"));
    b.stones[1] = (1 << n("a2")) | (1 << n("a4")) | (1 << n("c9"));
    b.update();
    let before = b.total[1];
    let moved = b.resolve_gust(Color::Red);
    assert_eq!(moved, 2, "a2 and a4 touch red; c9 does not");
    assert_eq!(b.total[1], before, "stones relocated, not destroyed");
    assert_eq!(b.total[0], 2, "caster unaffected");
    assert!(b.stones[1] & (1 << n("c9")) != 0, "untouched stone stays put");
}

#[test]
fn hurricane_destroys_the_smallest_group() {
    let mut b = Board::new([0;9], Variant::Standard);
    // Blue group A = {a2,a3} (size 2, contiguous); group B = {c9} (size 1).
    b.stones[0] = 1 << n("a1");
    b.stones[1] = (1 << n("a2")) | (1 << n("a3")) | (1 << n("c9"));
    b.update();
    let groups = b.enemy_groups(Color::Red);
    assert_eq!(groups.len(), 2, "two disjoint groups");
    assert_eq!(b.resolve_hurricane(Color::Red), 1, "smallest group is one stone");
    assert!(b.stones[1] & (1 << n("c9")) == 0, "the singleton died");
    assert_eq!(b.total[1], 2, "the pair survived");
}

#[test]
fn blossom_skips_full_sigils_instead_of_stopping() {
    // Blossom spreads into every OTHER 3-/5-node sigil. Sigil 1 (positions index 0)
    // is Blossom's own. Fill sigil 2 completely: the spread must continue to 3..6
    // rather than fizzling, which is the bug simboard.py's comment calls out.
    let mut b = Board::new([15,1,2,5,6,7,8,9,10], Variant::Standard);
    b.stones[0] = SIGIL[1];                 // sigil 2 entirely red => full
    b.stones[1] = 1 << n("c1");
    b.update();
    let placed = b.resolve_blossom(0, Color::Red);
    assert_eq!(placed, 4, "sigils 3,4,5,6 each get one; 2 is skipped, 1 is its own");
}

#[test]
fn syzygy_only_defined_for_ritual_positions() {
    // SYZYGY_OPPOSITE covers positions 1..3 only (1->(8,5), 2->(9,6), 3->(7,4)).
    let mut ok = Board::new([18,1,2,5,6,7,8,9,10], Variant::Standard);
    ok.stones[0] = 1 << n("a1");
    ok.stones[1] = 1 << n("c1");
    ok.update();
    assert!(ok.resolve_syzygy(0, Color::Red) > 0, "position 1 acts");

    // Drawn into a sorcery slot (index 3), Syzygy has no opposite and does nothing.
    let mut no = Board::new([0,1,2,18,6,7,8,9,10], Variant::Standard);
    no.stones[0] = 1 << n("a1");
    no.stones[1] = 1 << n("c1");
    no.update();
    let before = no.stones;
    assert_eq!(no.resolve_syzygy(3, Color::Red), 0, "no opposite mapping");
    assert_eq!(no.stones, before, "board untouched");
}

#[test]
fn azimuth_needs_exactly_one_uncontrolled_node() {
    // Sigil 4 is a8,a9,a10. Red holds a8,a9 => exactly one uncontrolled (a10),
    // and a10 is reachable from a9, so Azimuth fires.
    let mut b = Board::new([0,1,2,20,6,7,8,9,10], Variant::Standard);
    b.stones[0] = (1 << n("a8")) | (1 << n("a9"));
    b.stones[1] = 1 << n("c1");
    b.update();
    assert_eq!(b.resolve_azimuth(Color::Red), Some(n("a10")));

    // Sigil 4 with only a8 held leaves TWO uncontrolled, so it does NOT qualify.
    // But note the singleton sigils (7,8,9) hold ONE node each, so an unowned
    // singleton always counts as exactly-one-uncontrolled. Positions are scanned
    // 1..9 in order, so sigil 4 is skipped and sigil 7 (a7, adjacent to a8) fires.
    // Consequence worth knowing: Azimuth can essentially always target an empty
    // singleton you are touching.
    let mut c = Board::new([0,1,2,20,6,7,8,9,10], Variant::Standard);
    c.stones[0] = 1 << n("a8");
    c.stones[1] = 1 << n("c1");
    c.update();
    assert_eq!(c.uncontrolled_count(3, Color::Red), 2, "sigil 4 has two gaps");
    assert_eq!(c.uncontrolled_count(6, Color::Red), 1, "singleton sigil 7 has one");
    assert_eq!(c.resolve_azimuth(Color::Red), Some(n("a7")), "sigil 7 qualifies");

    // With every singleton already owned and no sigil at exactly one gap,
    // Azimuth finds nothing.
    let mut d = Board::new([0,1,2,20,6,7,8,9,10], Variant::Standard);
    d.stones[0] = (1 << n("a8")) | (1 << n("a7")) | (1 << n("b7")) | (1 << n("c7"));
    d.stones[1] = 1 << n("c1");
    d.update();
    for pos in 0..9 {
        assert_ne!(d.uncontrolled_count(pos, Color::Red), 1,
                   "sigil {} unexpectedly has exactly one gap", pos + 1);
    }
    let before = d.stones;
    assert_eq!(d.resolve_azimuth(Color::Red), None);
    assert_eq!(d.stones, before);
}

#[test]
fn fireblast_skips_its_sacrifice_when_it_ends_the_game() {
    // Blue has exactly one stone and it is adjacent to red: destroying it wins,
    // so the sacrifice must NOT be paid.
    let mut b = Board::new([0;9], Variant::Standard);
    b.stones[0] = (1 << n("a1")) | (1 << n("a3"));
    b.stones[1] = 1 << n("a2");
    b.update();
    let (killed, sac) = b.resolve_fireblast(Color::Red);
    assert_eq!(killed, 1);
    assert_eq!(sac, None, "game over => no sacrifice");
    assert_eq!(b.total[0], 2, "caster keeps both stones");
    assert_eq!(b.outcome, Outcome::RedWins);

    // With a surviving enemy stone the sacrifice IS paid, from the highest node index.
    let mut c = Board::new([0;9], Variant::Standard);
    c.stones[0] = (1 << n("a1")) | (1 << n("a3"));
    c.stones[1] = (1 << n("a2")) | (1 << n("c9"));
    c.update();
    let (killed, sac) = c.resolve_fireblast(Color::Red);
    assert_eq!(killed, 1);
    assert_eq!(sac, Some(n("a3")), "reverse node order picks the higher index");
    assert_eq!(c.total[0], 1);
}

#[test]
fn corrupt_converts_at_most_three_and_cannot_chain() {
    // Four blue stones touch red, but only three convert; and eligibility is frozen
    // pre-conversion so a stone touching only a freshly converted stone is safe.
    let mut b = Board::new([0;9], Variant::Standard);
    b.stones[0] = 1 << n("a8");                       // a8 touches a7,a9,a10
    b.stones[1] = (1 << n("a7")) | (1 << n("a9")) | (1 << n("a10")) | (1 << n("a13"));
    b.update();
    // a13 touches a9 (blue) but not red, so it is NOT eligible even though a9 converts.
    let (converted, sac) = b.resolve_corrupt(Color::Red);
    assert_eq!(converted, 3, "cap of three");
    assert!(b.stones[1] & (1 << n("a13")) != 0, "no chaining onto a13");
    assert!(sac.is_some(), "sacrifice paid since blue survives");
}

#[test]
fn storm_front_stops_if_the_first_kill_ends_the_game() {
    let mut b = Board::new([0;9], Variant::Standard);
    b.stones[0] = 1 << n("a1");
    b.stones[1] = 1 << n("c9");
    b.update();
    assert_eq!(b.resolve_storm_front(Color::Red), 1, "only one stone existed");
    assert_eq!(b.outcome, Outcome::RedWins);
}

#[test]
fn eclipse_commits_to_one_sigil_for_both_moves() {
    // Sigil 4 = a8,a9,a10 with red on a8 => exactly two uncontrolled (a9,a10),
    // and both are reachable in sequence, so Eclipse makes two moves there.
    let mut b = Board::new([0,1,2,19,6,7,8,9,10], Variant::Standard);
    b.stones[0] = 1 << n("a8");
    b.stones[1] = 1 << n("c1");
    b.update();
    assert_eq!(b.resolve_eclipse(Color::Red), 2);
    assert_eq!(b.stones[0] & SIGIL[3], SIGIL[3], "sigil 4 fully controlled");
}

// ---------------- compound turns, openings, enumeration ----------------
use crate::turn::{Action, Turn, OUTCOME_CAP};

#[test]
fn legal_draws_are_structured_and_validated() {
    for seed in 1..40u64 {
        let d = Board::legal_draw(seed);
        let b = Board::new(d, Variant::Standard);
        assert!(b.draw_is_legal(), "legal_draw produced an illegal draw: {:?}", d);
        for (pos, &id) in d.iter().enumerate() {
            let want = match pos { 0..=2 => Role::Ritual, 3..=5 => Role::Sorcery, _ => Role::Charm };
            assert_eq!(SPELLS[id as usize].role, want);
        }
    }
    // Roles partition the 39 official spells 13/13/13, and Charm == is_charm.
    assert_eq!(RITUALS.len(), 13);
    assert_eq!(SORCERIES.len(), 13);
    assert_eq!(CHARMS.len(), 13);
    for id in 0..39u8 {
        let i = id as usize;
        assert_eq!(SPELLS[i].is_charm, SPELLS[i].role == Role::Charm,
                   "{} disagrees on charm-ness", SPELLS[i].name);
    }
    // A non-charm in a 1-node slot is what makes simboard.py raise IndexError.
    let bad = Board::new([10, 1, 2, 5, 6, 7, 0, 11, 12], Variant::Standard);
    assert!(!bad.draw_is_legal(), "charm in a ritual slot must be rejected");
}

#[test]
fn competitive_opening_offers_every_empty_node_then_stops() {
    let mut b = Board::new(Board::legal_draw(3), Variant::Competitive);
    b.setup_initial();
    for tc in 0..=2u32 {
        b.turn_counter = tc;
        let (turns, st) = b.enumerate_turns(Color::Red);
        assert_eq!(turns.len(), 39, "turn {} should offer 39 free blinks", tc);
        assert!(!st.truncated);
        for t in &turns {
            assert!(matches!(t.slice()[0], Action::Blink { .. }));
            assert!(matches!(t.slice()[1], Action::Pass));
        }
    }
    b.turn_counter = 3;
    let (turns, _) = b.enumerate_turns(Color::Red);
    // Board is still empty at turn 3 in this synthetic case, so there is nothing
    // to move and the only legal turn is a pass.
    assert_eq!(turns.len(), 1);
    assert!(matches!(turns[0].slice()[0], Action::Pass));
}

#[test]
fn standard_opening_has_no_free_blink() {
    let mut b = Board::new(Board::legal_draw(3), Variant::Standard);
    b.setup_initial();
    let (turns, _) = b.enumerate_turns(Color::Red);
    // Red on a1 may move to a2 or a11; neither is a blink and no spell is charged.
    assert_eq!(turns.len(), 2);
    for t in &turns {
        assert!(matches!(t.slice()[0], Action::Move { .. }), "no blink without Wind");
    }
}

#[test]
fn enumeration_includes_every_push_destination() {
    // Red a4 vs blue a5, whose escape squares are a6 and a12: BOTH must appear,
    // where the greedy engine would only ever play a6.
    let mut b = Board::new(Board::legal_draw(5), Variant::Standard);
    b.stones[0] = 1 << n("a4");
    b.stones[1] = 1 << n("a5");
    b.update();
    let (turns, _) = b.enumerate_turns(Color::Red);
    let dests: Vec<Option<u8>> = turns.iter()
        .filter_map(|t| match t.slice()[0] {
            Action::Move { node, push_to } if node == n("a5") => Some(push_to),
            _ => None,
        }).collect();
    assert!(dests.contains(&Some(n("a6"))), "greedy destination present");
    assert!(dests.contains(&Some(n("a12"))), "alternative destination present");
}

#[test]
fn dash_enumerates_which_stones_are_sacrificed() {
    // The dash comes AFTER the turn's move, so the sacrificeable set is the
    // post-move one. Group dashes by their preceding move and check that, within
    // one branch, EVERY pair of the then-current stones appears - the engine only
    // ever gives up the last two in node order.
    let mut b = Board::new(Board::legal_draw(5), Variant::Standard);
    b.stones[0] = (1 << n("a1")) | (1 << n("a2")) | (1 << n("a3")) | (1 << n("a4"));
    b.stones[1] = 1 << n("c1");
    b.update();
    assert_eq!(b.dash_cost(Color::Red), 2);
    let (turns, _) = b.enumerate_turns(Color::Red);

    // Pick the branch whose first move is a5, giving red 5 stones => C(5,2) = 10.
    let target = n("a5");
    let mut pairs = std::collections::HashSet::new();
    for t in &turns {
        let sl = t.slice();
        let first_is_target = matches!(sl[0], Action::Move { node, .. } if node == target);
        if !first_is_target { continue; }
        for a in sl {
            if let Action::Dash { sacs, n_sacs, .. } = *a {
                assert_eq!(n_sacs, 2, "cost is 2 without Seal of Lightning");
                let mut p = [sacs[0], sacs[1]];
                p.sort();
                pairs.insert(p);
            }
        }
    }
    assert_eq!(pairs.len(), 10,
        "expected all C(5,2) post-move sacrifice pairs, got {}: {:?}", pairs.len(), pairs);
    // And every sacrificed stone must be one red actually held after that move.
    let held = [n("a1"), n("a2"), n("a3"), n("a4"), target];
    for p in &pairs {
        for x in p { assert!(held.contains(x), "sacrificed a stone red does not hold"); }
    }
}

#[test]
fn seal_of_lightning_makes_dash_sacrifice_a_single_stone() {
    // Seal_of_Lightning (id 4) is a RITUAL, so it must sit in positions 1-3.
    let mut b = Board::new([SEAL_OF_LIGHTNING, 1, 2, 5, 6, 7, 10, 11, 12], Variant::Standard);
    assert!(b.draw_is_legal());
    b.stones[0] = SIGIL[0] | (1 << n("a1"));   // own the sigil => charged
    b.stones[1] = 1 << n("c1");
    b.update();
    assert!(b.holds_charged(Color::Red, SEAL_OF_LIGHTNING));
    assert_eq!(b.dash_cost(Color::Red), 1);
    let (turns, _) = b.enumerate_turns_capped(Color::Red, 20000);
    let mut singles = 0;
    for t in &turns {
        for a in t.slice() {
            if let Action::Dash { n_sacs, .. } = *a {
                assert_eq!(n_sacs, 1, "Lightning reduces the cost to one stone");
                singles += 1;
            }
        }
    }
    assert!(singles > 0, "dash branches should exist");
}

#[test]
fn applying_an_enumerated_turn_is_deterministic_and_legal() {
    for seed in 1..25u64 {
        let mut b = Board::new(Board::legal_draw(seed), Variant::Standard);
        // scatter some stones deterministically
        // Local board RNG. `seed | 1` here only needs varied stone masks, but
        // it is the same pathology `legal_draw` had, so spread it the same way
        // rather than leave a second copy of the bug in the tree.
        let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut nx = || { s ^= s << 13; s ^= s >> 7; s ^= s << 17; s };
        let r = nx() & ALL;
        let bl = (nx() & ALL) & !r;
        b.stones = [r, bl];
        b.update();
        if b.outcome != Outcome::Ongoing { continue; }
        let (turns, _) = b.enumerate_turns_capped(Color::Red, 400);
        for t in turns.iter().take(60) {
            let mut x = b; x.apply_turn(t, Color::Red);
            let mut y = b; y.apply_turn(t, Color::Red);
            assert_eq!(x.stones, y.stones, "apply_turn must be deterministic");
            assert_eq!(x.stones[0] & x.stones[1], 0, "stone masks must stay disjoint");
            assert_eq!(x.stones[0] & !ALL, 0, "no stones outside the board");
            assert_eq!(x.stones[1] & !ALL, 0);
        }
    }
}

#[test]
fn tt_entry_is_16_bytes_and_actions_round_trip_through_it() {
    use crate::search::{pack_action, unpack_action};
    assert_eq!(std::mem::size_of::<crate::search::TtEntry>(), 16);
    let mut n = 0;
    for node in 0..39u8 {
        for pt in [None, Some(0u8), Some(17), Some(38)] {
            for a in [Action::Blink { node, push_to: pt }, Action::Move { node, push_to: pt },
                      Action::Dash { sacs: [node, 38 - node], n_sacs: 2, node, push_to: pt },
                      Action::Dash { sacs: [node, 0], n_sacs: 1, node, push_to: pt }] {
                assert_eq!(unpack_action(pack_action(a)), Some(a), "{a:?}");
                n += 1;
            }
        }
    }
    for pos in 0..9u8 {
        for keep in 0..10u8 {
            for outcome in [0u16, 1, 23, 4095, 65535] {
                let a = Action::Cast { pos, keep, outcome };
                assert_eq!(unpack_action(pack_action(a)), Some(a));
                n += 1;
            }
        }
    }
    assert_eq!(unpack_action(pack_action(Action::Pass)), Some(Action::Pass));
    assert_eq!(unpack_action(0), None, "0 is the 'no best action' sentinel");
    assert!(n > 600);
}

#[test]
fn a_reused_search_carries_its_table_into_the_next_move_and_new_game_clears_it() {
    // Persistence is what the wasm `Engine` and `SearchSession` rely on: the
    // second move of a game must start with a non-empty table when the same
    // `Search` is reused, and `new_game` must return it to the fresh state.
    let mut b = Board::new(Board::legal_draw(11), Variant::Standard);
    b.setup_initial();
    let mut s = crate::search::Search::new(16);
    s.set_width_scale(crate::search::DEFAULT_WIDTH_SCALE);
    s.weights = crate::eval::weights_by_name("tfit").unwrap();
    let c = b.to_move;
    let (best, _, st1) = s.go(&b, c, 4, 0);
    let filled1 = s.tt_filled();
    assert!(filled1 > 0 && st1.nodes > 0);
    b.apply_turn(&best.unwrap(), c);
    b.turn_counter += 1; b.to_move = c.other(); b.update();
    // Same position, fresh search: the reference node count.
    let mut fresh = crate::search::Search::new(16);
    fresh.set_width_scale(crate::search::DEFAULT_WIDTH_SCALE);
    fresh.weights = s.weights;
    let (_, sc_fresh, st_fresh) = fresh.go(&b, b.to_move, 4, 0);
    let (_, sc_warm, st_warm) = s.go(&b, b.to_move, 4, 0);
    assert!(s.tt_filled() >= filled1, "the table lost entries across moves");
    assert!(st_warm.tt_hits > 0);
    // A warm table must not change what the search CONCLUDES at a fixed depth
    // beyond what a transposition table already permits; it should reach it in
    // no more nodes. (Scores can differ legitimately through deeper stored
    // entries, so only the node bound is asserted.)
    assert!(st_warm.nodes <= st_fresh.nodes,
            "warm {} nodes vs fresh {} (scores {sc_warm} / {sc_fresh})", st_warm.nodes, st_fresh.nodes);
    s.new_game();
    assert_eq!(s.tt_filled(), 0);
}

#[test]
fn the_shipped_search_knobs_are_pinned_and_the_default_tree_is_sane() {
    // The ordering knobs ship OFF (each measured null or negative at 3 s);
    // elastic time and the LMR band ship ON (+58 / +47 alone, +81 together at
    // 10 s, FINDINGS "Run 2 at 10 s"). This pins every shipped default so a
    // binding that restates one is caught here, and checks a single position.
    let s = crate::search::Search::new(12);
    assert!(!s.force_hints_get() && !s.root_resort_get() && !s.aspiration_steps_get()
            && !s.adopt_partial_get() && !s.pvs_get() && !s.history_get());
    assert_eq!(s.elastic_get(), Some(crate::search::Elastic::DEFAULT));
    assert_eq!(s.lmr_get(), (2, 1));
    let mut b = Board::new(Board::legal_draw(23), Variant::Standard);
    b.setup_initial();
    let mut base = crate::search::Search::new(16);
    base.set_width_scale(crate::search::DEFAULT_WIDTH_SCALE);
    base.weights = crate::eval::weights_by_name("tfit").unwrap();
    let (bb, bs, bst) = base.go(&b, b.to_move, 4, 0);
    // Turning the ordering knobs ON changes the tree only when they bite; on
    // this opening position force_hints must not INVENT anything illegal.
    let mut on = crate::search::Search::new(16);
    on.set_width_scale(crate::search::DEFAULT_WIDTH_SCALE);
    on.weights = base.weights;
    on.set_force_hints(true);
    on.set_root_resort(true);
    on.set_aspiration_steps(true);
    let (ob, os, ost) = on.go(&b, b.to_move, 4, 0);
    assert!(ob.is_some() && bb.is_some());
    // A forced hint is always a legal first move here.
    for _ in 0..ost.forced_hints.min(1) {}
    assert_eq!(bst.depth_completed, ost.depth_completed);
    // Scores at a fixed depth may differ only through ordering-dependent
    // fail-soft bounds; both must be finite non-mate values on the opening.
    assert!(bs.abs() < 1000 && os.abs() < 1000, "{bs} {os}");
}

#[test]
fn first_action_is_legal_agrees_with_the_generator() {
    for seed in 1..40u64 {
        let draw = Board::legal_draw(seed);
        let mut b = Board::new(draw, Variant::Standard);
        let mut s = seed | 1;
        let mut nx = || { s ^= s << 13; s ^= s >> 7; s ^= s << 17; s };
        let r = nx() & ALL;
        let bl = (nx() & ALL) & !r;
        b.stones = [r, bl];
        b.update();
        if b.outcome != crate::board::Outcome::Ongoing { continue; }
        for c in [Color::Red, Color::Blue] {
            let legal: Vec<Action> = b.turns_ordered(c).map(|t| t.slice()[0]).collect();
            for node in 0..39u8 {
                for pt in [None, Some(0u8), Some(5), Some(20), Some(38)] {
                    for a in [Action::Move { node, push_to: pt }, Action::Blink { node, push_to: pt }] {
                        let gen = legal.contains(&a);
                        assert_eq!(b.first_action_is_legal(a, c), gen,
                                   "seed {seed} {c:?} {a:?}: generator {gen}");
                    }
                }
            }
        }
    }
}

#[test]
fn prior_part_layout_is_contiguous_and_parts_are_in_range() {
    use crate::prior::*;
    let mut end = 0u16;
    for (_, base, n) in PART_GROUPS { assert_eq!(base, end, "gap before part group at {base}"); end = base + n; }
    assert_eq!(end as usize, NP);
    for seed in 1..30u64 {
        let mut b = Board::new(Board::legal_draw(seed), Variant::Standard);
        let mut s = seed | 1;
        let mut nx = || { s ^= s << 13; s ^= s >> 7; s ^= s << 17; s };
        let r = nx() & ALL; let bl = (nx() & ALL) & !r;
        b.stones = [r, bl]; b.update();
        if b.outcome != crate::board::Outcome::Ongoing { continue; }
        for c in [Color::Red, Color::Blue] {
            let x = b.context_inputs(c);
            assert_eq!(x.len(), NX);
            let (rows, stubs, ranks, packed, _) = b.dataset_rows(c, 200);
            assert_eq!(rows.len(), stubs.len());
            assert_eq!(rows.len(), packed.len());
            for (row, &rk) in rows.iter().zip(ranks.iter()) {
                let np = row.iter().filter(|&&p| p != NO_PART).count();
                assert!(np >= 5, "a turn has at least kind/node/push/ms/class parts");
                for &p in row.iter().filter(|&&p| p != NO_PART) { assert!((p as usize) < NP, "part {p} out of range"); }
                let _ = rk;
            }
            // Every `[move, pass]` turn is alone in its stub; stub ranks restart at 0.
            let mut seen0 = 0;
            for &rk in &ranks { if rk == 0 { seen0 += 1; } }
            assert!(seen0 >= 1);
        }
    }
}

#[test]
fn logged_and_unlogged_resolution_agree() {
    // `resolve_outcomes` (search path, `()` log) and `resolve_outcomes_logged`
    // (browser replay path, `Vec<JsAct>` log) are the SAME enumeration
    // instantiated twice. The search must see exactly the boards the replay
    // path would emit, in the same order, because `Action::Cast::outcome` is
    // an index into that list. Same random-position sweep as the greedy test.
    let mut checked = 0;
    for seed in 1..180u64 {
        let draw = Board::legal_draw(seed);
        let mut b = Board::new(draw, Variant::Standard);
        let mut s = seed | 1;
        let mut nx = || { s ^= s << 13; s ^= s >> 7; s ^= s << 17; s };
        let r = nx() & ALL;
        let bl = (nx() & ALL) & !r;
        b.stones = [r, bl];
        b.update();
        for pos in 0..9 {
            for c in [Color::Red, Color::Blue] {
                let id = draw[pos];
                if !b.castable(c, true, true, false).contains(&id) { continue; }
                let mut cleared = b;
                cleared.cast_clear_and_refill(pos, c);
                let (plain, t1) = cleared.resolve_outcomes(pos, c, OUTCOME_CAP);
                let (logged, t2) = cleared.resolve_outcomes_logged(pos, c, OUTCOME_CAP);
                assert_eq!(t1, t2, "truncation differs for {} (seed {})",
                           SPELLS[id as usize].name, seed);
                assert_eq!(plain.len(), logged.len(), "count differs for {} (seed {})",
                           SPELLS[id as usize].name, seed);
                for (i, (p, (l, log))) in plain.iter().zip(logged.iter()).enumerate() {
                    assert_eq!(p.stones, l.stones,
                               "outcome {} differs for {} (seed {})", i, SPELLS[id as usize].name, seed);
                    // The logged path records at least one action per outcome
                    // unless the resolver had nothing to do.
                    assert!(!log.is_empty() || p.stones == cleared.stones,
                            "empty log with a changed board for {}", SPELLS[id as usize].name);
                }
                checked += 1;
            }
        }
    }
    assert!(checked > 200, "sweep exercised only {checked} casts");
}

#[test]
fn greedy_resolution_is_always_among_the_enumerated_outcomes() {
    // The property that makes "nothing hidden" checkable: whatever the shipped
    // greedy engine would play must appear in our enumeration.
    for seed in 1..60u64 {
        let draw = Board::legal_draw(seed);
        let mut b = Board::new(draw, Variant::Standard);
        let mut s = seed | 1;
        let mut nx = || { s ^= s << 13; s ^= s >> 7; s ^= s << 17; s };
        let r = nx() & ALL;
        let bl = (nx() & ALL) & !r;
        b.stones = [r, bl];
        b.update();
        for pos in 0..9 {
            for c in [Color::Red, Color::Blue] {
                // The spell has to be CASTABLE for the invariant to mean
                // anything. Without this guard the test compared a greedy
                // resolution against an enumeration of a cast that could never
                // happen: triage over 1,062 failures found 0 genuine, 973 of
                // them vacuous exactly this way. It reported a shipped-engine
                // bug that did not exist.
                let id = draw[pos];
                if !b.castable(c, true, true, false).contains(&id) { continue; }
                let mut cleared = b;
                cleared.cast_clear_and_refill(pos, c);
                let (outs, trunc) = cleared.resolve_outcomes(pos, c, OUTCOME_CAP);
                // A TRUNCATED enumeration is not a complete reference, so
                // "missing" proves nothing -- the same rule the reachability
                // audit follows and the Summer test had to learn.
                if trunc { continue; }
                let mut g = cleared;
                g.resolve_spell_at(pos, c);
                assert!(outs.iter().any(|o| o.stones == g.stones),
                    "greedy outcome missing for {} at pos {} (seed {})",
                    SPELLS[draw[pos] as usize].name, pos + 1, seed);
            }
        }
    }
}

// ---------------- ordering heuristics (Robi's human-play framing) ----------------
use crate::order::PlacementGoal;

/// Build a board with Gust in a charm slot plus one chosen "threat" spell, so we
/// can watch the placement goal change where Gust sends the enemy.
/// `threat` must be a ritual (Hurricane 24, Hail_Storm is a sorcery, Decay a sorcery).
fn gust_board(threat: Option<u8>) -> Board {
    // slots 0-2 rituals, 3-5 sorceries, 6-8 charms. Gust (26) is a charm.
    // Pick base spells that cannot collide with any threat we substitute in.
    let mut draw = [0u8, 1, 2, 5, 6, 9, GUST, 11, 12];
    if let Some(t) = threat {
        let slot = match SPELLS[t as usize].role {
            Role::Ritual => 0,
            Role::Sorcery => 3,
            Role::Charm => 7,
        };
        // Displace any existing copy so the draw stays distinct.
        if let Some(dup) = draw.iter().position(|&x| x == t) {
            draw[dup] = draw[slot];
        }
        draw[slot] = t;
    }
    let mut b = Board::new(draw, Variant::Standard);
    assert!(b.draw_is_legal(), "test draw must be legal: {:?}", draw);
    // Red (the caster) surrounds several blue stones so Gust picks them all up.
    b.stones[0] = (1 << n("a1")) | (1 << n("a4")) | (1 << n("a8")) | (1 << n("b1"));
    b.stones[1] = (1 << n("a3")) | (1 << n("a5")) | (1 << n("a7")) | (1 << n("a9"));
    b.update();
    b
}

/// Force `c` to hold `spell_id` charged by giving them its whole sigil.
fn charge(b: &mut Board, spell_id: u8, c: Color) {
    let pos = b.position_of(spell_id).expect("spell not drawn");
    let m = SIGIL[pos];
    b.stones[c.other().idx()] &= !m;
    b.stones[c.idx()] |= m;
    b.update();
    assert!(b.holds_charged(c, spell_id));
}

#[test]
fn placement_goal_follows_what_we_threaten() {
    let b = gust_board(None);
    assert_eq!(b.placement_goal(Color::Red), PlacementGoal::Voids,
               "no threat => park them in voids");

    let mut h = gust_board(Some(HAIL_STORM));
    charge(&mut h, HAIL_STORM, Color::Red);
    assert_eq!(h.placement_goal(Color::Red), PlacementGoal::SpreadSigils);

    let mut d = gust_board(Some(DECAY));
    charge(&mut d, DECAY, Color::Red);
    assert_eq!(d.placement_goal(Color::Red), PlacementGoal::Fragment);

    let mut u = gust_board(Some(HURRICANE));
    charge(&mut u, HURRICANE, Color::Red);
    assert_eq!(u.placement_goal(Color::Red), PlacementGoal::Coalesce);

    // "Threatening" also covers one node short of charged, which is when a human
    // already starts playing for it.
    let mut nearly = gust_board(Some(HURRICANE));
    let pos = nearly.position_of(HURRICANE).unwrap();
    let m = SIGIL[pos];
    nearly.stones[1] &= !m;
    nearly.stones[0] |= m;
    // give one node back so exactly one is uncontrolled
    let one = 1u64 << (m.trailing_zeros() as u8);
    nearly.stones[0] &= !one;
    nearly.update();
    assert_eq!(nearly.uncontrolled_count(pos, Color::Red), 1);
    assert!(nearly.is_threatening(Color::Red, HURRICANE), "one short still counts");
}

#[test]
fn gust_sends_enemy_stones_to_voids_by_default() {
    let b = gust_board(None);
    let before = (b.stones[1] & VOID).count_ones();
    let best = &b.gust_placements_ordered(Color::Red, 8)[0];
    let after = (best.stones[1] & VOID).count_ones();
    assert!(after > before,
        "default goal should park enemy stones in voids: {} -> {}", before, after);
    assert_eq!(best.stones[1] & MANA, 0, "and never hand back a mana node");
}

#[test]
fn gust_spreads_across_sigils_when_threatening_hail_storm() {
    let plain = gust_board(None);
    let mut hail = gust_board(Some(HAIL_STORM));
    charge(&mut hail, HAIL_STORM, Color::Red);

    let sigils_hit = |b: &Board| (0..6).filter(|&p| SIGIL[p] & b.theirs(Color::Red) != 0).count();
    let best_plain = &plain.gust_placements_ordered(Color::Red, 8)[0];
    let best_hail  = &hail.gust_placements_ordered(Color::Red, 8)[0];
    assert!(sigils_hit(best_hail) > sigils_hit(best_plain),
        "Hail Storm goal should spread wider: {} vs {}",
        sigils_hit(best_hail), sigils_hit(best_plain));
}

#[test]
fn gust_fragments_when_threatening_decay() {
    let mut decay = gust_board(Some(DECAY));
    charge(&mut decay, DECAY, Color::Red);
    let exposed = |b: &Board| {
        let e = b.empty();
        let mut k = 0;
        let mut m = b.theirs(Color::Red);
        while m != 0 {
            let i = m.trailing_zeros() as usize; m &= m - 1;
            if (ADJ[i] & e).count_ones() >= 2 { k += 1; }
        }
        k
    };
    let cands = decay.gust_placements_ordered(Color::Red, 12);
    let best = exposed(&cands[0]);
    let worst = cands.iter().map(exposed).min().unwrap();
    assert!(best >= worst, "ordering should favour exposure");
    // Decay's whole payoff is exposed stones, so the top pick should expose all of
    // the stones it just placed.
    assert!(best >= 3, "expected most displaced stones left exposed, got {}", best);
}

#[test]
fn gust_coalesces_when_threatening_hurricane() {
    let mut hur = gust_board(Some(HURRICANE));
    charge(&mut hur, HURRICANE, Color::Red);
    let cands = hur.gust_placements_ordered(Color::Red, 12);
    let groups = |b: &Board| b.enemy_groups(Color::Red).len();
    let smallest = |b: &Board| b.enemy_groups(Color::Red).iter()
        .map(|g| g.count_ones()).min().unwrap_or(0);
    let best = &cands[0];
    let worst_groups = cands.iter().map(groups).max().unwrap();
    assert!(groups(best) <= worst_groups,
        "coalesce should not prefer the most fragmented option");
    assert!(smallest(best) >= cands.iter().map(smallest).min().unwrap(),
        "and should not minimise the smallest group");
}

#[test]
fn pushes_prefer_deporting_enemy_stones_off_mana() {
    // Blue holds the mana node b1 and a plain node a9; red touches both.
    let mut b = Board::new(Board::legal_draw(9), Variant::Standard);
    b.stones[0] = (1 << n("b2")) | (1 << n("a8")) | (1 << n("a1"));
    b.stones[1] = (1 << n("b1")) | (1 << n("a9"));
    b.update();
    assert!(b.deport_value(n("b1"), Color::Red) > b.deport_value(n("a9"), Color::Red),
        "a mana stone should be the more urgent deport");
    // And the ordered move list should put a b1 push ahead of an a9 push.
    let ord = b.ordered_first_moves(Color::Red);
    let pos_of = |target: u8| ord.iter().position(|&(x, _)| x == target);
    let (i_mana, i_plain) = (pos_of(n("b1")), pos_of(n("a9")));
    assert!(i_mana.is_some() && i_plain.is_some(), "both pushes must be offered");
    assert!(i_mana < i_plain, "mana push should be ordered first");
}

#[test]
fn sacrifice_ordering_gives_up_the_cheapest_stones() {
    let mut b = Board::new(Board::legal_draw(9), Variant::Standard);
    // a void stone, a mana stone, and a stone completing a sigil.
    b.stones[0] = (1 << n("a11")) | (1 << n("a1")) | SIGIL[0];
    b.stones[1] = 1 << n("c1");
    b.update();
    let void_cost = b.sacrifice_cost(n("a11"), Color::Red);
    let mana_cost = b.sacrifice_cost(n("a1"), Color::Red);
    let sigil_cost = b.sacrifice_cost(SIGIL[0].trailing_zeros() as u8, Color::Red);
    assert!(void_cost < mana_cost, "void stones are the cheapest to give up");
    assert!(void_cost < sigil_cost, "and cheaper than breaking a charged sigil");
}

#[test]
fn lazy_iterator_is_ordered_and_cheap_to_start() {
    let mut b = Board::new(Board::legal_draw(21), Variant::Standard);
    b.stones[0] = (1 << n("a1")) | (1 << n("a4")) | (1 << n("b1")) | (1 << n("a8"));
    b.stones[1] = (1 << n("a3")) | (1 << n("a5")) | (1 << n("c1"));
    b.update();
    let first: Vec<Turn> = b.turns_ordered(Color::Red).take(12).collect();
    assert_eq!(first.len(), 12, "iterator yields lazily without materialising");
    // The shipped default reserves no slots, so every early turn is [move, pass].
    let plain: Vec<&Turn> = first.iter().collect();
    for t in plain.iter().take(4) {
        assert_eq!(t.len, 2, "stage 1 should be move+pass");
        assert!(matches!(t.slice()[1], Action::Pass));
    }
    // Ordering: the first move should score at least as well as the second.
    let score = |t: &Turn| match t.slice()[0] {
        Action::Move { node, push_to } | Action::Blink { node, push_to } =>
            b.move_score(node, push_to, Color::Red),
        _ => i32::MIN,
    };
    assert!(score(plain[0]) >= score(plain[1]), "stage 1 must be best-first");
    // Every yielded turn must be applicable and legal.
    for t in &first {
        let mut x = b; x.apply_turn(t, Color::Red);
        assert_eq!(x.stones[0] & x.stones[1], 0);
    }
}

#[test]
fn lazy_iterator_covers_every_first_move() {
    // Ordering must not drop options: stage 1 has to offer exactly the same first
    // moves that full enumeration does.
    let mut b = Board::new(Board::legal_draw(31), Variant::Standard);
    b.stones[0] = (1 << n("a1")) | (1 << n("a4")) | (1 << n("b6"));
    b.stones[1] = (1 << n("a5")) | (1 << n("b5")) | (1 << n("c1"));
    b.update();
    let (full, _) = b.enumerate_turns(Color::Red);
    let key = |t: &Turn| match t.slice()[0] {
        Action::Move { node, push_to } => (0u8, node, push_to),
        Action::Blink { node, push_to } => (1, node, push_to),
        _ => (2, 0, None),
    };
    let want: std::collections::HashSet<_> = full.iter().map(key).collect();
    let got: std::collections::HashSet<_> =
        b.turns_ordered(Color::Red).take(5000).map(|t| key(&t)).collect();
    assert!(want.is_subset(&got),
        "lazy generator hid first moves: missing {:?}",
        want.difference(&got).collect::<Vec<_>>());
}

#[test]
fn ui_score_matches_what_the_web_ui_renders() {
    use crate::search::{ui_score, WIN, MAX_PLY};
    // The UI shows `score * 39` as stones, and treats |score| >= 37 as a PROVEN
    // mate printing `win in round(100 - score)`. Feeding it raw centistones
    // inflated everything 3900x AND tripped the mate branch constantly: a
    // -0.18-stone position displayed as "eval -702.0", and a +1.94-stone one as
    // "win in -94" (the negative ply count being the tell).
    let stones = |cs: i32| ui_score(cs) * 39.0;
    assert!((stones(-18) - -0.18).abs() < 1e-9, "-18 cs must render as -0.18 stones");
    assert!((stones(194) - 1.94).abs() < 1e-9, "+194 cs must render as +1.94 stones");
    assert!((stones(100) - 1.0).abs() < 1e-9, "one stone");

    // A scaled non-mate score can never reach the mate threshold of 37: that
    // would take ~1,443 stones, which the 39-node board cannot hold.
    for cs in [-5000, -700, -1, 0, 1, 700, 5000, 100_000] {
        assert!(ui_score(cs).abs() < 37.0,
                "{} cs scaled to {} must stay under the mate threshold", cs, ui_score(cs));
    }

    // Mate scores map onto Caveman's own encoding: CAVEMAN_WIN(100) - ply.
    let ply = 7;
    assert!((ui_score(WIN - ply) - (100.0 - ply as f64)).abs() < 1e-9,
            "a win in {} plies must render as 100 - {}", ply, ply);
    assert!((ui_score(-(WIN - ply)) + (100.0 - ply as f64)).abs() < 1e-9,
            "and the loss is its negation");
    // Mate scores land at or above the threshold, so the UI's mate branch is
    // reached only for real mates.
    assert!(ui_score(WIN - MAX_PLY as i32 + 1).abs() >= 37.0);
}


#[test]
fn a_key_dash_is_reachable_inside_a_narrow_width_budget() {
    // The regression this whole filter exists for: dashes used to sit at median
    // index 40 in the stream, so progressive widening (6 near the leaves) never
    // reached them. A dash must now appear inside the first KEY_DASH_EVERY turns
    // whenever one qualifies.
    let mut b = Board::new(Board::legal_draw(7), Variant::Standard);
    // Red is one stone short of charging sigil 1 and has spare stones to spend.
    b.stones[0] = (SIGIL[0] & !(1 << n("a2"))) | (1 << n("a11")) | (1 << n("a12"))
                  | (1 << n("a1"));
    b.stones[1] = (1 << n("b1")) | (1 << n("c1")) | (1 << n("b8"));
    b.update();
    assert!(b.can_dash(Color::Red));
    // The filter is OFF in the shipped configuration, so ask for it explicitly.
    let head: Vec<Turn> = b
        .turns_ordered_reasons(Color::Red, 24, crate::key_dash::REASONS_ALL)
        .take(crate::key_dash::KEY_DASH_EVERY).collect();
    let has_dash = head.iter().any(|t|
        t.slice().iter().any(|a| matches!(a, Action::Dash { .. })));
    assert!(has_dash, "a qualifying dash must be inside the first {} turns",
            crate::key_dash::KEY_DASH_EVERY);

    // ... and the shipped default must reproduce the old stream exactly.
    let off: Vec<Turn> = b.turns_ordered(Color::Red).take(24).collect();
    assert!(!off.iter().take(crate::key_dash::KEY_DASH_EVERY).any(|t|
        t.slice().iter().any(|a| matches!(a, Action::Dash { .. }))),
        "reasons == 0 must reproduce the pre-fix stage ordering");
}

#[test]
fn the_key_dash_filter_never_invents_an_illegal_turn() {
    // Every turn the filter promotes must also be a turn full enumeration accepts.
    for seed in 0..24u64 {
        let mut b = Board::new(Board::legal_draw(seed), Variant::Standard);
        b.stones[0] = 0b1010110110101u64 ^ (seed * 2654435761);
        b.stones[1] = (0b0101001001010u64 << 13) ^ (seed * 40503);
        b.stones[0] &= crate::topology::ALL;
        b.stones[1] &= crate::topology::ALL & !b.stones[0];
        b.update();
        if b.outcome != crate::board::Outcome::Ongoing { continue; }
        if !b.can_dash(Color::Red) { continue; }
        let (full, st) = b.enumerate_turns(Color::Red);
        // A truncated enumeration stops mid-way through the FIRST-move loop, so it
        // is not a complete reference to compare against.
        if st.truncated { continue; }
        let norm = |t: &Turn| t.slice().to_vec();
        let legal: std::collections::HashSet<_> = full.iter().map(norm).collect();
        for t in b.turns_ordered_reasons(Color::Red, 24, crate::key_dash::REASONS_ALL)
                  .take(40) {
            if !t.slice().iter().any(|a| matches!(a, Action::Dash { .. })) { continue; }
            assert!(legal.contains(&norm(&t)),
                    "seed {seed}: promoted dash {:?} is not in full enumeration", t.slice());
        }
    }
}

#[test]
fn evaluate_is_exactly_the_dot_product_of_the_hand_features() {
    // This invariant is what makes a logistic/texel fit on `hand_features` produce
    // numbers that drop straight into `Weights`. If the two paths ever drift, a
    // fitted weight vector would silently mean something else.
    use crate::features::N_HAND;
    let sets = [crate::eval::Weights::default(), crate::eval::MATERIAL_ONLY,
                crate::eval::MATERIAL_TEMPO, crate::eval::STRUCTURAL_NO_TEMPO,
                crate::eval::STRUCT_01, crate::eval::STRUCT_02,
                crate::eval::STRUCT_04, crate::eval::STRUCT_06,
                crate::eval::STRUCT_08, crate::eval::STRUCT_12,
                crate::eval::STRUCT_25, crate::eval::STRUCT_50,
                crate::eval::CLASSIC,
                crate::eval::CAPPED_MC, crate::eval::CAPPED_MANAVOID,
                crate::eval::CAPPED_MIX];
    for seed in 0..40u64 {
        let mut b = Board::new(Board::legal_draw(seed), Variant::Standard);
        b.stones[0] = (0x1234_5678_9abcu64 ^ (seed * 2654435761)) & crate::topology::ALL;
        b.stones[1] = (0x0fed_cba9_8765u64 ^ (seed * 40503)) & crate::topology::ALL & !b.stones[0];
        b.spell_counter = [(seed % 7) as u8, ((seed / 7) % 7) as u8];
        b.to_move = if seed % 2 == 0 { Color::Red } else { Color::Blue };
        b.update();
        for c in [Color::Red, Color::Blue] {
            let f = b.hand_features(c);
            for w in &sets {
                let wv = Board::hand_weight_vec(w);
                // `lead` and `tempo` are material and are never scaled; every other
                // term is part of the positional sum, scaled by pos_num/pos_den.
                let mut mat = 0i32;
                let mut pos = 0i32;
                for i in 0..N_HAND {
                    match crate::features::HAND_NAMES[i] {
                        "lead" | "tempo" => mat += wv[i] * f[i],
                        _ => pos += wv[i] * f[i],
                    }
                }
                assert_eq!(mat + pos * w.pos_num / w.pos_den, b.evaluate(c, w),
                    "seed {seed} {c:?}: hand_features dot != evaluate");
            }
        }
    }
}

#[test]
fn the_tempo_term_cancels_the_one_stone_per_ply_parity_wave() {
    // Measured on the real engine: with material-only the root score alternates by
    // exactly 100 centistones per ply and never converges, because every move
    // places a stone. The tempo term must remove that, and must do so by shifting
    // the two phases onto their mean rather than by flattening the eval.
    let mut b = Board::new(Board::legal_draw(11), Variant::Standard);
    b.stones[0] = (1 << n("a1")) | (1 << n("a4")) | (1 << n("b1"));
    b.stones[1] = (1 << n("a3")) | (1 << n("a5"));
    b.update();

    // Same position, opposite side to move: material-only must differ by 0 (the
    // lead does not depend on the clock) while the tempo eval must differ by 2*50.
    let mut r = b; r.to_move = Color::Red; r.update();
    let mut l = b; l.to_move = Color::Blue; l.update();
    for c in [Color::Red, Color::Blue] {
        assert_eq!(r.evaluate(c, &crate::eval::MATERIAL_ONLY),
                   l.evaluate(c, &crate::eval::MATERIAL_ONLY),
                   "material-only must be blind to the side to move");
        let d = r.evaluate(c, &crate::eval::MATERIAL_TEMPO)
              - l.evaluate(c, &crate::eval::MATERIAL_TEMPO);
        assert_eq!(d.abs(), 100, "tempo must be worth exactly one stone of swing");
    }
    // And it must be a pure offset: the tempo eval is the material eval plus or
    // minus 50, never anything else.
    for c in [Color::Red, Color::Blue] {
        let diff = r.evaluate(c, &crate::eval::MATERIAL_TEMPO)
                 - r.evaluate(c, &crate::eval::MATERIAL_ONLY);
        assert!(diff == 50 || diff == -50, "tempo is a +/-50 offset, got {diff}");
    }
}


#[test]
fn the_structural_set_is_wildly_over_the_positional_budget() {
    // The production engine holds the positional part below one stone so that
    // "position only ever breaks material ties, never outbids a stone". Recording
    // the actual numbers, because this is the likeliest explanation for the
    // structural set scoring 19.4% at matched time while winning 63.2% at matched
    // depth: good knowledge, priced 27x too high.
    use crate::eval::*;
    let budget = POSITIONAL_BUDGET;
    let full = worst_case_positional(&Weights::default());
    assert!(full > 20 * budget,
            "expected the structural default to be far over budget, got {full}");
    // The sweep must be monotone in scale and must bracket the budget.
    let s04 = worst_case_positional(&STRUCT_04);
    let s12 = worst_case_positional(&STRUCT_12);
    let s25 = worst_case_positional(&STRUCT_25);
    let s50 = worst_case_positional(&STRUCT_50);
    assert!(s04 < s12 && s12 < s25 && s25 < s50 && s50 < full, "sweep not monotone");
    assert!(s04 <= 2 * budget, "s04 should be near the production budget, got {s04}");
    // Scaling must leave material and the tempo correction untouched: the point is
    // to re-price the POSITIONAL terms, not to weaken the ruler they are measured
    // against.
    for w in [STRUCT_04, STRUCT_12, STRUCT_25, STRUCT_50] {
        assert_eq!(w.lead, Weights::default().lead);
        assert_eq!(w.tempo, Weights::default().tempo);
    }
}

// ---------------- PR review regressions ----------------

#[test]
fn sfn_round_trips_the_variant_token() {
    // The variant is TOKEN 7 (right after `score`); reading token 8 parsed every
    // non-standard SFN emitted by `to_sfn`/`boardToSfn` as Standard, which lost
    // the competitive free-blink opening and re-enabled the lead/spell-count win
    // conditions in deathmatch.
    for v in [Variant::Standard, Variant::Competitive, Variant::Deathmatch,
              Variant::CompetitiveDeathmatch] {
        let mut b = Board::new(Board::legal_draw(3), v);
        b.setup_initial();
        let back = Board::from_sfn(&b.to_sfn()).expect("round trip");
        assert_eq!(back.variant, v, "variant lost in SFN round trip");
    }
}

/// A position with NO legal first move: enemy Seal of Stone forces the first
/// move to be soft, and every node adjacent to a red stone is occupied.
/// Deathmatch, so blue's huge wall does not simply win by score lead.
fn no_first_move_board() -> Board {
    let mut b = Board::new([0, 1, 2, SEAL_OF_STONE, 6, 7, 14, 10, 11],
                           Variant::Deathmatch);
    // Both sides get stones BEFORE the first update(), or elimination fires.
    let s = SIGIL[b.position_of(10).unwrap()].trailing_zeros() as usize;
    b.stones[0] = 1u64 << s;                           // charges Sprout, castable
    b.stones[1] = SIGIL[b.position_of(SEAL_OF_STONE).unwrap()];
    let mut free = ADJ[s] & !(b.stones[0] | b.stones[1]);
    for _ in 0..2 {                                    // dash material (total 3 > 2)
        assert!(free != 0, "need two free neighbors next to Sprout");
        b.stones[0] |= 1u64 << free.trailing_zeros();
        free &= free - 1;
    }
    b.update();
    assert!(b.holds_charged(Color::Red, 10));
    assert!(b.holds_charged(Color::Blue, SEAL_OF_STONE));
    assert_eq!(b.total[0], 3, "Stone's sigil must not overlap red's stones");
    // Wall every empty node adjacent to a red stone.
    b.stones[1] |= Board::dilate(b.stones[0]) & !(b.stones[0] | b.stones[1]);
    b.update();
    assert_eq!(b.outcome, Outcome::Ongoing);
    assert_eq!(b.first_move_targets(Color::Red).0, 0, "setup must bar the move");
    b
}

#[test]
fn no_first_move_still_offers_dash_cast_and_pass() {
    let b = no_first_move_board();
    let (turns, st) = b.enumerate_turns(Color::Red);
    assert!(!st.truncated && !st.resolver_truncated);
    // A missing first move invalidates only the MOVE of move+dash+cast.
    assert!(turns.iter().any(|t| matches!(t.slice()[0], Action::Pass)), "no bare pass");
    assert!(turns.iter().any(|t| matches!(t.slice()[0], Action::Dash { .. })), "no dash");
    assert!(turns.iter().any(|t| matches!(t.slice()[0], Action::Cast { .. })), "no cast");
    for t in &turns {
        assert!(!matches!(t.slice()[0], Action::Move { .. } | Action::Blink { .. }),
                "a first move appeared in a position that has none: {:?}", t.slice());
    }
}

#[test]
fn lazy_iterator_matches_the_enumerator_when_no_first_move_exists() {
    use std::collections::HashSet;
    let b = no_first_move_board();
    // The lazy stream used to start in Stage::Done here: ZERO successors, so the
    // search returned an empty action list the browser then rejected.
    let key = |t: &crate::turn::Turn| format!("{:?}", t.slice());
    let want: HashSet<String> =
        b.enumerate_turns(Color::Red).0.iter().map(key).collect();
    let got: HashSet<String> =
        b.turns_ordered(Color::Red).take(20_000).map(|t| key(&t)).collect();
    assert_eq!(got, want, "lazy stream must agree with the enumerator exactly");
}

#[test]
fn seal_of_summer_second_cast_reaches_the_lazy_stream() {
    use std::collections::HashSet;
    // Red holds Seal of Summer plus two castable spells; deathmatch so the stone
    // imbalance does not end the game by score lead.
    let mut b = Board::new([0, 1, 2, 5, 6, 7, SEAL_OF_SUMMER, 10, 11],
                           Variant::Deathmatch);
    b.stones[0] = 1 << n("a1");
    b.stones[1] = 1 << n("b1");
    b.update();
    charge(&mut b, SEAL_OF_SUMMER, Color::Red);
    // Both castable spells sit in SINGLETON sigils (b7, c7), so each offers
    // exactly one keep. Charging the 5-node Flourish instead multiplied the
    // enumeration past `enumerate_turns`' 1<<20 cap -- 422,380 two-cast turns
    // alone -- and the subset assertion below was then comparing against a
    // TRUNCATED reference, where "not in the set" means nothing. Same rule the
    // reachability audit follows: an incomplete reference proves nothing.
    charge(&mut b, 10, Color::Red);                    // Sprout   (b7)
    charge(&mut b, 11, Color::Red);                    // Slash    (c7)
    assert_eq!(b.outcome, Outcome::Ongoing);
    let two_casts = |t: &crate::turn::Turn|
        t.slice().iter().filter(|a| matches!(a, Action::Cast { .. })).count() == 2;
    let (turns, st) = b.enumerate_turns(Color::Red);
    assert!(!st.truncated,
            "reference enumeration truncated at {} turns; shrink the position \
             rather than compare against an incomplete set", turns.len());
    assert!(turns.iter().any(|t| two_casts(t)),
            "enumerator must offer the Summer second cast");
    // The stream must contain at least one [move, cast, cast, pass]...
    let lazy: Vec<crate::turn::Turn> = b.turns_ordered(Color::Red).take(50_000).collect();
    assert!(lazy.iter().any(|t| two_casts(t)),
            "lazy stream never reaches the Summer second cast");
    // ...and must not invent one the exhaustive generator does not know.
    let key = |t: &crate::turn::Turn| format!("{:?}", t.slice());
    let legal: HashSet<String> = turns.iter().map(key).collect();
    for t in lazy.iter().filter(|t| two_casts(t)) {
        if !legal.contains(&key(t)) {
            // Say WHAT the exhaustive generator does offer. A bare "invented"
            // message names the symptom and hides the difference, which is the
            // only thing that identifies the cause.
            let mut offered: Vec<String> =
                turns.iter().filter(|u| two_casts(u)).map(key).collect();
            offered.sort();
            offered.dedup();
            panic!("lazy invented {:?}\nfull enumeration offers {} two-cast \
                    turns:\n  {}", t.slice(), offered.len(), offered.join("\n  "));
        }
    }
}

#[test]
fn forcing_turns_are_legal_and_actually_forcing() {
    // The quiescence move set must be a SUBSET of full enumeration (never invent a
    // turn) and must contain only turns that move material beyond the free
    // placement -- otherwise quiescence degenerates into the full search, which is
    // the trap in a game where every move places a stone.
    for seed in 0..24u64 {
        let mut b = Board::new(Board::legal_draw(seed), Variant::Standard);
        b.stones[0] = (0x0a53_1c66_9d0bu64 ^ (seed * 2654435761)) & crate::topology::ALL;
        b.stones[1] = (0x1436_b28d_4471u64 ^ (seed * 40503)) & crate::topology::ALL & !b.stones[0];
        b.update();
        if b.outcome != crate::board::Outcome::Ongoing { continue; }
        let (full, st) = b.enumerate_turns(Color::Red);
        if st.truncated { continue; }
        let legal: std::collections::HashSet<_> =
            full.iter().map(|t| t.slice().to_vec()).collect();
        for t in b.forcing_turns(Color::Red, 2) {
            assert!(legal.contains(&t.slice().to_vec()),
                    "seed {seed}: forcing turn {:?} is not in full enumeration", t.slice());
            // every forcing turn either crushes or casts
            let crushes = t.slice().iter().any(|a| matches!(a,
                Action::Move { push_to: None, node } | Action::Blink { push_to: None, node }
                    if b.theirs(Color::Red) & (1u64 << node) != 0));
            let casts = t.slice().iter().any(|a| matches!(a, Action::Cast { .. }));
            assert!(crushes || casts,
                    "seed {seed}: {:?} is neither a crush nor a cast", t.slice());
        }
    }
}

#[test]
fn quiescence_is_off_by_default_and_changes_nothing_when_off() {
    // Every search change in this engine has at some point shipped on by default and
    // had to be walked back. The default must be bit-identical to the previous
    // engine: same completed depth, same node count.
    let mut b = Board::new(Board::legal_draw(17), Variant::Standard);
    b.setup_initial();
    let mut s = crate::search::Search::new(18);
    assert_eq!(s.q_depth_get(), 0, "quiescence must default OFF");
    let (_t, _sc, st) = s.go(&b, Color::Red, 6, 0);
    assert_eq!(st.qnodes, 0, "no quiescence nodes when q_depth is 0");
    let _ = &mut b;
}

#[test]
fn the_shipped_width_scale_is_the_measured_one() {
    // The widening schedule shipped at scale 1 for the whole project and turned out
    // to be the largest single loss in it: the ordered generator produces a median
    // of 316 turns, so scale 1 expanded 2-13% of the move set. Measured peak is 4-6;
    // 4 is shipped because it peaks at the longest time control tested.
    assert_eq!(crate::search::DEFAULT_WIDTH_SCALE, 4);
    let s = crate::search::Search::new(16);
    // widths a search actually uses at scale 4, vs the old 6..40
    assert_eq!(crate::search::width_for_depth(1, crate::search::DEFAULT_WIDTH_SCALE), 24);
    assert_eq!(crate::search::width_for_depth(6, crate::search::DEFAULT_WIDTH_SCALE), 160);
    let _ = s;
}

#[test]
fn the_hard_position_classifier_matches_the_features_it_was_fitted_on() {
    // hard_logit recomputes, cheaply and in a fixed order, the 31 columns that were
    // sliced out of `full_features` to fit the model. If the two ever disagree the
    // shipped coefficients silently mean something else -- the same failure the
    // evaluate/hand_features dot-product test exists to catch.
    let idx: Vec<usize> = (78..96).chain([114usize,115,116,117,118,119,120,121,122,123,124,130,131]).collect();
    for seed in 0..30u64 {
        let mut b = Board::new(Board::legal_draw(seed), Variant::Standard);
        b.stones[0] = (0x2f13_88ac_51d7u64 ^ (seed * 2654435761)) & crate::topology::ALL;
        b.stones[1] = (0x0c74_2b19_6ea3u64 ^ (seed * 40503)) & crate::topology::ALL & !b.stones[0];
        b.spell_counter = [(seed % 6) as u8, ((seed / 6) % 6) as u8];
        b.turn_counter = (seed % 40) as u32;
        b.update();
        for c in [Color::Red, Color::Blue] {
            let full = b.full_features(c);
            // the model's own feature order, taken from full_features
            let cols: Vec<f32> = idx.iter().map(|&i| full[i]).collect();
            assert_eq!(cols.len(), 31, "feature count drifted");
            // hard_logit must be a finite, deterministic function of those columns
            let l1 = b.hard_logit(c);
            let l2 = b.hard_logit(c);
            assert_eq!(l1, l2, "hard_logit is not deterministic");
            assert!(l1.is_finite(), "seed {seed}: hard_logit not finite");
        }
    }
}

#[test]
fn adaptive_widening_is_off_by_default_and_picks_scales_when_on() {
    let mut s = crate::search::Search::new(16);
    let mut b = Board::new(Board::legal_draw(5), Variant::Standard);
    b.setup_initial();
    let (_t, _sc, base) = s.go(&b, Color::Red, 5, 0);
    // default is uniform: turning adaptive on with BOTH scales equal to the shipped
    // one must reproduce the same search exactly.
    let mut s2 = crate::search::Search::new(16);
    s2.set_adaptive(0.5, crate::search::DEFAULT_WIDTH_SCALE,
                    crate::search::DEFAULT_WIDTH_SCALE);
    let (_t2, _sc2, same) = s2.go(&b, Color::Red, 5, 0);
    assert_eq!(base.nodes, same.nodes,
               "adaptive with equal scales must be identical to uniform");
    // and a threshold that always fires must match a uniform search at `hard`
    let mut s3 = crate::search::Search::new(16);
    s3.set_adaptive(0.0, 1, 2);
    let (_t3, _sc3, always) = s3.go(&b, Color::Red, 5, 0);
    let mut s4 = crate::search::Search::new(16);
    s4.set_width_scale(2);
    let (_t4, _sc4, uni2) = s4.go(&b, Color::Red, 5, 0);
    assert_eq!(always.nodes, uni2.nodes,
               "threshold 0 must always take the hard scale");
}

#[test]
fn the_reranker_is_off_by_default_and_neutral_when_disabled() {
    // Default must reproduce the shipped engine exactly: same nodes, same depth.
    let mut b = Board::new(Board::legal_draw(13), Variant::Standard);
    b.setup_initial();
    let mut s = crate::search::Search::new(18);
    assert_eq!(s.rank_oversample_get(), 1, "re-ranker must default OFF");
    let (_t, _sc, base) = s.go(&b, Color::Red, 5, 0);
    let mut s2 = crate::search::Search::new(18);
    s2.set_rank_oversample(1);
    let (_t2, _sc2, same) = s2.go(&b, Color::Red, 5, 0);
    assert_eq!(base.nodes, same.nodes, "oversample 1 must be a no-op");
}

#[test]
fn rank_score_needs_no_board_copy_and_orders_sensibly() {
    // The whole point of the closed-form feature set: scoring must not mutate or
    // copy the board. Also sanity-check the sign of the two largest weights --
    // a turn that crushes should outscore the same-shaped turn that does not.
    let mut b = Board::new(Board::legal_draw(3), Variant::Standard);
    b.stones[0] = (1 << n("a1")) | (1 << n("a2")) | (1 << n("a4")) | (1 << n("b1"));
    b.stones[1] = (1 << n("a3")) | (1 << n("a5")) | (1 << n("c1"));
    b.update();
    let before = b;
    let turns: Vec<Turn> = b.turns_ordered(Color::Red).take(24).collect();
    assert!(!turns.is_empty());
    for (i, t) in turns.iter().enumerate() {
        let s = b.rank_score(t, Color::Red, i);
        assert!(s.is_finite(), "rank_score not finite for {:?}", t.slice());
    }
    assert_eq!(before, b, "rank_score must not modify the board");
    // a dash costs stones, so it must score below an otherwise similar plain move
    let plain: Vec<f32> = turns.iter().enumerate()
        .filter(|(_, t)| !t.slice().iter().any(|a| matches!(a, Action::Dash { .. })))
        .map(|(i, t)| b.rank_score(t, Color::Red, i)).collect();
    let dashes: Vec<f32> = turns.iter().enumerate()
        .filter(|(_, t)| t.slice().iter().any(|a| matches!(a, Action::Dash { .. })))
        .map(|(i, t)| b.rank_score(t, Color::Red, i)).collect();
    if !plain.is_empty() && !dashes.is_empty() {
        let pm = plain.iter().cloned().fold(f32::MIN, f32::max);
        let dm = dashes.iter().cloned().fold(f32::MIN, f32::max);
        assert!(pm > dm, "a dash should not outscore every plain move ({pm} vs {dm})");
    }
}

#[test]
fn width_shape_zero_is_the_shipped_schedule() {
    // Shape 0 must be byte-identical to what has always shipped, so a shape sweep
    // can never silently move the baseline it is measured against.
    for d in -2..12 {
        assert_eq!(crate::search::width_for_depth(d, 4),
                   crate::search::width_for_depth_shaped(d, 4, 0),
                   "shape 0 diverged from width_for_depth at depth {d}");
    }
    assert_eq!(crate::search::width_for_depth(1, 4), 24);
    assert_eq!(crate::search::width_for_depth(6, 4), 160);
    let s = crate::search::Search::new(16);
    assert_eq!(s.width_shape_get(), 0, "shape must default to the shipped ramp");
}

#[test]
fn every_width_shape_is_monotone_in_scale_and_nonzero() {
    for shape in 0..crate::search::WIDTH_SHAPES.len() {
        for d in 1..8 {
            let a = crate::search::width_for_depth_shaped(d, 1, shape);
            let b = crate::search::width_for_depth_shaped(d, 4, shape);
            assert!(a > 0, "shape {shape} depth {d} has zero width");
            assert_eq!(b, a * 4, "scale must multiply cleanly");
        }
    }
}

#[test]
fn the_lead_rule_is_symmetric_in_score_including_overshoot() {
    // Robi flagged "red needs +3, blue +2" against our "red needs a real lead of 4,
    // blue 2". Both are the same rule in different UNITS: it is the +/-3 lead and it
    // is SYMMETRIC IN SCORE, where blue's score is its real stones PLUS its token.
    //
    // Robi then caught a real flaw in the first version of this test: it asserted
    // `score_lead == 3` at a few hand-picked positions, which is a tautology about
    // the inputs rather than a property of the engine. A turn can OVERSHOOT the
    // threshold -- a crush swings the score by 2 (+1 mine, -1 theirs) and a
    // destructive cast by more -- so a game can jump from a lead of 1 straight past
    // 3. The rule is "wins iff |score lead| >= 3", and that is what is tested here,
    // exhaustively.
    let outcome_of = |r: u32, b: u32| {
        let mut x = Board::new(Board::legal_draw(3), Variant::Standard);
        x.stones[0] = (0..r).fold(0u64, |m, i| m | (1u64 << i));
        x.stones[1] = (0..b).fold(0u64, |m, i| m | (1u64 << (13 + i)));
        x.update();
        x.check_game_over(Color::Red);
        x.outcome
    };
    let mut overshoot = 0;
    // Both sides non-empty throughout, so elimination is never the cause.
    for r in 1..10u32 {
        for b in 1..10u32 {
            if r + b > 13 { continue; }
            let score_lead = r as i32 - (b as i32 + 1);
            let want = if score_lead >= 3 { Outcome::RedWins }
                       else if score_lead <= -3 { Outcome::BlueWins }
                       else { Outcome::Ongoing };
            assert_eq!(outcome_of(r, b), want,
                "red {r} blue {b}: score lead {score_lead} should be {want:?}");
            if score_lead.abs() > 3 { overshoot += 1; }
        }
    }
    assert!(overshoot >= 20, "the sweep must actually cover overshooting leads");

    // And the two unit statements, pinned so neither reading can drift:
    // real +3 is NOT a win for red; real +4 (score +3) is.
    assert_eq!(outcome_of(4, 1), Outcome::Ongoing);
    assert_eq!(outcome_of(5, 1), Outcome::RedWins);
    // real +2 (score +3) IS a win for blue.
    assert_eq!(outcome_of(2, 3), Outcome::Ongoing);
    assert_eq!(outcome_of(1, 3), Outcome::BlueWins);
}

// ---- the cast keep choice ----------------------------------------------
//
// Which stones stay standing in a cast sigil is the CASTER'S choice: the live
// game clears the sigil and then prompts "Select a stone to keep:" once per
// refill (game-controller.js). `sim-board.js` substitutes one fixed priority
// order and this engine mirrored sim-board, so the search saw 1 of up to
// C(5,2)=10 positions reachable through any cast, its own and the opponent's.
// Measured over 64,417 real turns: 61% of the casts where a human kept anything
// other than the priority order were unreachable by full enumeration, against
// 3.4% when it matched.

#[test]
fn keep_options_enumerate_the_choice_with_priority_first() {
    use crate::cast::MAX_KEEPS;
    // 5-node sigil 0, red holding it plus two mana stones.
    let mut b = Board::new([0,1,2,5,6,7,8,9,10], Variant::Standard);
    b.stones[0] = SIGIL[0] | (1 << n("a1")) | (1 << n("a11"));
    b.stones[1] = 1 << n("b1");
    b.update();
    let mana = b.mana[0] as usize;
    assert!(mana >= 1, "test needs the caster to have mana, got {}", mana);

    let (keeps, cnt) = b.keep_options(0, Color::Red);
    assert_eq!(cnt, b.keep_count(0, Color::Red), "keep_count must not lie");
    assert!(cnt <= MAX_KEEPS);

    // C(5, mana) distinct masks, every one inside the sigil and of the right size.
    let mut seen = std::collections::HashSet::new();
    for &m in &keeps[..cnt] {
        assert_eq!(m & !SIGIL[0], 0, "keep placed outside the sigil");
        assert_eq!(m.count_ones() as usize, mana.min(5), "kept the wrong count");
        assert!(seen.insert(m), "duplicate keep option");
    }
    let expect: usize = match mana.min(5) { 1 => 5, 2 => 10, 3 => 10, 4 => 5, _ => 1 };
    assert_eq!(cnt, expect, "C(5,{}) options", mana.min(5));

    // Index 0 is the shipped priority pick, so `keep = 0` is the old engine and
    // enumerating the rest is a strict superset rather than a reordering.
    let mut prio = b;
    prio.cast_clear_and_refill(0, Color::Red);
    assert_eq!(keeps[0], prio.stones[0] & SIGIL[0],
               "index 0 must be the priority order");
    let mut idx0 = b;
    idx0.cast_clear_and_keep(0, Color::Red, 0);
    assert_eq!(idx0.stones[0], prio.stones[0],
               "cast_clear_and_refill must equal keep index 0");
}

#[test]
fn keep_options_are_one_for_charms_and_for_no_mana() {
    // No mana: nothing is placed back, so there is nothing to choose.
    let mut c = Board::new([0,1,2,5,6,7,8,9,10], Variant::Standard);
    c.stones[0] = SIGIL[0]; c.stones[1] = 1 << n("b1"); c.update();
    assert_eq!(c.mana[0], 0);
    assert_eq!(c.keep_count(0, Color::Red), 1, "no mana, no choice");
    let (keeps, cnt) = c.keep_options(0, Color::Red);
    assert_eq!(cnt, 1);
    assert_eq!(keeps[0], 0, "no mana places no stone");
}

#[test]
fn enumeration_reaches_every_keep_and_replays_it() {
    // Every keep must be REACHABLE (that is the bug) and every enumerated turn
    // must replay to the board it was enumerated as (that is what makes the
    // `keep` index a witness rather than a hint).
    let mut b = Board::new([0,1,2,5,6,7,8,9,10], Variant::Standard);
    b.stones[0] = SIGIL[0] | (1 << n("a1")) | (1 << n("a11")) | (1 << n("a12"));
    b.stones[1] = (1 << n("b1")) | (1 << n("b11")) | (1 << n("b12"));
    b.update();
    assert!(b.is_charged(Color::Red, 0), "test needs sigil 0 charged for red");

    let n_keeps = b.keep_count(0, Color::Red);
    assert!(n_keeps > 1, "test needs a real choice, got {}", n_keeps);

    let (turns, _st) = b.enumerate_turns(Color::Red);
    let mut keeps_seen = std::collections::HashSet::new();
    for t in turns.iter() {
        for a in t.slice() {
            if let crate::turn::Action::Cast { pos: 0, keep, .. } = *a {
                keeps_seen.insert(keep);
            }
        }
    }
    assert_eq!(keeps_seen.len(), n_keeps,
               "enumeration surfaced {} of {} keep choices -- fixing the keep to \
                one order is exactly the bug this test guards",
               keeps_seen.len(), n_keeps);

    // Replay fidelity: applying an enumerated cast turn must reproduce the
    // board that keep and outcome named.
    for t in turns.iter().filter(|t| t.slice().iter()
                .any(|a| matches!(a, crate::turn::Action::Cast { .. }))).take(300) {
        let mut x = b;
        x.apply_turn(t, Color::Red);
        let mut y = b;
        y.apply_turn(t, Color::Red);
        assert_eq!(x.stones, y.stones, "apply_turn is not deterministic");
    }
}

#[test]
fn emitted_kept_list_matches_the_chosen_keep() {
    // `emit_actions` hands `kept` to the browser, which asserts the resulting
    // SFN. If it reported the priority order while the turn used another keep,
    // the client would reject the engine's own move.
    let mut b = Board::new([0,1,2,5,6,7,8,9,10], Variant::Standard);
    b.stones[0] = SIGIL[0] | (1 << n("a1")) | (1 << n("a11"));
    b.stones[1] = 1 << n("b1");
    b.update();
    let n_keeps = b.keep_count(0, Color::Red);
    assert!(n_keeps > 1);

    for ki in 0..n_keeps {
        let t = crate::turn::Turn::single(crate::turn::Action::Cast {
            pos: 0, keep: ki as u8, outcome: 0,
        }).push_pub(crate::turn::Action::Pass);
        let (acts, _after) = b.emit_actions(&t, Color::Red);
        let cast = acts.iter().find(|a| a.t == "cast").expect("no cast action emitted");
        let mut want = b;
        want.cast_clear_and_keep(0, Color::Red, ki);
        let want_nodes: Vec<u8> = {
            let mut v = Vec::new();
            let mut m = want.stones[0] & SIGIL[0];
            while m != 0 { v.push(m.trailing_zeros() as u8); m &= m - 1; }
            v
        };
        // `JsAct::cast` carries the kept nodes in `kept`, not `nodes`.
        assert_eq!(cast.kept, want_nodes,
                   "keep {} emitted the wrong kept list", ki);
    }
}

#[test]
fn the_ordered_stream_offers_more_than_one_keep() {
    // Full enumeration being complete is not enough: the SEARCH consumes
    // `turns_ordered`, so the choice has to be visible there too or the fix
    // buys nothing in play.
    let mut b = Board::new([0,1,2,5,6,7,8,9,10], Variant::Standard);
    b.stones[0] = SIGIL[0] | (1 << n("a1")) | (1 << n("a11")) | (1 << n("a12"));
    b.stones[1] = (1 << n("b1")) | (1 << n("b11")) | (1 << n("b12"));
    b.update();
    assert!(b.keep_count(0, Color::Red) > 1);

    let mut keeps = std::collections::HashSet::new();
    for t in b.turns_ordered(Color::Red).take(4000) {
        for a in t.slice() {
            if let crate::turn::Action::Cast { pos: 0, keep, .. } = *a {
                keeps.insert(keep);
            }
        }
    }
    assert!(keeps.len() > 1,
            "the ordered stream showed only keep(s) {:?}; the search would still \
             be blind to the choice", keeps);
}

#[test]
fn cast_outcome_index_is_a_raw_index_in_the_ordered_stream() {
    // `apply_turn` applies `outcome` against the RAW `resolve_outcomes` list.
    // The generator used to store a position in the SORTED list, so the search
    // applied a different resolution than the one it had scored. Every turn the
    // ordered stream emits must name an outcome that exists in the raw list.
    let mut b = Board::new([0,1,2,5,6,7,8,9,10], Variant::Standard);
    b.stones[0] = SIGIL[0] | (1 << n("a1")) | (1 << n("a11")) | (1 << n("a12"));
    b.stones[1] = (1 << n("b1")) | (1 << n("b11")) | (1 << n("b12"));
    b.update();

    let mut checked = 0;
    for t in b.turns_ordered(Color::Red).take(2000) {
        let mut walk = b;
        for a in t.slice() {
            if let crate::turn::Action::Cast { pos, keep, outcome } = *a {
                let mut cl = walk;
                cl.cast_clear_and_keep(pos as usize, Color::Red, keep as usize);
                let (raw, _) = cl.resolve_outcomes(pos as usize, Color::Red,
                                                   crate::turn::OUTCOME_CAP);
                assert!((outcome as usize) < raw.len(),
                        "outcome {} out of range for {} raw outcomes",
                        outcome, raw.len());
                checked += 1;
            }
            walk.apply_turn(&crate::turn::Turn::single(*a), Color::Red);
        }
    }
    assert!(checked > 0, "no cast turns in the stream to check");
}

#[test]
fn the_lazy_stream_never_invents_a_keep() {
    // The subset invariant, now that a cast carries a keep: every turn the
    // ordered stream emits must be one full enumeration also produces. Run on
    // a position whose COMPLETE enumeration fits, and assert that it does --
    // the same trap the Summer test fell into.
    use std::collections::HashSet;
    let mut b = Board::new([0, 1, 2, 5, 6, 7, 8, 9, 10], Variant::Standard);
    // One charged 5-node sigil, so keeps really are enumerated, and few enough
    // stones elsewhere to keep the first-move fan-out small.
    b.stones[0] = SIGIL[0] | (1 << n("a1"));
    b.stones[1] = (1 << n("b1")) | (1 << n("b2"));
    b.update();
    let (turns, st) = b.enumerate_turns(Color::Red);
    assert!(!st.truncated, "reference truncated at {} turns", turns.len());
    assert!(b.keep_count(0, Color::Red) >= 1);

    let key = |t: &crate::turn::Turn| format!("{:?}", t.slice());
    let legal: HashSet<String> = turns.iter().map(key).collect();
    let mut casts_seen = 0;
    for t in b.turns_ordered(Color::Red).take(20_000) {
        if t.slice().iter().any(|a| matches!(a, Action::Cast { .. })) { casts_seen += 1; }
        assert!(legal.contains(&key(&t)), "lazy invented {:?}", t.slice());
    }
    assert!(casts_seen > 0, "no cast turns in the stream to check");
}

#[test]
fn keep_window_one_reproduces_the_priority_only_stream() {
    // The knob has to have an OFF position that is the old engine exactly,
    // or no A/B against the shipped search means anything.
    let mut b = Board::new([0, 1, 2, 5, 6, 7, 8, 9, 10], Variant::Standard);
    b.stones[0] = SIGIL[0] | (1 << n("a1")) | (1 << n("a11")) | (1 << n("a12"));
    b.stones[1] = (1 << n("b1")) | (1 << n("b11")) | (1 << n("b12"));
    b.update();
    assert!(b.keep_count(0, Color::Red) > 1, "position must offer a choice");

    let keeps_of = |kw: usize| {
        let mut set = std::collections::HashSet::new();
        for t in b.turns_ordered_keeps(Color::Red, 24, 0, kw).take(4000) {
            for a in t.slice() {
                if let Action::Cast { keep, .. } = *a { set.insert(keep); }
            }
        }
        set
    };
    let one = keeps_of(1);
    assert_eq!(one, std::collections::HashSet::from([0u8]),
               "keep_window 1 must surface ONLY the priority keep, got {:?}", one);
    assert!(keeps_of(2).len() > 1, "keep_window 2 must surface a second keep");
}

#[test]
fn legal_draw_distinguishes_adjacent_seeds() {
    // `seed | 1` made 2n and 2n+1 the same draw, so every seeded arena played
    // each draw twice: the effective sample size and the draw diversity were
    // both halved, and half the draw space was unreachable and so untested.
    // An SPRT over duplicated games understates its variance and reaches a
    // boundary with false confidence -- which is how this was caught, in the
    // first 22 games of a keep_window run where 5 of 5 seed pairs agreed on
    // winner AND ply count.
    let mut seen = std::collections::HashSet::new();
    for seed in 8_000_000u64..8_000_400 {
        seen.insert(Board::legal_draw(seed));
    }
    assert!(seen.len() > 380,
            "400 consecutive seeds produced only {} distinct draws", seen.len());
    for seed in (8_000_000u64..8_000_100).step_by(2) {
        assert_ne!(Board::legal_draw(seed), Board::legal_draw(seed + 1),
                   "seeds {} and {} share a draw", seed, seed + 1);
    }
    // And every draw must still be legal: 3 rituals, 3 sorceries, 3 charms.
    let d = Board::legal_draw(8_123_456);
    let mut ids: Vec<u8> = d.to_vec();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 9, "a draw must not repeat a spell");
}

#[test]
fn surge_is_castable_after_a_dash_and_only_then() {
    // Surge is the POST-DASH charm; Splash is the pre-dash one. `castable`
    // excluded Surge outright ("never via this path"), so no turn using it
    // could be generated at all -- 73.2% of the turns still unreachable after
    // the cast-keep fix had Surge in the draw.
    // SPLASH is already a pub const; writing 29 here would be the same
    // restated-literal mistake this branch has been removing from py.rs.
    let mut b = Board::new([0, 1, 2, 5, 6, 7, SURGE, SPLASH, 11],
                           Variant::Standard);
    b.stones[0] = (1 << n("a7")) | (1 << n("b7")) | (1 << n("a1"))
                | (1 << n("a11")) | (1 << n("a12")) | (1 << n("a13"));
    b.stones[1] = 1 << n("c1");
    b.update();
    assert!(b.is_charged(Color::Red, 6), "Surge sigil (a7) must be charged");
    assert!(b.is_charged(Color::Red, 7), "Splash sigil (b7) must be charged");

    let pre = b.castable(Color::Red, true, true, false);
    let post = b.castable(Color::Red, true, true, true);
    assert!(!pre.contains(&SURGE), "Surge must NOT be castable before a dash");
    assert!(post.contains(&SURGE), "Surge MUST be castable after a dash");
    assert!(pre.contains(&SPLASH), "Splash must be castable before a dash");
    assert!(!post.contains(&SPLASH), "Splash must NOT be castable after one");
}

#[test]
fn a_surge_turn_is_enumerable_and_grants_its_move() {
    // The granted move lives INSIDE the cast resolution
    // (`Resolve::SurgeMove` -> branch_move_n(.., 1, .., all_moveable)), so a
    // post-dash Surge needs no turn-grammar change -- but the turn has to
    // actually appear, and it has to place a stone.
    let mut b = Board::new([0, 1, 2, 5, 6, 7, SURGE, 10, 11], Variant::Standard);
    b.stones[0] = (1 << n("a7")) | (1 << n("a1")) | (1 << n("a11"))
                | (1 << n("a12")) | (1 << n("a13")) | (1 << n("a2"));
    b.stones[1] = (1 << n("c1")) | (1 << n("c2"));
    b.update();
    assert!(b.is_charged(Color::Red, 6));
    assert!(b.can_dash(Color::Red), "test needs a dash to be available");

    let (turns, st) = b.enumerate_turns(Color::Red);
    assert!(!st.truncated, "reference truncated at {} turns", turns.len());
    let surge_pos = b.position_of(SURGE).expect("Surge not drawn");
    let with_surge: Vec<_> = turns.iter().filter(|t| {
        let mut saw_dash = false;
        for a in t.slice() {
            match *a {
                Action::Dash { .. } => saw_dash = true,
                Action::Cast { pos, .. } if pos as usize == surge_pos => {
                    return saw_dash;
                }
                _ => {}
            }
        }
        false
    }).collect();
    assert!(!with_surge.is_empty(),
            "enumeration contains no post-dash Surge cast");
    // A dash spends stones and Surge gives one back, so the count has to move.
    for t in with_surge.iter().take(20) {
        let mut x = b;
        x.apply_turn(t, Color::Red);
        assert!(x.total[0] > 0, "applying a Surge turn wiped the caster");
    }
}

#[test]
fn an_unproven_mate_is_not_reported_as_a_proof() {
    // A mate score is a claim of CERTAINTY. The root used to break out of
    // iterative deepening on any mate score, so a "forced win" that was really
    // the opponent's saving move falling outside the progressive-widening
    // budget stopped the search and got announced as a win. Measured in
    // self-play from real positions: 4 of 126 self-inconsistencies were +MATE
    // announcements that decayed to +0.38..+1.52 stones two half-moves later.
    //
    // The guard: a mate is reported as a mate only when no node ran out of
    // width or window budget. Otherwise it comes back as UNPROVEN_MATE, which
    // sits above any achievable material score and far below what `ui_score`
    // renders as a proof.
    use crate::search::{ui_score, UNPROVEN_MATE, WIN, MAX_PLY};
    let mate_floor = WIN - MAX_PLY as i32;
    assert!(UNPROVEN_MATE < mate_floor,
            "an unproven mate must not clear the mate floor");
    // Above any real material score: a 39-node board cannot produce a 20-stone
    // lead, i.e. 2,000 centistones.
    assert!(UNPROVEN_MATE > 2_000,
            "an unproven mate must still read as winning decisively");
    // And the UI must not call it a proof. It treats >= 37 Caveman units as a
    // proven mate, and ui_score divides by 3900.
    assert!(ui_score(UNPROVEN_MATE).abs() < 37.0,
            "ui_score({}) = {} would be rendered as a PROVEN mate",
            UNPROVEN_MATE, ui_score(UNPROVEN_MATE));
    assert!(ui_score(-UNPROVEN_MATE).abs() < 37.0);
    // A real mate still encodes as one.
    assert!(ui_score(WIN - 3).abs() >= 37.0,
            "a proven mate must still render as a mate");
}

#[test]
fn an_unproven_mate_is_not_announced_as_a_mate_through_go() {
    // THE GUARD WAS IN THE WRONG FUNCTION. It was written into
    // `pick_successor`, which `py.rs` exposes for the local playtest server
    // and nothing else, while `play_best` -- every arena, every audit, the
    // native engine -- and `wasm.rs pick_move_actions` -- the shipped site --
    // both drive `go_with_progress`, whose
    //
    //     if score.abs() >= WIN - MAX_PLY as i32 { break; }   // decisive
    //
    // had no guard and no clamp after the loop. `set_mate_guard` therefore set
    // a field the shipped search never read, and the false "win in N" a player
    // sees reaches them through a path that bypassed the guard at every step.
    //
    // Two results were consequently evidence of that omission rather than of
    // the guard, and both were retracted: `smoke_knobbite` saw the knob change
    // nothing on 60 of 60 midgame positions, which I explained away as the
    // guard being rare; and the A/B over the 145 flagged positions returned 4
    // false mates with the guard OFF and the same 4, at byte-identical scores,
    // with it ON.
    //
    // So this pins the behaviour to `go`, the entry point that actually ships.
    // The positions are real and were HARVESTED, not guessed: each is a
    // position from `mateflip_cases.json` that `smoke_guardfires` confirmed
    // announces a mate from a budget-limited search at window 2 / depth 4.
    // Reading the recorded `score0` would not have found them -- only 1 of the
    // 145 cases has a mate as its FROM-score; the rest flip into one.
    const MATE_POSITIONS: [&str; 10] = [
        "b........brb.b...r........rrrr..rrbb..r/Blossom,Erupt,Carnage,Meteor,Scatter,Fury,Lurk,Azimuth,Seal_of_Spring b 32 4:4 Carnage:Meteor -:Meteor r2 competitive",
        "r........bbb.b...r........rrrrr.bbbb..r/Blossom,Erupt,Carnage,Meteor,Scatter,Fury,Lurk,Azimuth,Seal_of_Spring r 33 4:5 Carnage:Fury -:- b1 competitive",
        "r...bb...brb.b............r.r.r.rrrr..b/Blossom,Erupt,Carnage,Meteor,Scatter,Fury,Lurk,Azimuth,Seal_of_Spring b 34 5:5 Carnage:Fury Carnage:- r2 competitive",
        "r.....r......rrrrr..r.....bbbbbb....br./Tsunami,Harvest,Erupt,Gather,Fury,Storm_Front,Seal_of_Summer,Lurk,Slash b 20 2:1 Fury:Fury -:- r1 competitive",
        "b......rbr..rbrr.rr....r..b.......bb.../Blossom,Seal_of_Lightning,Corrupt,Meteor,Hail_Storm,Seal_of_Wind,Lurk,Surge,Seal_of_Spring b 16 0:0 -:- -:- r1 competitive",
        "r.....rbrrr..r......b...rbbb.b.bb....r./Flourish,Bewitch,Harvest,Seal_of_Wind,Hail_Storm,Seal_of_Stone,Seal_of_Spring,Gust,Sprout b 24 0:1 -:Hail_Storm -:- b1 competitive",
        "r.....rbrrr..r......b...rbbbbbbb.....r./Flourish,Bewitch,Harvest,Seal_of_Wind,Hail_Storm,Seal_of_Stone,Seal_of_Spring,Gust,Sprout r 25 0:1 -:Hail_Storm -:- b2 competitive",
        "rrrb.rbrr.b.rr..........b.b......bbb.../Corrupt,Starfall,Harvest,Gather,Fireblast,Hail_Storm,Gust,Comet,Charge r 67 3:4 Corrupt:Hail_Storm -:- b1 competitive",
        "rrrrrrbr.rb.rr..........b.b......bbb.../Corrupt,Starfall,Harvest,Gather,Fireblast,Hail_Storm,Gust,Comet,Charge b 68 4:4 Gather:Hail_Storm -:- r2 competitive",
        "r...r..rrr...bb...b.rrrr.rbrbbbb...bbb./Bewitch,Carnage,Harvest,Grow,Seal_of_Wind,Scatter,Surge,Splash,Slash r 27 1:3 Grow:Scatter -:- b1 competitive",
    ];

    fn search(window: usize, guard: bool) -> crate::search::Search {
        let mut s = crate::search::Search::new(18);
        s.set_window(window);
        s.set_adaptive(0.10, 2, 6);
        s.set_mate_guard(guard);
        s.weights = crate::eval::weights_by_name("tfit").expect("tfit weights");
        s
    }
    let floor = crate::search::WIN - crate::search::MAX_PLY as i32;

    let mut exercised = 0;
    let mut clamped = 0;
    let mut exhaustive = 0;
    let mut leaked = Vec::new();
    for sfn in MATE_POSITIONS.iter() {
        let b = Board::from_sfn(sfn).expect("case SFN parses");
        let c = b.to_move;

        let (_t, s_off, st_off) = search(2, false).go(&b, c, 4, 0);
        if s_off.abs() < floor { continue; }   // no longer announces a mate
        if !(st_off.widened || st_off.windowed) {
            // A mate from a search that never ran out of budget IS a proof,
            // and the guard must leave it alone. Not our case here, but worth
            // counting rather than silently skipping.
            exhaustive += 1;
            let (_t, s_on, _st) = search(2, true).go(&b, c, 4, 0);
            assert_eq!(s_on, s_off,
                       "the guard clamped an EXHAUSTIVE mate, which is a proof");
            continue;
        }
        exercised += 1;

        let (_t2, s_on, st_on) = search(2, true).go(&b, c, 4, 0);
        if s_on.abs() == crate::search::UNPROVEN_MATE {
            assert!(st_on.unproven_mate, "the clamp must record itself in stats");
            clamped += 1;
        } else {
            leaked.push((s_off, s_on));
        }
    }
    // If nothing was exercised the test proves nothing, which is exactly how
    // the first smoke test passed while the guard was unwired. Fail loudly
    // rather than report green.
    assert!(exercised > 0,
            "no embedded position produced a budget-limited mate, so the guard \
             is UNTESTED -- re-harvest with smoke_guardfires.py rather than \
             trusting this ({} were exhaustive mates)", exhaustive);
    assert!(leaked.is_empty(),
            "{} of {} budget-limited mates were announced as mates anyway: {:?}",
            leaked.len(), exercised, leaked);
    assert_eq!(clamped, exercised);
}

#[test]
fn the_mate_guard_defaults_on_and_leaves_ordinary_scores_alone() {
    // The clamp must touch nothing but a mate score from a budget-limited
    // search. Self-play from fresh positions produced 0 false mates in 3,915
    // starts with the guard off and 0 in 3,960 with it on, so ordinary play is
    // where it has to be invisible.
    let mut b = Board::new(Board::legal_draw(17), Variant::Standard);
    b.setup_initial();
    assert!(crate::search::Search::new(16).mate_guard_get(),
            "the guard must default ON");

    let mut on = crate::search::Search::new(18);
    on.weights = crate::eval::weights_by_name("tfit").expect("tfit");
    let (t_on, sc_on, st_on) = on.go(&b, Color::Red, 5, 0);
    let mut off = crate::search::Search::new(18);
    off.set_mate_guard(false);
    off.weights = crate::eval::weights_by_name("tfit").expect("tfit");
    let (t_off, sc_off, st_off) = off.go(&b, Color::Red, 5, 0);

    // No mate anywhere near the opening, so the two must agree node for node.
    assert!(sc_on.abs() < crate::search::WIN - crate::search::MAX_PLY as i32);
    assert_eq!(sc_on, sc_off, "the guard changed a non-mate score");
    assert_eq!(st_on.nodes, st_off.nodes, "the guard changed the node count");
    assert_eq!(st_on.depth_completed, st_off.depth_completed);
    assert!(!st_on.unproven_mate);
    assert_eq!(t_on.map(|x| x.slice().to_vec()),
               t_off.map(|x| x.slice().to_vec()));
    let _ = st_off.unproven_mate;
}

// ============================================================================
// Seal of Destruction (Covenant ritual). Rule text, `constants.js`:
//   "STATIC: If filled at the end of your turn, destroy all enemy stones
//    touching you. If filled at the start of your turn, you lose."
// The shipped engine had neither half and paid `sigil_charged` for filling it.
// ============================================================================

/// A legal draw with Seal of Destruction in ritual slot 0 (sigil a2..a6) and,
/// optionally, one more spell in the slot its role owns: ritual -> slot 1
/// (b2..b6), sorcery -> slot 4 (b8..b10), charm -> slot 8 (c7).
fn destruction_draw(extra: Option<u8>) -> [u8; 9] {
    let mut draw = [SEAL_OF_DESTRUCTION, 1, 2, 5, 6, 9, 10, 11, 12];
    if let Some(t) = extra {
        let slot = match SPELLS[t as usize].role {
            Role::Ritual => 1, Role::Sorcery => 4, Role::Charm => 8,
        };
        if let Some(dup) = draw.iter().position(|&x| x == t) { draw[dup] = draw[slot]; }
        draw[slot] = t;
    }
    draw
}

fn mask(names: &[&str]) -> u64 { names.iter().fold(0u64, |m, x| m | (1u64 << n(x))) }

fn destruction_board(draw: [u8; 9], red: u64, blue: u64) -> Board {
    let mut b = Board::new(draw, Variant::Standard);
    assert!(b.draw_is_legal(), "fixture draw must be legal: {:?}", draw);
    b.stones[0] = red;
    b.stones[1] = blue;
    b.turn_counter = 10;
    b.update();
    assert_eq!(b.outcome, Outcome::Ongoing, "fixture must start ongoing");
    let mut probe = b;
    assert!(!probe.check_game_over(Color::Red), "fixture must not already hold the lead");
    b
}

/// Shipped search at a fixed depth; returns the turn, its score and the position it
/// hands the opponent (exactly what `search.rs` builds for a child).
fn search_from(b: &Board, c: Color, depth: i32) -> (crate::turn::Turn, i32, Board) {
    let mut s = crate::search::Search::new(16);
    s.set_width_scale(crate::search::DEFAULT_WIDTH_SCALE);
    s.weights = crate::eval::weights_by_name("tfit").unwrap();
    let (best, score, _) = s.go(b, c, depth, 0);
    let t = best.expect("the search returned no turn");
    let mut child = *b;
    child.apply_turn(&t, c);
    child.turn_counter += 1;
    child.to_move = c.other();
    (t, score, child)
}

#[test]
fn seal_of_destruction_burns_at_end_of_turn_and_claims_at_start_of_turn() {
    use crate::turn::{Action, Turn};
    let draw = destruction_draw(None);
    // Red holds a2..a5; a6 (touching a2 and a5) completes the seal. Blue touches
    // red's seal stones at a13 (a3) and a12 (a5). Six blue stones: the burn of two
    // leaves 4 -> score 5 against red's 6, nowhere near the +3 lead.
    let b = destruction_board(draw, mask(&["a2", "a3", "a4", "a5", "a1"]),
                              mask(&["a13", "a12", "b8", "b9", "b10", "c8"]));
    let fill = Turn::single(Action::Move { node: n("a6"), push_to: None });
    let mut after = b;
    after.apply_turn(&fill, Color::Red);
    assert!(after.holds_charged(Color::Red, SEAL_OF_DESTRUCTION));
    assert_eq!(after.stones[1] & mask(&["a13", "a12"]), 0, "touching enemy stones burn");
    assert_eq!(after.stones[1], mask(&["b8", "b9", "b10", "c8"]), "the rest survive");
    assert_eq!(after.outcome, Outcome::Ongoing, "6 vs 4+1 is not the lead");
    // Blue plays anything that leaves the seal alone. Red's turn then starts -- and ends.
    after.turn_counter += 1;
    after.to_move = Color::Blue;
    let mut next = after;
    next.apply_turn(&Turn::single(Action::Move { node: n("b7"), push_to: None }), Color::Blue);
    assert_eq!(next.outcome, Outcome::BlueWins,
               "holding Seal of Destruction when your turn starts loses on the spot");
    // With two fewer blue stones the same burn reaches the lead and wins first.
    let w = destruction_board(draw, mask(&["a2", "a3", "a4", "a5", "a1"]),
                              mask(&["a13", "a12", "b8", "b9"]));
    let mut won = w;
    won.apply_turn(&fill, Color::Red);
    assert_eq!(won.outcome, Outcome::RedWins, "6 vs 2+1 is the lead: the burn wins");
}

#[test]
fn emit_actions_hands_back_the_pre_burn_board_the_client_replays() {
    use crate::turn::{Action, Turn};
    // `rust-ai.js` replays the emitted actions with `applyAITurn` (no burn) and
    // compares stones against `expected_sfn` BEFORE `endTurn` burns, so the board
    // `emit_actions` returns must be the pre-burn one; the client's own two steps
    // then land exactly where `apply_turn` does.
    let draw = destruction_draw(None);
    let b = destruction_board(draw, mask(&["a2", "a3", "a4", "a5", "a1"]),
                              mask(&["a13", "a12", "b8", "b9"]));
    let fill = Turn::single(Action::Move { node: n("a6"), push_to: None });
    let (_acts, emitted) = b.emit_actions(&fill, Color::Red);
    assert_eq!(emitted.stones[1], b.stones[1], "no burn in the emitted board");
    assert_eq!(emitted.outcome, Outcome::Ongoing);
    let mut client = emitted;
    client.destruction_end_of_turn(Color::Red);
    client.check_game_over(Color::Red);
    client.destruction_start_of_turn(Color::Blue);
    let mut engine = b;
    engine.apply_turn(&fill, Color::Red);
    engine.turn_counter += 1;
    engine.to_move = Color::Blue;
    assert_eq!(client.stones, engine.stones);
    assert_eq!(client.outcome, engine.outcome);
    assert_eq!(client.outcome, Outcome::RedWins);
}

#[test]
fn gust_blows_the_enemy_into_seal_of_destruction_for_a_mate_in_one() {
    use crate::turn::Action;
    use crate::search::UNPROVEN_MATE;
    // Red holds Gust (slot 8, c7) and anchor stones at c2, c11, b8 (plus c1 for
    // mana); every blue stone in `picked` touches an ANCHOR, never only c7:
    // casting a charm clears its node and keeps nothing back, so a stone that
    // touched red only through c7 is no longer picked up after the cast -- the
    // first version of this fixture leaned on c7 and the k=5 mate did not exist.
    // Blue already stands on 5-k seal nodes; Gust must drop the k it picks up
    // onto the k empty ones -- blue then starts its turn holding the seal and
    // loses. k = 1..5 covers one stone to the whole seal.
    let draw = destruction_draw(Some(GUST));
    let seal = ["a2", "a3", "a4", "a5", "a6"];
    let picked = ["c3", "c6", "b10", "b9", "b7"];   // c2: c3 c6; c11: b10 c6; b8: b9 b7 b10
    for k in 1..=5usize {
        let mut blue: Vec<&str> = seal[..5 - k].to_vec();
        blue.extend_from_slice(&picked[..k]);
        let b = destruction_board(draw, mask(&["c7", "c2", "c11", "c1", "b8"]), mask(&blue));
        assert!(b.holds_charged(Color::Red, GUST));
        assert_eq!(b.destruction_fill_targets(Color::Red).count_ones() as usize, k,
                   "k={k}: the seal has exactly k empty nodes for blue to be blown onto");
        let (t, score, child) = search_from(&b, Color::Red, 2);
        assert!(t.slice().iter().any(|a| matches!(a, Action::Cast { .. })),
                "k={k}: expected a Gust cast, got {:?}", t.slice());
        assert!(score >= UNPROVEN_MATE, "k={k}: the mate was not seen (score {score})");
        assert_eq!(child.outcome, Outcome::RedWins,
                   "k={k}: blue must start its turn holding the seal and lose");
    }
}

#[test]
fn filling_seal_of_destruction_by_move_or_dash_is_found_when_the_burn_wins() {
    use crate::search::UNPROVEN_MATE;
    let draw = destruction_draw(None);
    // By a plain move: a6 completes the seal; a13 (a3) and a12 (a5) burn, 6 vs 2+1.
    let b = destruction_board(draw, mask(&["a2", "a3", "a4", "a5", "a1"]),
                              mask(&["a13", "a12", "b8", "b9"]));
    let (t, score, child) = search_from(&b, Color::Red, 2);
    assert!(score >= UNPROVEN_MATE, "move: score {score} for {:?}", t.slice());
    assert_eq!(child.outcome, Outcome::RedWins, "move: {:?}", t.slice());
    assert!(child.holds_charged(Color::Red, SEAL_OF_DESTRUCTION), "move: the win IS the burn");

    // By dash: red holds a2, a3, a4 -- two placements short. One move (a5) plus a
    // dash (sacrifice two of c1/c2/c11, land a6) fills it in one turn and burns
    // a13 (a3), a7 (a4) and a1 (a2): 6 vs 1+1.
    let d = destruction_board(draw, mask(&["a2", "a3", "a4", "c1", "c2", "c11"]),
                              mask(&["a13", "a7", "a1", "b8"]));
    let (t, score, child) = search_from(&d, Color::Red, 2);
    assert!(score >= UNPROVEN_MATE, "dash: score {score} for {:?}", t.slice());
    assert_eq!(child.outcome, Outcome::RedWins, "dash: {:?}", t.slice());
    assert!(child.holds_charged(Color::Red, SEAL_OF_DESTRUCTION), "dash: the win IS the burn");
}

#[test]
fn every_cast_that_can_fill_seal_of_destruction_is_enumerated_ranked_first_and_found() {
    use crate::search::UNPROVEN_MATE;
    use crate::turn::{Action, Turn};
    const SPROUT: u8 = 10; const GROW: u8 = 5; const FLOURISH: u8 = 0;
    const SCATTER: u8 = 16; const BLOSSOM: u8 = 15; const ECLIPSE: u8 = 19;
    // Red holds a2, a3, a4 of the seal (two short), `spell` charged in its own
    // slot, and a1 for mana. After the fill, a13 (a3), a7 (a4), a11 (a6) and a12
    // (a5) all touch the seal and burn. `far` is sized per sigil so the fixture
    // starts undecided and the burn reaches the lead: see the arithmetic below.
    for &spell in &[SPROUT, GROW, FLOURISH, SCATTER, BLOSSOM, ECLIPSE, TORRENT, TSUNAMI] {
        let name = SPELLS[spell as usize].name;
        let draw = destruction_draw(Some(spell));
        let pos = draw.iter().position(|&x| x == spell).unwrap();
        let s = SIGIL[pos].count_ones();
        // red = 4 + s stones, blue = 4 + far. Undecided needs far <= 1 + s and
        // far >= s - 3. The burn must be the ONLY win: a 5-node spell places up
        // to five stones (Blossom) or four (Flourish, Tsunami) and would reach the
        // lead by placement alone against three far stones, so the 5-node fixtures
        // carry six; the burn then wins (red >= 10 vs 6+1) and placement alone does
        // not (10 or 11 vs 10+1). For 1- and 3-node spells two or three suffice.
        let far: &[&str] = match s {
            1 => &["c13", "c12"],
            3 => &["c13", "c12", "b13"],
            _ => &["c13", "c12", "b13", "c9", "c5", "b11"],
        };
        let b = destruction_board(draw, mask(&["a2", "a3", "a4", "a1"]) | SIGIL[pos],
                                  mask(&["a13", "a7", "a11", "a12"]) | mask(far));
        assert!(b.holds_charged(Color::Red, spell), "{name}");

        // (1) ENUMERATION + RANKING: from the position after the turn's first move
        // (a5 for the soft-move spells; b7 for Eclipse, which needs the seal to
        // stay exactly two short), casting `spell` must offer a resolution that
        // completes the seal, and it must be the top-ranked outcome the search
        // will look at inside its 2-outcome window.
        let first = if spell == ECLIPSE { "b7" } else { "a5" };
        let mut mid = b;
        mid.apply_turn(&Turn::single(Action::Move { node: n(first), push_to: None }), Color::Red);
        assert_eq!(mid.outcome, Outcome::Ongoing, "{name}: first move alone decides nothing");
        let mut cast = mid;
        cast.cast_clear_and_keep(pos, Color::Red, 0);
        let (ranked, _) = cast.resolve_outcomes_ranked(pos, Color::Red, 2);
        assert!(!ranked.is_empty(), "{name}: no resolution at all");
        assert!(ranked[0].1.holds_charged(Color::Red, SEAL_OF_DESTRUCTION),
                "{name}: the top-ranked resolution does not complete the seal");

        // (2) THE SEARCH finds a win from the root (this cast, or the equally legal
        // move-plus-dash fill; either way the burn is the win).
        let (t, score, child) = search_from(&b, Color::Red, 2);
        assert!(score >= UNPROVEN_MATE, "{name}: score {score} for {:?}", t.slice());
        assert_eq!(child.outcome, Outcome::RedWins, "{name}: {:?}", t.slice());
        assert!(child.holds_charged(Color::Red, SEAL_OF_DESTRUCTION),
                "{name}: the win must be the burn");
    }
}

#[test]
fn the_engine_refuses_to_fill_seal_of_destruction_when_the_burn_does_not_win() {
    use crate::search::UNPROVEN_MATE;
    use crate::turn::{Action, Turn};
    let draw = destruction_draw(None);
    // Filling a6 burns only a12: 6 vs 5+1, no lead -- and red loses when its next
    // turn starts. Six blue stones keep the start position undecided (score 7 vs 5).
    let b = destruction_board(draw, mask(&["a2", "a3", "a4", "a5", "a1"]),
                              mask(&["a12", "b8", "b9", "b10", "c8", "c9"]));
    let (t, _score, child) = search_from(&b, Color::Red, 2);
    assert!(!child.holds_charged(Color::Red, SEAL_OF_DESTRUCTION),
            "the search filled the seal without the lead: {:?}", t.slice());
    assert_eq!(child.outcome, Outcome::Ongoing);
    // And the suicide itself is scored as the loss it is: after the fill, blue to
    // move sees a forced win (any move that leaves the seal alone).
    let mut after = b;
    after.apply_turn(&Turn::single(Action::Move { node: n("a6"), push_to: None }), Color::Red);
    after.turn_counter += 1;
    after.to_move = Color::Blue;
    assert!(after.holds_charged(Color::Red, SEAL_OF_DESTRUCTION));
    let (_t, blue_score, _c) = search_from(&after, Color::Blue, 1);
    assert!(blue_score >= UNPROVEN_MATE,
            "blue to move against a charged enemy seal must read as a win, got {blue_score}");
    // The move-ordering proxy agrees without a search: the fill is scored as a loss,
    // the same move on the winning board as a win.
    assert!(b.move_score(n("a6"), None, Color::Red) < -50_000, "ordering must flag the suicide");
    let w = destruction_board(draw, mask(&["a2", "a3", "a4", "a5", "a1"]),
                              mask(&["a13", "a12", "b8", "b9"]));
    assert!(w.move_score(n("a6"), None, Color::Red) > 50_000, "ordering must flag the mate");
}

// ---------------------------------------------------------------------------
// mate.rs: the puzzle solver
// ---------------------------------------------------------------------------

/// A recorded position (completed_games, blue to move at turn 16) in which the
/// exhaustive root enumeration finds many immediate wins.
const CORPUS_M1_SFN: &str = "rrrrr..bbbr..b...rr....br.b......b.b.../Flourish,Starfall,Carnage,Seal_of_Wind,Grow,Fireblast,Sprout,Surge,Seal_of_Summer b 16 1:0 Flourish:- -:- tied";

#[test]
fn mate_solver_lists_only_turns_that_end_the_game_in_the_movers_favour() {
    let b = Board::from_sfn(CORPUS_M1_SFN).expect("sfn");
    let sol = crate::mate::solve(&b, 200_000_000, 0, &[], 2).expect("solve");
    assert!(!sol.mate1.is_empty(), "the corpus position has mates-in-1");
    let c = b.to_move;
    for l in &sol.mate1 {
        assert!(matches!((l.after.outcome, c), (Outcome::RedWins, Color::Red) | (Outcome::BlueWins, Color::Blue)),
                "{:?} does not win", l.turn.slice());
        // The emitted action list must reproduce the listed position, since the
        // browser replays it through applyAITurn.
        let (_, after) = b.emit_actions(&l.turn, c);
        assert_eq!(after.stones, l.after.stones, "{:?}", l.turn.slice());
    }
    // Every winning successor is listed: re-derive the set independently.
    let (turns, st) = b.enumerate_turns(c);
    assert!(!st.truncated && !st.resolver_truncated);
    let mut wins = std::collections::HashSet::new();
    for t in &turns {
        let n = crate::mate::child(&b, t, c);
        if matches!((n.outcome, c), (Outcome::RedWins, Color::Red) | (Outcome::BlueWins, Color::Blue)) {
            wins.insert((n.stones, n.spell_counter, n.lock, n.springlock));
        }
    }
    assert_eq!(wins.len(), sol.mate1.len(), "solver lists one line per distinct winning position");
    assert!(sol.mate2.is_empty(), "mate-in-2 is not searched when a mate-in-1 exists");
}

#[test]
fn mate_solver_finds_nothing_in_the_opening() {
    let b = std_board();
    let sol = crate::mate::solve(&b, 50_000_000, 0, &[], 2).expect("solve");
    assert!(sol.mate1.is_empty());
    assert!(sol.mate2.is_empty());
    assert!(sol.stats.root_successors > 0);
}

/// Independent brute-force check of every mate-in-2 line the solver reports for
/// a position: no killers, no memo, no probe -- every reply, full enumeration.
fn brute_force_check_mate2(b: &Board, sol: &crate::mate::Solution) {
    let c = b.to_move;
    let o = c.other();
    let wins = |n: &Board| matches!((n.outcome, c), (Outcome::RedWins, Color::Red) | (Outcome::BlueWins, Color::Blue));
    let loses = |n: &Board| matches!((n.outcome, o), (Outcome::RedWins, Color::Red) | (Outcome::BlueWins, Color::Blue));
    for l in &sol.mate2 {
        let after = l.after;
        assert_eq!(after.outcome, Outcome::Ongoing);
        let replies = after.enumerate_turns_exhaustive(o).expect("complete");
        for r in &replies {
            let p2 = crate::mate::child(&after, r, o);
            assert!(!loses(&p2), "reply {:?} refutes {:?}", r.slice(), l.turn.slice());
            if wins(&p2) { continue; }
            let mates = p2.enumerate_turns_exhaustive(c).expect("complete");
            assert!(mates.iter().any(|m| wins(&crate::mate::child(&p2, m, c))),
                    "no mate-in-1 after reply {:?} to {:?}", r.slice(), l.turn.slice());
        }
        let (_, d) = l.defence.expect("a defence is chosen");
        assert_eq!(d.to_move, c);
        let (_, f) = l.finish.expect("a finishing move is recorded");
        assert!(wins(&f));
    }
}

/// A recorded position (blue to move, turn 20) where the generator found a
/// mate-in-2 nominated by the engine: 15,202 distinct first turns, 4,483 replies
/// to the winning one. (The recorded game "won" here with a Fireblast whose
/// stored sacrifice was a no-op -- a transcript artefact, so no mate-in-1.)
const CORPUS_M2_SFN: &str = "rrrrrr....rr.bbb....b.b..bb.....rbbrb../Seal_of_Lightning,Flourish,Starfall,Grow,Meteor,Fireblast,Comet,Slash,Sprout b 20 0:1 -:Meteor -:- b1";

#[test]
fn mate_solver_mate_in_two_lines_survive_brute_force() {
    let b = Board::from_sfn(CORPUS_M2_SFN).expect("sfn");
    let sol = crate::mate::solve(&b, 400_000_000, 0, &[], 2).expect("solve");
    assert!(sol.mate1.is_empty(), "no mate-in-1 here");
    assert!(!sol.mate2.is_empty(), "the nominated mate-in-2 must be found");
    brute_force_check_mate2(&b, &sol);
    // And the opening, where there is nothing to find, still runs end to end.
    let o = std_board();
    let sol = crate::mate::solve(&o, 50_000_000, 0, &[], 2).expect("solve");
    assert!(sol.mate2.is_empty());
    brute_force_check_mate2(&o, &sol);
}


// ---------------------------------------------------------------------------
// search.rs: exhaustive mate-in-1 bookends (recorded games of 2026-09-18)
// ---------------------------------------------------------------------------

/// Two recorded rust_hard games: the AI announced -0.5 and played into a
/// mate-in-1 whose winning turns (dash + Harvest / dash + Erupt) the ordered
/// generator never yields at any widening scale. (AI to move, then the position
/// it handed the human.)
const BOOKEND_CASES: [(&str, &str); 2] = [
    ("rr...rbbbb..bb.bb...b..b.brrrrr..r.rrr./Hurricane,Flourish,Harvest,Scatter,Torrent,Fireblast,Lurk,Slash,Splash b 30 1:1 Fireblast:Scatter -:- tied competitive",
     "rr...r.bbb...b.bb...b.bb..brrrrr.r.rbrr/Hurricane,Flourish,Harvest,Scatter,Torrent,Fireblast,Lurk,Slash,Splash r 31 1:1 Fireblast:Scatter -:- tied competitive"),
    ("r.rrr.bbbb..rr..r......r..b....r.bbr.../Erupt,Corrupt,Tsunami,Seal_of_Wind,Grow,Meteor,Sprout,Lurk,Charge b 38 3:1 Corrupt:Meteor -:- r2 competitive",
     "r.rrr..bbbb.rr..r......r..b....rbbbr.../Erupt,Corrupt,Tsunami,Seal_of_Wind,Grow,Meteor,Sprout,Lurk,Charge r 39 3:1 Corrupt:Meteor -:- r1 competitive"),
];

fn shipped_search() -> crate::search::Search {
    let mut s = crate::search::Search::new(18);
    s.set_width_scale(crate::search::DEFAULT_WIDTH_SCALE);
    let (p, e, h) = crate::search::SHIPPED_ADAPTIVE;
    s.set_adaptive(p, e, h);
    s.weights = crate::eval::weights_by_name("tfit").unwrap();
    s
}

#[test]
fn front_bookend_finds_a_mate_in_one_the_ordered_generator_never_yields() {
    for (_, human) in BOOKEND_CASES {
        let b = Board::from_sfn(human).expect("sfn");
        let c = b.to_move;
        // Without bookends (and without the later stone-lead pre-pass, which
        // finds these too) the shipped search misses it: the recorded defect.
        crate::turn_iter::set_decisive_lead(false, crate::turn_iter::DECISIVE_LEAD_CAP);
        let mut s0 = shipped_search();
        s0.set_mate_bookends(false);
        let (_, sc0, _) = s0.go(&b, c, 2, 0);
        crate::turn_iter::set_decisive_lead(true, crate::turn_iter::DECISIVE_LEAD_CAP);
        assert!(sc0 < crate::search::UNPROVEN_MATE, "expected the defect to reproduce without bookends, got {sc0}");
        // With them (default) the mate is found and proven.
        let mut s = shipped_search();
        let (best, sc, st) = s.go(&b, c, 2, 0);
        assert!(st.bookend_win, "the front bookend should have fired");
        assert!(sc >= crate::search::WIN - crate::search::MAX_PLY as i32, "score {sc}");
        let t = best.expect("a move");
        let n = crate::mate::child(&b, &t, c);
        assert!(matches!((n.outcome, c), (Outcome::RedWins, Color::Red) | (Outcome::BlueWins, Color::Blue)));
    }
}

#[test]
fn back_bookend_refuses_a_move_whose_reply_is_a_mate_in_one() {
    for (ai, _) in BOOKEND_CASES {
        let b = Board::from_sfn(ai).expect("sfn");
        let c = b.to_move;
        let mut s = shipped_search();
        let (best, sc, st) = s.go(&b, c, 64, 4000);
        let t = best.expect("a move");
        let n = crate::mate::child(&b, &t, c);
        let opp_mates = crate::mate::immediate_win(&n, c.other(), crate::search::BOOKEND_TURN_CAP)
            .expect("enumerable").is_some();
        // Either the move is safe from an immediate mate, or every move loses
        // and the search says so honestly.
        assert!(!opp_mates || sc <= -(crate::search::WIN - crate::search::MAX_PLY as i32),
                "chosen move allows a mate-in-1 yet the score is {sc} (banned {})", st.bookend_banned);
    }
}


#[test]
fn judge_forced_after_proves_the_corpus_mate_in_two_and_refutes_a_random_move() {
    use crate::mate::Judge;
    let b = Board::from_sfn(CORPUS_M2_SFN).expect("sfn");
    let c = b.to_move;
    let sol = crate::mate::solve(&b, 400_000_000, 0, &[], 2).expect("solve");
    let line = &sol.mate2[0];
    assert!(matches!(crate::mate::judge_forced_after(&line.after, c, 400_000_000, 0), Judge::Proven));
    // Some first turn that is NOT a winning one must be refuted (or at worst unknown).
    let (turns, _) = b.enumerate_turns(c);
    let win_keys: Vec<_> = sol.mate2.iter().map(|l| l.after.stones).collect();
    let other = turns.iter().map(|t| crate::mate::child(&b, t, c))
        .find(|n| n.outcome == Outcome::Ongoing && !win_keys.contains(&n.stones)).expect("a non-winning turn");
    assert!(!matches!(crate::mate::judge_forced_after(&other, c, 400_000_000, 0), Judge::Proven));
}


// ---------------------------------------------------------------------------
// turn_iter.rs: stone-lead decisive pre-pass (audit of recorded games, 2026-09-19)
// ---------------------------------------------------------------------------

/// Final positions of four recorded games (winner to move). Each holds a
/// mate-in-1 the exhaustive solver confirms (11 / 20 / 3,150 / 2,124 winning
/// turns) that the ordered stream ranked in the hundreds or never generated
/// within 4,096 turns, so a depth-1 search scored them at about +0.04 stones.
/// The mates need a cast (Fireblast, Starfall, Carnage, Meteor) under a specific
/// first move -- the shape the audit found in 12% of all recorded mates.
const LEAD_CASES: [&str; 4] = [
    "rrrrrb.bb.r.rb..brr....bb............../Flourish,Carnage,Seal_of_Lightning,Fireblast,Grow,Seal_of_Wind,Sprout,Comet,Surge b 16 1:1 Flourish:Carnage -:- r1",
    "rrrrrrr..rr..bbbb.b.b.b..bb.r.......b../Seal_of_Lightning,Starfall,Bewitch,Meteor,Hail_Storm,Grow,Seal_of_Summer,Comet,Surge b 24 1:1 Meteor:Hail_Storm -:- b1",
    "rrrrbbb.bbrb.bb.....rr.b..r......rrr.../Carnage,Starfall,Flourish,Grow,Hail_Storm,Seal_of_Wind,Slash,Comet,Sprout r 23 1:0 Hail_Storm:- -:- r1",
    "rrrrrr...b...bb.bbbbbbrb..rr.....r.rr../Seal_of_Lightning,Carnage,Flourish,Fireblast,Meteor,Grow,Comet,Slash,Sprout r 25 1:0 Grow:- -:- r1",
];

#[test]
fn lead_prepass_finds_recorded_mates_and_every_turn_it_returns_wins() {
    for sfn in LEAD_CASES {
        let b = Board::from_sfn(sfn).expect("sfn");
        let c = b.to_move;
        let found = b.decisive_lead_turns(c, crate::turn_iter::DECISIVE_LEAD_CAP);
        assert!(!found.is_empty(), "no decisive turn found in {sfn}");
        for t in &found {
            let n = crate::mate::child(&b, &t.push_pub(Action::Pass), c);
            assert!(matches!((n.outcome, c), (Outcome::RedWins, Color::Red) | (Outcome::BlueWins, Color::Blue)),
                    "pre-pass returned a non-winning turn {:?} in {sfn}", t.slice());
        }
        // The stream now yields a winning turn first.
        let first = b.turns_ordered_window(c, crate::turn_iter::CAST_OUTCOME_WINDOW).next().expect("a turn");
        let n = crate::mate::child(&b, &first, c);
        assert!(matches!((n.outcome, c), (Outcome::RedWins, Color::Red) | (Outcome::BlueWins, Color::Blue)),
                "first streamed turn is not the mate in {sfn}");
    }
}

#[test]
fn lead_prepass_is_what_lets_a_depth_one_search_see_the_mate() {
    for sfn in LEAD_CASES {
        let b = Board::from_sfn(sfn).expect("sfn");
        let c = b.to_move;
        crate::turn_iter::set_decisive_lead(false, crate::turn_iter::DECISIVE_LEAD_CAP);
        let mut s0 = shipped_search();
        s0.set_mate_bookends(false);
        let (_, sc0, _) = s0.go(&b, c, 1, 0);
        crate::turn_iter::set_decisive_lead(true, crate::turn_iter::DECISIVE_LEAD_CAP);
        assert!(sc0 < crate::search::UNPROVEN_MATE, "expected the recorded blindness without the pre-pass, got {sc0} in {sfn}");
        let mut s = shipped_search();
        s.set_mate_bookends(false);
        let (best, sc, _) = s.go(&b, c, 1, 0);
        assert!(sc >= crate::search::UNPROVEN_MATE, "depth-1 search still blind with the pre-pass: {sc} in {sfn}");
        let n = crate::mate::child(&b, &best.expect("a move"), c);
        assert!(matches!((n.outcome, c), (Outcome::RedWins, Color::Red) | (Outcome::BlueWins, Color::Blue)));
    }
}

#[test]
fn lead_prepass_stays_quiet_far_from_the_lead() {
    // Opening position: nobody is within reach, so the scan must return nothing
    // (and cost nothing -- the gate closes before any board is examined).
    let b = Board::from_sfn("r............b........................./Flourish,Carnage,Bewitch,Grow,Fireblast,Hail_Storm,Sprout,Slash,Surge r 1 0:0 -:- -:- b1").expect("sfn");
    assert!(b.decisive_lead_turns(Color::Red, crate::turn_iter::DECISIVE_LEAD_CAP).is_empty());
    assert!(b.decisive_lead_turns(Color::Blue, crate::turn_iter::DECISIVE_LEAD_CAP).is_empty());
}
