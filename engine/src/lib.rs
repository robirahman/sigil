//! Sigil bitboard engine — the 39 core spells (ids 0..38) plus Tectonic
//! (39..41) and Providence (42..44). The retired packs (Aftershock/Ambush,
//! 45..50) and the unofficial fan-made Panda pack are out of scope.
pub mod topology;
pub mod board;
pub mod zobrist;
pub mod spells_meta;
pub mod cast;
pub mod rockslide;
pub mod resolvers;
pub mod actions;
pub mod cast_enum;
pub mod turn;
pub mod order;
pub mod key_dash;
pub mod ranker;
pub mod turn_iter;
pub mod sfn;
pub mod eval;
pub mod nn;
pub mod features;
pub mod search;
pub mod opening_data;
pub mod opening;
pub mod prior;
pub mod policy;
pub mod policy_lse;
pub mod policy_weights;
pub mod mate;
pub mod candidates;
#[cfg(feature = "python")]
pub mod py;

#[cfg(feature = "wasm")]
pub mod wasm;

#[cfg(test)]
mod tests;
