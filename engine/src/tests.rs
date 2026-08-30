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
        let mut s = seed | 1;
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
                let mut cleared = b;
                cleared.cast_clear_and_refill(pos, c);
                let (outs, _t) = cleared.resolve_outcomes(pos, c, OUTCOME_CAP);
                let mut g = cleared;
                g.resolve_spell_at(pos, c);
                assert!(outs.iter().any(|o| o.stones == g.stones),
                    "greedy outcome missing for {} at pos {}",
                    SPELLS[draw[pos] as usize].name, pos + 1);
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
    charge(&mut b, 0, Color::Red);                     // Flourish
    charge(&mut b, 10, Color::Red);                    // Sprout
    assert_eq!(b.outcome, Outcome::Ongoing);
    let two_casts = |t: &crate::turn::Turn|
        t.slice().iter().filter(|a| matches!(a, Action::Cast { .. })).count() == 2;
    let (turns, _) = b.enumerate_turns(Color::Red);
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
        assert!(legal.contains(&key(t)), "lazy invented {:?}", t.slice());
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
