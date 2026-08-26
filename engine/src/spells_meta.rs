// GENERATED from docs/static/scripts/engine/constants.js CORE_SPELLS + pack lists.
// Scope: the 39 OFFICIAL spells, ids 0..38 (contiguous - verified).
//   deferred playtest packs = 39..50 (Tectonic, Providence, Aftershock, Ambush)
//   PANDA (fan-made, excluded per Robi) has NO ids in ai/config.py at all.

/// Which sigil sizes a spell may be drawn into. The three roles have exactly
/// 13 spells each (13+13+13 = 39), and `Charm` coincides EXACTLY with the
/// `ischarm` flag. A legal draw puts rituals in positions 1-3 (5 nodes),
/// sorceries in 4-6 (3 nodes) and charms in 7-9 (1 node).
///
/// This matters: `_cast_spell`'s mana refill indexes position_nodes[2..5]
/// unconditionally for non-3-node sigils, so a NON-CHARM placed in a 1-node
/// slot makes simboard.py raise IndexError (and the JS silently write to an
/// undefined key). Legal draws never do that, because non-charms are never
/// charms - but tests must respect the structure or they hit unreachable states.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role { Ritual, Sorcery, Charm }

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Resolve {
    SoftMoves,
    HardMoves,
    Bewitch,
    Starfall,
    None_,
    Fireblast,
    HailStorm,
    Meteor,
    SurgeMove,
    Comet,
    Blossom,
    Scatter,
    Syzygy,
    Eclipse,
    Azimuth,
    Erupt,
    Fury,
    Charge,
    Hurricane,
    StormFront,
    Gust,
    SoftHardChain,
    LockedOrSelfMoves,
    Corrupt,
    DestroyExposed,
    RestrictedMove,
}

#[derive(Clone, Copy, Debug)]
pub struct SpellInfo {
    pub name: &'static str,
    pub resolve: Resolve,
    pub role: Role,
    pub count: u8,          // single-count resolvers; 0 when unused
    pub counts: (u8, u8),   // soft_hard_chain only: (soft, hard)
    pub is_static: bool,
    pub is_charm: bool,
}

