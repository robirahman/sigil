//! Sigil bitboard engine — official 39-spell scope (ids 0..38).
//! Deferred playtest packs (Tectonic/Providence/Aftershock/Ambush, 39..50) and the
//! unofficial fan-made Panda pack are both out of scope.
pub mod topology;
pub mod board;
pub mod zobrist;
pub mod spells_meta;
pub mod cast;
pub mod resolvers;
pub mod cast_enum;
pub mod turn;
pub mod order;
pub mod turn_iter;
pub mod sfn;
pub mod eval;
pub mod search;
pub mod py;

#[cfg(test)]
mod tests;
