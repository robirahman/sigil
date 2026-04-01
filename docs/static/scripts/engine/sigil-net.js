/**
 * SigilNet inference in pure JavaScript.
 * Ported from ai/export_numpy.py SigilNetNumPy.
 * Loads weights from binary file + JSON manifest.
 */

class SigilNetJS {
	constructor(config, weights) {
		this.config = config;
		this.w = weights;
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

		return new SigilNetJS(manifest.config, weights);
	}

	_getW(key) { return this.w[key].data; }
	_getShape(key) { return this.w[key].shape; }

	// Matrix multiply: (M,K) x (K,N) -> (M,N)
	_matmul(a, aRows, aColsOrK, b, bCols) {
		const K = aColsOrK;
		const result = new Float32Array(aRows * bCols);
		for (let i = 0; i < aRows; i++) {
			for (let j = 0; j < bCols; j++) {
				let sum = 0;
				for (let k = 0; k < K; k++) {
					sum += a[i * K + k] * b[k * bCols + j];
				}
				result[i * bCols + j] = sum;
			}
		}
		return result;
	}

	// y = x @ W^T + bias, where W is (outDim, inDim)
	_linear(x, rows, inDim, weightKey, biasKey) {
		const W = this._getW(weightKey);
		const bias = this._getW(biasKey);
		const outDim = this._getShape(weightKey)[0];
		const result = new Float32Array(rows * outDim);

		for (let i = 0; i < rows; i++) {
			for (let j = 0; j < outDim; j++) {
				let sum = bias[j];
				for (let k = 0; k < inDim; k++) {
					sum += x[i * inDim + k] * W[j * inDim + k];
				}
				result[i * outDim + j] = sum;
			}
		}
		return result;
	}

	_relu(arr) {
		const result = new Float32Array(arr.length);
		for (let i = 0; i < arr.length; i++) result[i] = arr[i] > 0 ? arr[i] : 0;
		return result;
	}

	_tanh(arr) {
		const result = new Float32Array(arr.length);
		for (let i = 0; i < arr.length; i++) result[i] = Math.tanh(arr[i]);
		return result;
	}

	_layerNorm(x, rows, dim, weightKey, biasKey) {
		const w = this._getW(weightKey);
		const b = this._getW(biasKey);
		const result = new Float32Array(rows * dim);

		for (let i = 0; i < rows; i++) {
			let mean = 0;
			for (let j = 0; j < dim; j++) mean += x[i * dim + j];
			mean /= dim;
			let variance = 0;
			for (let j = 0; j < dim; j++) {
				const d = x[i * dim + j] - mean;
				variance += d * d;
			}
			variance /= dim;
			const invStd = 1.0 / Math.sqrt(variance + 1e-5);
			for (let j = 0; j < dim; j++) {
				result[i * dim + j] = w[j] * (x[i * dim + j] - mean) * invStd + b[j];
			}
		}
		return result;
	}

	_resBlock(x, rows, dim, blockIdx) {
		const prefix = `trunk.${blockIdx}`;
		// fc1 -> ln1 -> relu
		let out = this._linear(x, rows, dim, `${prefix}.fc1.weight`, `${prefix}.fc1.bias`);
		out = this._layerNorm(out, rows, dim, `${prefix}.ln1.weight`, `${prefix}.ln1.bias`);
		out = this._relu(out);
		// fc2 -> ln2
		out = this._linear(out, rows, dim, `${prefix}.fc2.weight`, `${prefix}.fc2.bias`);
		out = this._layerNorm(out, rows, dim, `${prefix}.ln2.weight`, `${prefix}.ln2.bias`);
		// residual + relu
		const result = new Float32Array(rows * dim);
		for (let i = 0; i < result.length; i++) {
			const val = out[i] + x[i];
			result[i] = val > 0 ? val : 0;
		}
		return result;
	}

	/**
	 * Forward pass.
	 * @param {Float32Array} rawFeatures - (250,) single position
	 * @param {Int32Array} spellIds - (9,) single position
	 * @param {Float32Array|null} turnFeatures - (N * 64) flat, N legal turns
	 * @param {number} numTurns - number of turns
	 * @returns {{ value: number, policyLogits: Float32Array|null }}
	 */
	forward(rawFeatures, spellIds, turnFeatures, numTurns) {
		const cfg = this.config;

		// Spell embedding lookup
		const embedTable = this._getW('spell_embed.weight'); // (15, 16)
		const embedDim = cfg.spell_embed_dim;
		const spellFlat = new Float32Array(cfg.num_spell_slots * embedDim); // 144
		for (let i = 0; i < cfg.num_spell_slots; i++) {
			const id = spellIds[i];
			spellFlat.set(
				embedTable.subarray(id * embedDim, (id + 1) * embedDim),
				i * embedDim
			);
		}

		// Raw projection: (1, 250) -> (1, 256)
		let raw = this._linear(rawFeatures, 1, cfg.raw_feature_dim, 'raw_proj.weight', 'raw_proj.bias');
		raw = this._relu(raw);

		// Concat: [144 + 256] = 400
		const trunkDim = cfg.trunk_dim;
		const x0 = new Float32Array(trunkDim);
		x0.set(spellFlat, 0);
		x0.set(raw, spellFlat.length);

		// Trunk: 6 res blocks
		let trunk = x0;
		for (let i = 0; i < cfg.num_res_blocks; i++) {
			trunk = this._resBlock(trunk, 1, trunkDim, i);
		}

		// Value head
		let v = this._linear(trunk, 1, trunkDim, 'value_fc1.weight', 'value_fc1.bias');
		v = this._relu(v);
		v = this._linear(v, 1, cfg.value_hidden_dim, 'value_fc2.weight', 'value_fc2.bias');
		v = this._tanh(v);
		const value = v[0];

		// Policy head
		let policyLogits = null;
		if (turnFeatures && numTurns > 0) {
			// board projection: (1, 400) -> (1, 256)
			const boardProj = this._linear(trunk, 1, trunkDim, 'policy_proj.weight', 'policy_proj.bias');
			// turn projection: (N, 64) -> (N, 256)
			const turnProj = this._linear(turnFeatures, numTurns, cfg.turn_feature_dim, 'turn_proj.weight', 'turn_proj.bias');
			// dot product: per-turn logit
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

	/**
	 * Full evaluation: value + softmax policy.
	 * Returns { value: number, policy: Float32Array(N) }
	 */
	evaluateWithPolicy(rawFeatures, spellIds, turnFeatures, numTurns) {
		const { value, policyLogits } = this.forward(rawFeatures, spellIds, turnFeatures, numTurns);

		let policy;
		if (policyLogits && policyLogits.length > 0) {
			// Softmax
			let maxVal = -Infinity;
			for (let i = 0; i < policyLogits.length; i++) {
				if (policyLogits[i] > maxVal) maxVal = policyLogits[i];
			}
			const exp = new Float32Array(policyLogits.length);
			let sum = 0;
			for (let i = 0; i < policyLogits.length; i++) {
				exp[i] = Math.exp(policyLogits[i] - maxVal);
				sum += exp[i];
			}
			policy = new Float32Array(policyLogits.length);
			for (let i = 0; i < policy.length; i++) policy[i] = exp[i] / sum;
		} else {
			policy = new Float32Array([1.0]);
		}

		return { value, policy };
	}
}
