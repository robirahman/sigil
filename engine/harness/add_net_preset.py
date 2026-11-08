#!/usr/bin/env python3
"""Wire a trained network into the engine as an eval preset (training plan C4).

    add_net_preset.py <name> <net.bin> <golden.txt> --doc "one line" [--wasm]

Copies the net and its golden vectors (`nn_eval.py golden`) to engine/nets/,
then edits, anchored on the `nnue_mt256` entries:
  * nn.rs     an `NnSpec` static and a `by_name` arm;
  * eval.rs   the `EVAL_NAMES` array(s), a `weights_by_name` arm on the
              material + tempo base (`..MATERIAL_TEMPO`, as `nnue_mt256`), and
              the unknown-name error text;
  * tests.rs  a test that the Rust forward pass matches every golden vector.
Without --wasm the preset is native-only (`#[cfg(not(target_arch = "wasm32"))]`),
so arena candidates do not grow the browser build; pass --wasm for the net
that ships. Refuses to run twice for the same name. Run `cargo test` after.
"""
import argparse
import os
import re
import shutil
import sys

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def edit(path, fn):
    s = open(path, encoding='utf-8').read()
    t = fn(s)
    if t == s:
        sys.exit(f'{path}: nothing changed')
    open(path, 'w', encoding='utf-8').write(t)


def once(s, old, new, what):
    if s.count(old) != 1:
        sys.exit(f'anchor for {what} found {s.count(old)} times (expected 1): {old[:80]!r}')
    return s.replace(old, new)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('name'); ap.add_argument('net'); ap.add_argument('golden')
    ap.add_argument('--doc', required=True)
    ap.add_argument('--wasm', action='store_true')
    a = ap.parse_args()
    name = a.name
    if not re.fullmatch(r'nnue_[a-z0-9_]+', name):
        sys.exit('preset names look like nnue_<lowercase>')
    const = name.upper()
    nets = os.path.join(ENGINE, 'nets')
    if os.path.exists(os.path.join(nets, name + '.bin')):
        sys.exit(f'{name}.bin already in engine/nets/')
    with open(a.net, 'rb') as f:
        magic = f.read(4)
    if magic not in (b'SNN1', b'SNN2'):
        sys.exit(f'{a.net}: magic {magic!r} is not SNN1/SNN2')
    n_golden = sum(1 for line in open(a.golden) if line.strip())
    if n_golden < 50:
        sys.exit(f'{a.golden}: only {n_golden} vectors (nn-wasm-parity.js needs >= 50)')
    shutil.copyfile(a.net, os.path.join(nets, name + '.bin'))
    shutil.copyfile(a.golden, os.path.join(nets, name + '_golden.txt'))
    gate = '' if a.wasm else '#[cfg(not(target_arch = "wasm32"))]\n'
    arm_gate = '' if a.wasm else '        #[cfg(not(target_arch = "wasm32"))]\n'

    def nn_rs(s):
        anchor = 'pub static NNUE_MT256: NnSpec = NnSpec::new("nnue_mt256", include_bytes!("../nets/nnue_mt256.bin"));\n'
        s = once(s, anchor, anchor + f'/// {a.doc}\n{gate}pub static {const}: NnSpec = NnSpec::new("{name}", '
                 f'include_bytes!("../nets/{name}.bin"));\n', 'nn.rs static')
        anchor = '        "nnue_mt256" => Some(&NNUE_MT256),\n'
        return once(s, anchor, anchor + f'{arm_gate}        "{name}" => Some(&{const}),\n', 'nn.rs by_name')

    def eval_rs(s):
        arrays = [('#[cfg(not(target_arch = "wasm32"))]\npub const EVAL_NAMES: [&str; ', 'native')]
        if a.wasm:
            arrays.append(('#[cfg(target_arch = "wasm32")]\npub const EVAL_NAMES: [&str; ', 'wasm'))
        for head, what in arrays:
            i = s.index(head) + len(head)
            j = s.index(']', i)
            n = int(s[i:j])
            k = s.index('\n];', j)
            s = s[:i] + str(n + 1) + s[j:k] + f'\n    "{name}",' + s[k:]
        anchor = '        "nnue_mt256" => Weights { nn: Some(&crate::nn::NNUE_MT256), ..MATERIAL_TEMPO },\n'
        s = once(s, anchor, anchor + f'        // {a.doc}\n{arm_gate}        "{name}" => Weights {{ nn: Some(&crate::nn::{const}), '
                 '..MATERIAL_TEMPO },\n', 'eval.rs weights_by_name')
        # Anchor on the names after the presets: each preset lands just before `hand`,
        # so a second preset no longer misses an anchor the first one moved.
        return once(s, ', hand, s01, s02,', f', {name}, hand, s01, s02,', 'eval.rs error text')

    def tests_rs(s):
        test = f'''
/// `{name}` (added by engine/harness/add_net_preset.py): the Rust forward pass equals
/// the Python integer forward pass on every golden vector, SNN2 walls / bank included.
{gate}#[test]
fn {name}_matches_python_golden() {{
    let net = crate::nn::by_name("{name}").unwrap().net();
    let mut n = 0;
    for line in include_str!("../nets/{name}_golden.txt").lines() {{
        let f: Vec<&str> = line.split(' ').collect();
        let sp: Vec<u8> = f[2].split(',').map(|x| x.parse().unwrap()).collect();
        let spells: [u8; 9] = sp.try_into().unwrap();
        let (got, want) = if f.len() == 8 {{
            let c = if f[6] == "1" {{ Color::Red }} else {{ Color::Blue }};
            (net.eval_raw_full(&spells, f[0].parse().unwrap(), f[1].parse().unwrap(), f[3].parse().unwrap(),
                               f[4].parse().unwrap(), f[5].parse().unwrap(), c), f[7].parse::<i32>().unwrap())
        }} else {{
            let c = if f[3] == "1" {{ Color::Red }} else {{ Color::Blue }};
            (net.eval_raw(&spells, f[0].parse().unwrap(), f[1].parse().unwrap(), c), f[4].parse::<i32>().unwrap())
        }};
        assert_eq!(got, want, "{name} {{line}}");
        n += 1;
    }}
    assert!(n >= 50, "only {{n}} golden vectors");
    assert!(crate::eval::weights_by_name("{name}").is_ok());
}}
'''
        return s.rstrip('\n') + '\n' + test

    edit(os.path.join(ENGINE, 'src', 'nn.rs'), nn_rs)
    edit(os.path.join(ENGINE, 'src', 'eval.rs'), eval_rs)
    edit(os.path.join(ENGINE, 'src', 'tests.rs'), tests_rs)
    print(f'added preset {name} ({magic.decode()}, {n_golden} golden vectors, {"wasm + native" if a.wasm else "native only"})')


if __name__ == '__main__':
    main()
