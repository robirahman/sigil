/**
 * Browser inference for SigilNetGraph (graph-conv trunk).
 * Mirrors ai/sigil_net_graph.py:SigilNetGraph.forward.
 *
 * Reuses the matmul / linear / layerNorm helpers from SigilNetJS by
 * subclassing it. Overrides `forward` to take the graph path:
 *   1. Slice per-node features (39 × 11) out of the 450-dim raw vector.
 *   2. Run a single GraphConv (proj) and N GraphResBlocks over the
 *      static normalized adjacency matrix.
 *   3. Mean+max pool → board summary.
 *   4. Concat with spell embeddings + global features.
 *   5. Dense ResBlocks at DENSE_TRUNK_DIM.
 *   6. Heads (value, policy via dot product with turn projection).
 *
 * Adjacency is precomputed once at load time from constants.js
 * NODE_ORDER + ADJACENCY (must match Python's _build_normalized_adjacency).
 */

const NUM_NODES_GRAPH = 39;
const _LIFE_START_GRAPH = 250;        // matches ai/sigil_net_graph.py
const _SPELL_FILL_START_GRAPH = 406;  // 250 + 156

function _buildNormalizedAdjacency() {
	const idx = {};
	NODE_ORDER.forEach((n, i) => { idx[n] = i; });
	const A = new Float32Array(NUM_NODES_GRAPH * NUM_NODES_GRAPH);
	for (const n of NODE_ORDER) {
		const i = idx[n];
		A[i * NUM_NODES_GRAPH + i] = 1.0; // self-loop
		for (const nb of (ADJACENCY[n] || [])) A[i * NUM_NODES_GRAPH + idx[nb]] = 1.0;
	}
	const deg = new Float32Array(NUM_NODES_GRAPH);
	for (let i = 0; i < NUM_NODES_GRAPH; i++) {
		let s = 0;
		for (let j = 0; j < NUM_NODES_GRAPH; j++) s += A[i * NUM_NODES_GRAPH + j];
		deg[i] = s;
	}
	const dInvSqrt = new Float32Array(NUM_NODES_GRAPH);
	for (let i = 0; i < NUM_NODES_GRAPH; i++) {
		dInvSqrt[i] = deg[i] > 0 ? 1.0 / Math.sqrt(deg[i]) : 0;
	}
	const out = new Float32Array(NUM_NODES_GRAPH * NUM_NODES_GRAPH);
	for (let i = 0; i < NUM_NODES_GRAPH; i++) {
		for (let j = 0; j < NUM_NODES_GRAPH; j++) {
			out[i * NUM_NODES_GRAPH + j] =
				dInvSqrt[i] * A[i * NUM_NODES_GRAPH + j] * dInvSqrt[j];
		}
	}
	return out;
}

function _buildStaticNodeIndicators() {
	// Two channels: is_mana, is_spell_position. Must match Python's
	// _IS_MANA / _IS_SPELL_POS in ai/sigil_net_graph.py.
	const idx = {};
	NODE_ORDER.forEach((n, i) => { idx[n] = i; });
	const isMana = new Float32Array(NUM_NODES_GRAPH);
	const isSpell = new Float32Array(NUM_NODES_GRAPH);
	for (const n of ['a1', 'b1', 'c1']) isMana[idx[n]] = 1.0;
	for (let slot = 1; slot <= 9; slot++) {
		const nodes = POSITIONS[slot] || [];
		for (const n of nodes) isSpell[idx[n]] = 1.0;
	}
	return { isMana, isSpell };
}

class SigilNetGraphJS extends SigilNetJS {
	constructor(config, weights) {
		super(config, weights);
		this._A = _buildNormalizedAdjacency();
		const ind = _buildStaticNodeIndicators();
		this._isMana = ind.isMana;
		this._isSpell = ind.isSpell;
	}

	/**
	 * Sparse-aware aggregation: out[i] = sum_j A[i,j] * x[j].
	 * x: (NUM_NODES_GRAPH × dim). Returns same shape.
	 */
	_aggregate(x, dim) {
		const N = NUM_NODES_GRAPH;
		const out = new Float32Array(N * dim);
		for (let i = 0; i < N; i++) {
			for (let j = 0; j < N; j++) {
				const w = this._A[i * N + j];
				if (w === 0) continue;
				for (let c = 0; c < dim; c++) {
					out[i * dim + c] += w * x[j * dim + c];
				}
			}
		}
		return out;
	}

