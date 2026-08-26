//! JS-compatible action emission.
//!
//! `applyAITurn` (ai-player.js) replays an AI turn on the live board, and accepts
//! exactly these stone-mutating action types. Field names and semantics below were
//! read off that function, not guessed:
//!
//!   move          node                       place own
//!   hard_move     node, pushed_to            place own, relocate/crush enemy
//!                                            (the applier RECOMPUTES push options
//!                                             and only honours pushed_to if it is
//!                                             among them, else uses options[0])
//!   blink         node                       place own (or push, if occupied)
//!   cast          spell, kept                clear the sigil, then place `kept`
//!   dash          sacrificed[]               clear own stones
//!   dash_lightning sacrificed[]              same, one-stone cost
//!   sacrifice     node                       clear own
//!   fireblast     destroyed[]                clear enemy
//!   hail_storm    destroyed[]                clear enemy
//!   decay         destroyed[]                clear enemy
//!   hurricane     destroyed[]                clear enemy
//!   storm_front   destroyed[]                clear enemy
//!   meteor_destroy node                      clear enemy
//!   bewitch       node, node2                place own (converting)
//!   corrupt       converted[]                place own (converting)
//!   starfall      node, node2, destroyed[]   place own x2, clear enemy
//!   gust          destroyed[], kept[]        clear enemy, then place ENEMY at kept
//!
//! Because `hard_move` lets the applier recompute the push, the ORDER of actions
//! matters: a later action must not depend on a board state the applier reached
//! differently. That is why spell resolution records the actions it actually took
//! rather than reconstructing them from a before/after delta.

use crate::topology::NAMES;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsAct {
    pub t: &'static str,
    pub node: Option<u8>,
    pub node2: Option<u8>,
    pub pushed_to: Option<u8>,
    /// Carries `destroyed` / `converted` / `sacrificed` / `kept` depending on `t`.
    pub nodes: Vec<u8>,
    pub kept: Vec<u8>,
    pub spell: Option<&'static str>,
}

impl JsAct {
    pub fn simple(t: &'static str, node: u8) -> Self {
        JsAct { t, node: Some(node), node2: None, pushed_to: None,
                nodes: vec![], kept: vec![], spell: None }
    }
    pub fn mv(node: u8, push_to: Option<u8>, is_enemy: bool, blink: bool) -> Self {
        let t = if blink { "blink" } else if is_enemy { "hard_move" } else { "move" };
        JsAct { t, node: Some(node), node2: None, pushed_to: push_to,
                nodes: vec![], kept: vec![], spell: None }
    }
    pub fn list(t: &'static str, nodes: Vec<u8>) -> Self {
        JsAct { t, node: None, node2: None, pushed_to: None, nodes, kept: vec![], spell: None }
    }
    pub fn pair(t: &'static str, a: u8, b: Option<u8>, destroyed: Vec<u8>) -> Self {
        JsAct { t, node: Some(a), node2: b, pushed_to: None,
                nodes: destroyed, kept: vec![], spell: None }
    }
    pub fn cast(spell: &'static str, kept: Vec<u8>) -> Self {
        JsAct { t: "cast", node: None, node2: None, pushed_to: None,
                nodes: vec![], kept, spell: Some(spell) }
    }
    pub fn gust(destroyed: Vec<u8>, kept: Vec<u8>) -> Self {
        JsAct { t: "gust", node: None, node2: None, pushed_to: None,
                nodes: destroyed, kept, spell: None }
    }

    /// The field name `nodes` maps to for this action type.
    fn list_key(&self) -> &'static str {
        match self.t {
            "corrupt" => "converted",
            "dash" | "dash_lightning" => "sacrificed",
            _ => "destroyed",
        }
    }

    pub fn to_json(&self) -> String {
        let mut parts = vec![format!("\"type\":\"{}\"", self.t)];
        if let Some(n) = self.node { parts.push(format!("\"node\":\"{}\"", NAMES[n as usize])); }
        if let Some(n) = self.node2 { parts.push(format!("\"node2\":\"{}\"", NAMES[n as usize])); }
        if let Some(n) = self.pushed_to {
            parts.push(format!("\"pushed_to\":\"{}\"", NAMES[n as usize]));
        }
        if let Some(s) = self.spell { parts.push(format!("\"spell\":\"{}\"", s)); }
        if !self.nodes.is_empty() {
            let l: Vec<String> = self.nodes.iter().map(|&n| format!("\"{}\"", NAMES[n as usize])).collect();
            parts.push(format!("\"{}\":[{}]", self.list_key(), l.join(",")));
        }
        if !self.kept.is_empty() {
            let l: Vec<String> = self.kept.iter().map(|&n| format!("\"{}\"", NAMES[n as usize])).collect();
            parts.push(format!("\"kept\":[{}]", l.join(",")));
        }
        format!("{{{}}}", parts.join(","))
    }
}

pub fn acts_to_json(acts: &[JsAct]) -> String {
    let l: Vec<String> = acts.iter().map(|a| a.to_json()).collect();
    format!("[{}]", l.join(","))
}