pub const NUM_OFFICIAL_SPELLS: usize = 39;
pub const SPELLS: [SpellInfo; NUM_OFFICIAL_SPELLS] = [
    SpellInfo { name: "Flourish", resolve: Resolve::SoftMoves, role: Role::Ritual, count: 4, counts: (0, 0), is_static: false, is_charm: false }, // 0
    SpellInfo { name: "Carnage", resolve: Resolve::HardMoves, role: Role::Ritual, count: 4, counts: (0, 0), is_static: false, is_charm: false }, // 1
    SpellInfo { name: "Bewitch", resolve: Resolve::Bewitch, role: Role::Ritual, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 2
    SpellInfo { name: "Starfall", resolve: Resolve::Starfall, role: Role::Ritual, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 3
    SpellInfo { name: "Seal_of_Lightning", resolve: Resolve::None_, role: Role::Ritual, count: 0, counts: (0, 0), is_static: true, is_charm: false }, // 4
    SpellInfo { name: "Grow", resolve: Resolve::SoftMoves, role: Role::Sorcery, count: 2, counts: (0, 0), is_static: false, is_charm: false }, // 5
    SpellInfo { name: "Fireblast", resolve: Resolve::Fireblast, role: Role::Sorcery, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 6
    SpellInfo { name: "Hail_Storm", resolve: Resolve::HailStorm, role: Role::Sorcery, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 7
    SpellInfo { name: "Meteor", resolve: Resolve::Meteor, role: Role::Sorcery, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 8
    SpellInfo { name: "Seal_of_Wind", resolve: Resolve::None_, role: Role::Sorcery, count: 0, counts: (0, 0), is_static: true, is_charm: false }, // 9
    SpellInfo { name: "Sprout", resolve: Resolve::SoftMoves, role: Role::Charm, count: 1, counts: (0, 0), is_static: false, is_charm: true }, // 10
    SpellInfo { name: "Slash", resolve: Resolve::HardMoves, role: Role::Charm, count: 1, counts: (0, 0), is_static: false, is_charm: true }, // 11
    SpellInfo { name: "Surge", resolve: Resolve::SurgeMove, role: Role::Charm, count: 0, counts: (0, 0), is_static: false, is_charm: true }, // 12
    SpellInfo { name: "Comet", resolve: Resolve::Comet, role: Role::Charm, count: 0, counts: (0, 0), is_static: false, is_charm: true }, // 13
    SpellInfo { name: "Seal_of_Summer", resolve: Resolve::None_, role: Role::Charm, count: 0, counts: (0, 0), is_static: true, is_charm: true }, // 14
    SpellInfo { name: "Blossom", resolve: Resolve::Blossom, role: Role::Ritual, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 15
    SpellInfo { name: "Scatter", resolve: Resolve::Scatter, role: Role::Sorcery, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 16
    SpellInfo { name: "Seal_of_Spring", resolve: Resolve::None_, role: Role::Charm, count: 0, counts: (0, 0), is_static: true, is_charm: true }, // 17
    SpellInfo { name: "Syzygy", resolve: Resolve::Syzygy, role: Role::Ritual, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 18
    SpellInfo { name: "Eclipse", resolve: Resolve::Eclipse, role: Role::Sorcery, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 19
    SpellInfo { name: "Azimuth", resolve: Resolve::Azimuth, role: Role::Charm, count: 0, counts: (0, 0), is_static: false, is_charm: true }, // 20
    SpellInfo { name: "Erupt", resolve: Resolve::Erupt, role: Role::Ritual, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 21
    SpellInfo { name: "Fury", resolve: Resolve::Fury, role: Role::Sorcery, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 22
    SpellInfo { name: "Charge", resolve: Resolve::Charge, role: Role::Charm, count: 0, counts: (0, 0), is_static: false, is_charm: true }, // 23
    SpellInfo { name: "Hurricane", resolve: Resolve::Hurricane, role: Role::Ritual, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 24
    SpellInfo { name: "Storm_Front", resolve: Resolve::StormFront, role: Role::Sorcery, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 25
    SpellInfo { name: "Gust", resolve: Resolve::Gust, role: Role::Charm, count: 0, counts: (0, 0), is_static: false, is_charm: true }, // 26
    SpellInfo { name: "Tsunami", resolve: Resolve::SoftHardChain, role: Role::Ritual, count: 0, counts: (2, 2), is_static: false, is_charm: false }, // 27
    SpellInfo { name: "Torrent", resolve: Resolve::SoftHardChain, role: Role::Sorcery, count: 0, counts: (1, 1), is_static: false, is_charm: false }, // 28
    SpellInfo { name: "Splash", resolve: Resolve::SurgeMove, role: Role::Charm, count: 0, counts: (0, 0), is_static: false, is_charm: true }, // 29
    SpellInfo { name: "Harvest", resolve: Resolve::LockedOrSelfMoves, role: Role::Ritual, count: 5, counts: (0, 0), is_static: false, is_charm: false }, // 30
    SpellInfo { name: "Gather", resolve: Resolve::LockedOrSelfMoves, role: Role::Sorcery, count: 3, counts: (0, 0), is_static: false, is_charm: false }, // 31
    SpellInfo { name: "Seal_of_Autumn", resolve: Resolve::None_, role: Role::Charm, count: 0, counts: (0, 0), is_static: true, is_charm: true }, // 32
    SpellInfo { name: "Corrupt", resolve: Resolve::Corrupt, role: Role::Ritual, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 33
    SpellInfo { name: "Decay", resolve: Resolve::DestroyExposed, role: Role::Sorcery, count: 0, counts: (0, 0), is_static: false, is_charm: false }, // 34
    SpellInfo { name: "Lurk", resolve: Resolve::RestrictedMove, role: Role::Charm, count: 0, counts: (0, 0), is_static: false, is_charm: true }, // 35
    SpellInfo { name: "Seal_of_Destruction", resolve: Resolve::None_, role: Role::Ritual, count: 0, counts: (0, 0), is_static: true, is_charm: false }, // 36
    SpellInfo { name: "Seal_of_Stone", resolve: Resolve::None_, role: Role::Sorcery, count: 0, counts: (0, 0), is_static: true, is_charm: false }, // 37
    SpellInfo { name: "Seal_of_Winter", resolve: Resolve::None_, role: Role::Charm, count: 0, counts: (0, 0), is_static: true, is_charm: true }, // 38
];

/// Spell ids by role, for building legal draws.
pub const RITUALS: [u8; 13] = [0, 1, 2, 3, 4, 15, 18, 21, 24, 27, 30, 33, 36];
pub const SORCERIES: [u8; 13] = [5, 6, 7, 8, 9, 16, 19, 22, 25, 28, 31, 34, 37];
pub const CHARMS: [u8; 13] = [10, 11, 12, 13, 14, 17, 20, 23, 26, 29, 32, 35, 38];

/// Ids referenced by static checks and resolvers elsewhere.
pub const SEAL_OF_LIGHTNING: u8 = 4;
pub const SEAL_OF_WIND: u8 = 9;
pub const SEAL_OF_SUMMER: u8 = 14;
pub const SEAL_OF_SPRING: u8 = 17;
pub const SEAL_OF_AUTUMN: u8 = 32;
pub const SEAL_OF_DESTRUCTION: u8 = 36;
pub const SEAL_OF_STONE: u8 = 37;
pub const SEAL_OF_WINTER: u8 = 38;
pub const SURGE: u8 = 12;
pub const SPLASH: u8 = 29;
pub const HARVEST: u8 = 30;
pub const GATHER: u8 = 31;
pub const TSUNAMI: u8 = 27;
pub const TORRENT: u8 = 28;
pub const LURK: u8 = 35;
pub const DECAY: u8 = 34;
pub const HURRICANE: u8 = 24;
pub const HAIL_STORM: u8 = 7;
pub const GUST: u8 = 26;