	_graphConv(x, inDim, outDim, prefix) {
		const N = NUM_NODES_GRAPH;
		// Aggregate along normalized adjacency.
		const agg = this._aggregate(x, inDim);
		// Linear + LayerNorm + ReLU.
		let h = this._linear(agg, N, inDim,
		                     `${prefix}.lin.weight`, `${prefix}.lin.bias`);
		h = this._layerNorm(h, N, outDim,
		                    `${prefix}.ln.weight`, `${prefix}.ln.bias`);
		return this._relu(h);
	}

	_graphResBlock(x, dim, prefix) {
		const h1 = this._graphConv(x, dim, dim, `${prefix}.g1`);
		const h2 = this._graphConv(h1, dim, dim, `${prefix}.g2`);
		const out = new Float32Array(x.length);
		for (let i = 0; i < x.length; i++) {
			const val = h2[i] + x[i];
			out[i] = val > 0 ? val : 0;
		}
		return out;
	}

	/**
	 * Per-node feature tensor (NUM_NODES × NODE_FEATURE_DIM=11).
	 * Layout from raw — must match SigilNetGraph._node_features in Python:
	 *   - stones_own, stones_enemy, stones_empty (3) — interleaved per node
	 *   - nbhd own_frac, enemy_frac (2) — interleaved per node
	 *   - life: own_escape, enemy_escape, own_crush, enemy_crush (4)
	 *   - static: is_mana, is_spell_position (2)
	 */
	_nodeFeatures(raw) {
		const N = NUM_NODES_GRAPH;
		const C = this.config.node_feature_dim;
		const out = new Float32Array(N * C);
		// Stones (raw[0..117]) — layout: own[39], enemy[39], empty[39]
		for (let i = 0; i < N; i++) {
			out[i * C + 0] = raw[i];           // own
			out[i * C + 1] = raw[N + i];       // enemy
			out[i * C + 2] = raw[2 * N + i];   // empty
		}
		// Neighborhood (raw[117..195]) — interleaved (own, enemy) per node
		for (let i = 0; i < N; i++) {
			out[i * C + 3] = raw[3 * N + 2 * i];     // own_frac
			out[i * C + 4] = raw[3 * N + 2 * i + 1]; // enemy_frac
		}
		// Life (raw[250..406]) — layout: own_escape[39], enemy_escape[39], own_crush[39], enemy_crush[39]
		for (let i = 0; i < N; i++) {
			out[i * C + 5] = raw[_LIFE_START_GRAPH + 0 * N + i];
			out[i * C + 6] = raw[_LIFE_START_GRAPH + 1 * N + i];
			out[i * C + 7] = raw[_LIFE_START_GRAPH + 2 * N + i];
			out[i * C + 8] = raw[_LIFE_START_GRAPH + 3 * N + i];
		}
		// Static node indicators
		for (let i = 0; i < N; i++) {
			out[i * C + 9] = this._isMana[i];
			out[i * C + 10] = this._isSpell[i];
		}
		return out;
	}

	/**
	 * Concat the parts of raw not absorbed into per-node features.
	 * Must match SigilNetGraph._global_features in Python.
	 */
	_globalFeatures(raw) {
		// head = raw[195..250) (after stones+nbhd, before life)
		// tail = raw[406..end) (after life: spell_fill, threat, tempo)
		const headLen = _LIFE_START_GRAPH - 3 * NUM_NODES_GRAPH - 2 * NUM_NODES_GRAPH; // 250 - 117 - 78 = 55
		const tailLen = raw.length - _SPELL_FILL_START_GRAPH; // 450 - 406 = 44
		const out = new Float32Array(headLen + tailLen);
		out.set(raw.subarray(3 * NUM_NODES_GRAPH + 2 * NUM_NODES_GRAPH, _LIFE_START_GRAPH), 0);
		out.set(raw.subarray(_SPELL_FILL_START_GRAPH), headLen);
		return out;
	}

