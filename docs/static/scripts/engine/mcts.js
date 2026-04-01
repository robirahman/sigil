/**
 * Simplified MCTS for browser-based AI.
 * Ported from ai/mcts.py with single-threaded evaluation (no batching).
 */

const MCTS_C_PUCT = 2.0;
const MCTS_DEFAULT_SIMS = 100;

class MCTSNode {
	constructor(board, color, parent, parentIdx) {
		this.board = board;
		this.color = color;
		this.parent = parent || null;
		this.parentIdx = parentIdx !== undefined ? parentIdx : null;
		this.children = {};
		this.legalTurns = null;
		this.prior = null;
		this.visitCount = null;
		this.totalValue = null;
		this.isTerminal = false;
		this.terminalValue = 0;
		this.isExpanded = false;
	}

	get totalVisits() {
		if (!this.visitCount) return 0;
		let s = 0;
		for (let i = 0; i < this.visitCount.length; i++) s += this.visitCount[i];
		return s;
	}
}

/**
 * Run MCTS search and return best turn + policy.
 * @param {SimBoard} board
 * @param {string} color
 * @param {SigilNetJS} model
 * @param {number} numSimulations
 * @returns {{ turn: SimTurn, policy: Float32Array, value: number }}
 */
function mctsSearch(board, color, model, numSimulations) {
	numSimulations = numSimulations || MCTS_DEFAULT_SIMS;

	const root = new MCTSNode(board.copy(), color);
	_mctsExpand(root, model);

	if (root.isTerminal || !root.legalTurns || root.legalTurns.length === 0) {
		return {
			turn: new SimTurn([new SimAction('pass')]),
			policy: new Float32Array([1.0]),
			value: 0,
		};
	}

	// Add Dirichlet noise at root for diversity
	if (root.prior && root.prior.length > 1) {
		const noise = _dirichlet(root.prior.length, 0.5);
		const eps = 0.25;
		for (let i = 0; i < root.prior.length; i++) {
			root.prior[i] = (1 - eps) * root.prior[i] + eps * noise[i];
		}
	}

	// Run simulations
	for (let sim = 0; sim < numSimulations; sim++) {
		let node = root;
		const searchPath = [];

		// Selection
		while (node.isExpanded && !node.isTerminal) {
			const actionIdx = _mctsSelectAction(node);
			searchPath.push([node, actionIdx]);

			if (!(actionIdx in node.children)) {
				const childBoard = node.board.copy();
				const turn = node.legalTurns[actionIdx];
				applySimTurn(childBoard, turn, node.color);
				childBoard.update();
				childBoard.checkGameOver(node.color);

				const childColor = node.color === 'red' ? 'blue' : 'red';
				if (!childBoard.gameover) childBoard.advanceTurn();

				node.children[actionIdx] = new MCTSNode(childBoard, childColor, node, actionIdx);
				node = node.children[actionIdx];
				break;
			}
			node = node.children[actionIdx];
		}

		// Evaluate leaf
		let leafValue;
		if (node.isTerminal) {
			leafValue = node.terminalValue;
		} else if (node.isExpanded) {
			leafValue = 0;
		} else {
			leafValue = _mctsExpand(node, model);
		}

		// Backup
		for (let i = searchPath.length - 1; i >= 0; i--) {
			const [parentNode, actionIdx] = searchPath[i];
			const parentValue = parentNode.color !== node.color ? -leafValue : leafValue;
			parentNode.visitCount[actionIdx]++;
			parentNode.totalValue[actionIdx] += parentValue;
			leafValue = -leafValue;
		}
	}

	// Extract policy from visit counts
	const visits = root.visitCount;
	let totalV = 0;
	for (let i = 0; i < visits.length; i++) totalV += visits[i];
	const policy = new Float32Array(visits.length);
	for (let i = 0; i < visits.length; i++) policy[i] = totalV > 0 ? visits[i] / totalV : 1.0 / visits.length;

	// Pick best (greedy)
	let bestIdx = 0, bestVisits = -1;
	for (let i = 0; i < visits.length; i++) {
		if (visits[i] > bestVisits) { bestVisits = visits[i]; bestIdx = i; }
	}

	let rootValue = 0;
	if (totalV > 0) {
		let tvSum = 0;
		for (let i = 0; i < root.totalValue.length; i++) tvSum += root.totalValue[i];
		rootValue = tvSum / totalV;
	}

	return { turn: root.legalTurns[bestIdx], policy, value: rootValue };
}

function _mctsExpand(node, model) {
	const board = node.board;

	if (board.gameover) {
		node.isTerminal = true;
		node.isExpanded = true;
		if (board.winner === node.color) node.terminalValue = 1;
		else if (board.winner) node.terminalValue = -1;
		else node.terminalValue = 0;
		return node.terminalValue;
	}

	node.legalTurns = [...board.getLegalTurns(node.color)];
	if (!node.legalTurns.length) {
		node.isTerminal = true;
		node.isExpanded = true;
		node.terminalValue = 0;
		return 0;
	}

	const N = node.legalTurns.length;
	node.visitCount = new Float32Array(N);
	node.totalValue = new Float32Array(N);

	// NN evaluation
	const { raw, spellIds } = boardToTensor(board, node.color);
	const turnFeats = encodeAllTurns(node.legalTurns, board, node.color);
	const { value, policy } = model.evaluateWithPolicy(raw, spellIds, turnFeats, N);
	node.prior = policy;
	node.isExpanded = true;
	return value;
}

function _mctsSelectAction(node) {
	const totalN = node.totalVisits;
	const sqrtTotal = totalN > 0 ? Math.sqrt(totalN) : 1;

	let bestScore = -Infinity, bestIdx = 0;
	for (let i = 0; i < node.prior.length; i++) {
		const n = node.visitCount[i];
		const q = n > 0 ? node.totalValue[i] / n : 0;
		const u = MCTS_C_PUCT * node.prior[i] * sqrtTotal / (1 + n);
		const score = q + u;
		if (score > bestScore) { bestScore = score; bestIdx = i; }
	}
	return bestIdx;
}

function _dirichlet(n, alpha) {
	// Approximate Dirichlet distribution using Gamma samples
	const samples = new Float32Array(n);
	let sum = 0;
	for (let i = 0; i < n; i++) {
		// Gamma(alpha, 1) approximation using Marsaglia method
		let g;
		if (alpha >= 1) {
			const d = alpha - 1/3, c = 1/Math.sqrt(9*d);
			while (true) {
				let x, v;
				do { x = _randn(); v = 1 + c * x; } while (v <= 0);
				v = v * v * v;
				const u = Math.random();
				if (u < 1 - 0.0331 * x * x * x * x) { g = d * v; break; }
				if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) { g = d * v; break; }
			}
		} else {
			// alpha < 1: use Gamma(alpha+1) * U^(1/alpha)
			const d = alpha + 1 - 1/3, c = 1/Math.sqrt(9*d);
			while (true) {
				let x, v;
				do { x = _randn(); v = 1 + c * x; } while (v <= 0);
				v = v * v * v;
				const u = Math.random();
				if (u < 1 - 0.0331 * x * x * x * x) { g = d * v * Math.pow(Math.random(), 1/alpha); break; }
				if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) { g = d * v * Math.pow(Math.random(), 1/alpha); break; }
			}
		}
		samples[i] = g;
		sum += g;
	}
	for (let i = 0; i < n; i++) samples[i] /= sum;
	return samples;
}

function _randn() {
	// Box-Muller transform
	const u1 = Math.random(), u2 = Math.random();
	return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