	forward(rawFeatures, spellIds, turnFeatures, numTurns) {
		const cfg = this.config;
		const N = NUM_NODES_GRAPH;

		// Per-node features (39 × 11) and run through graph trunk.
		let h = this._nodeFeatures(rawFeatures);
		h = this._graphConv(h, cfg.node_feature_dim, cfg.graph_hidden_dim, 'node_proj');
		const H = cfg.graph_hidden_dim;
		for (let b = 0; b < cfg.num_graph_blocks; b++) {
			h = this._graphResBlock(h, H, `graph_blocks.${b}`);
		}

		// Pool: mean + max along the 39-node axis.
		const pooled = new Float32Array(2 * H);
		for (let c = 0; c < H; c++) {
			let s = 0, mx = -Infinity;
			for (let i = 0; i < N; i++) {
				const v = h[i * H + c];
				s += v;
				if (v > mx) mx = v;
			}
			pooled[c] = s / N;
			pooled[H + c] = mx;
		}

		// Spell embedding lookup.
		const embedTable = this._getW('spell_embed.weight');
		const embedDim = cfg.spell_embed_dim;
		const spellFlat = new Float32Array(cfg.num_spell_slots * embedDim);
		for (let i = 0; i < cfg.num_spell_slots; i++) {
			const id = spellIds[i];
			spellFlat.set(
				embedTable.subarray(id * embedDim, (id + 1) * embedDim),
				i * embedDim,
			);
		}

		// Globals (raw minus per-node).
		const globals_ = this._globalFeatures(rawFeatures);

		// Concat: [pooled | spell_emb | globals]
		const denseInDim = pooled.length + spellFlat.length + globals_.length;
		const xConcat = new Float32Array(denseInDim);
		xConcat.set(pooled, 0);
		xConcat.set(spellFlat, pooled.length);
		xConcat.set(globals_, pooled.length + spellFlat.length);

		// Dense trunk: dense_in -> LN -> ReLU -> N res blocks
		const D = cfg.dense_trunk_dim;
		let x = this._linear(xConcat, 1, denseInDim, 'dense_in.weight', 'dense_in.bias');
		x = this._layerNorm(x, 1, D, 'dense_in_ln.weight', 'dense_in_ln.bias');
		x = this._relu(x);
		for (let b = 0; b < cfg.num_dense_res_blocks; b++) {
			x = this._denseResBlock(x, 1, D, b);
		}

		// Value head
		let v = this._linear(x, 1, D, 'value_fc1.weight', 'value_fc1.bias');
		v = this._relu(v);
		v = this._linear(v, 1, cfg.value_hidden_dim, 'value_fc2.weight', 'value_fc2.bias');
		v = this._tanh(v);
		const value = v[0];

		// Policy head
		let policyLogits = null;
		if (turnFeatures && numTurns > 0) {
			const boardProj = this._linear(x, 1, D, 'policy_proj.weight', 'policy_proj.bias');
			const turnProj = this._linear(turnFeatures, numTurns, cfg.turn_feature_dim,
			                              'turn_proj.weight', 'turn_proj.bias');
			policyLogits = new Float32Array(numTurns);
			const pDim = cfg.policy_hidden_dim;
			for (let i = 0; i < numTurns; i++) {
				let dot = 0;
				for (let j = 0; j < pDim; j++) {
					dot += turnProj[i * pDim + j] * boardProj[j];
				}
				policyLogits[i] = dot;
			}
		}

		return { value, policyLogits };
	}

	_denseResBlock(x, rows, dim, blockIdx) {
		const prefix = `dense_blocks.${blockIdx}`;
		let out = this._linear(x, rows, dim, `${prefix}.fc1.weight`, `${prefix}.fc1.bias`);
		out = this._layerNorm(out, rows, dim, `${prefix}.ln1.weight`, `${prefix}.ln1.bias`);
		out = this._relu(out);
		out = this._linear(out, rows, dim, `${prefix}.fc2.weight`, `${prefix}.fc2.bias`);
		out = this._layerNorm(out, rows, dim, `${prefix}.ln2.weight`, `${prefix}.ln2.bias`);
		const result = new Float32Array(rows * dim);
		for (let i = 0; i < result.length; i++) {
			const val = out[i] + x[i];
			result[i] = val > 0 ? val : 0;
		}
		return result;
	}

	static async load(manifestUrl, binUrl) {
		const [manifestResp, binResp] = await Promise.all([
			fetch(manifestUrl),
			fetch(binUrl),
		]);
		const manifest = await manifestResp.json();
		const binBuffer = await binResp.arrayBuffer();
		const weights = {};
		for (const [key, info] of Object.entries(manifest.tensors)) {
			const arr = new Float32Array(binBuffer, info.offset, info.length);
			weights[key] = { data: arr, shape: info.shape };
		}
		return new SigilNetGraphJS(manifest.config, weights);
	}
}
