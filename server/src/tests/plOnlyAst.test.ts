// tests/plOnlyAstTopo.test.ts
// Unified AST (DAG) for PL-only cash world, with topological sort evaluation.
// - Build ONE AST from unordered user rules (CURR refs point to other accounts' nodes)
// - Evaluate by (A) recursive memo eval and (B) topological order (Kahn)
// - Validate AST integrity and acyclicity
// - Export DOT for visualization
// - EXPECT constants keep assertions readable
//
// Run: npx jest   (ts-jest recommended; DOM Node is not used since we define ASTNode)

type Op = 'ADD' | 'SUB' | 'MUL';
type PeriodRef = 'PREV' | 'CURR';

interface RefInput { period: PeriodRef; account: string; sign?: 1 | -1; }

type RuleInput =
	| { type: 'GROWTH_RATE'; value: number; refs: [RefInput] }   // current = ref * (1 + value)
	| { type: 'CALCULATION'; refs: RefInput[] };                 // signed sum over refs

type NodeId = string;

interface ASTNode {
	id: NodeId;
	value?: number;         // FF if defined
	left?: NodeId;          // TT if binary op is defined
	right?: NodeId;
	op?: Op;                // 'ADD' | 'SUB' | 'MUL'
	label?: string;         // for DOT
	kind?: 'FF' | 'TT';
}

class NodeRegistry {
	private seq = 0;
	private map = new Map<NodeId, ASTNode>();
	newId(prefix: string) { return `${prefix}:${++this.seq}`; }
	add(n: ASTNode) { this.map.set(n.id, n); return n.id; }
	get(id: NodeId) { const n = this.map.get(id); if (!n) throw new Error(`Node not found: ${id}`); return n; }
	all(): ASTNode[] { return Array.from(this.map.values()); }
}

function makeFF(reg: NodeRegistry, v: number, label: string): NodeId {
	const id = reg.newId('ff');
	reg.add({ id, value: v, label: `FF:${label}`, kind: 'FF' });
	return id;
}
function makeBin(reg: NodeRegistry, left: NodeId, right: NodeId, op: Op, label: string): NodeId {
	const id = reg.newId('tt');
	reg.add({ id, left, right, op, label: `TT:${label}`, kind: 'TT' });
	return id;
}

/* =========
   Compiler: unordered rules → single AST (DAG)
   ========= */

interface CompileCtx {
	reg: NodeRegistry;
	prev: Record<string, number>;
	rules: Record<string, RuleInput>;
	roots: Record<string, NodeId>;  // account -> node id
	visiting: Set<string>;          // for cycle guard during build
}

function buildAccountNode(ctx: CompileCtx, acct: string): NodeId {
	if (ctx.roots[acct]) return ctx.roots[acct];
	if (ctx.visiting.has(acct)) throw new Error(`Cycle detected while building: ${acct}`);
	ctx.visiting.add(acct);

	const rule = ctx.rules[acct];
	if (!rule) throw new Error(`No rule for account: ${acct}`);

	let nodeId: NodeId;

	if (rule.type === 'GROWTH_RATE') {
		const r = rule.refs[0];
		const baseNode =
			r.period === 'PREV'
				? makeFF(ctx.reg, ctx.prev[r.account], `${r.account}(prev)`)
				: buildAccountNode(ctx, r.account);
		const factor = makeFF(ctx.reg, 1 + rule.value, `1+growth(${rule.value})`);
		nodeId = makeBin(ctx.reg, baseNode, factor, 'MUL', `${acct}=ref*factor`);
	} else {
		// CALCULATION: signed sum of refs (PREV -> FF const, CURR -> referenced account root)
		const terms: NodeId[] = [];
		for (const ref of rule.refs) {
			const sign = ref.sign ?? 1;
			let base = ref.period === 'PREV'
				? makeFF(ctx.reg, ctx.prev[ref.account], `${ref.account}(prev)`)
				: buildAccountNode(ctx, ref.account);
			if (sign === -1) {
				const m1 = makeFF(ctx.reg, -1, '-1');
				base = makeBin(ctx.reg, base, m1, 'MUL', `${ref.account}*(-1)`);
			}
			terms.push(base);
		}
		if (terms.length === 0) {
			nodeId = makeFF(ctx.reg, 0, '0');
		} else if (terms.length === 1) {
			nodeId = terms[0];
		} else {
			let acc = makeBin(ctx.reg, terms[0], terms[1], 'ADD', `${acct}:acc`);
			for (let i = 2; i < terms.length; i++) {
				acc = makeBin(ctx.reg, acc, terms[i], 'ADD', `${acct}:acc`);
			}
			nodeId = acc;
		}
	}

	ctx.roots[acct] = nodeId;
	ctx.visiting.delete(acct);
	return nodeId;
}

function compileUnifiedAST(
	prev: Record<string, number>,
	flatRules: Record<string, RuleInput>,
	cashAccount = '現金'
) {
	const ctx: CompileCtx = { reg: new NodeRegistry(), prev, rules: flatRules, roots: {}, visiting: new Set() };
	for (const acct of Object.keys(flatRules)) buildAccountNode(ctx, acct);

	// Connect Cash: 現金 = 現金(prev) + 経常利益
	if (ctx.roots['経常利益'] != null && prev[cashAccount] != null) {
		const cashPrev = makeFF(ctx.reg, prev[cashAccount], `${cashAccount}(prev)`);
		const cashRoot = makeBin(ctx.reg, cashPrev, ctx.roots['経常利益'], 'ADD', `${cashAccount}=prev+経常利益`);
		ctx.roots[cashAccount] = cashRoot;
	}

	return ctx;
}

/* =========
   Evaluation A: recursive memo (for correctness baseline)
   ========= */
function evalNodeRecursive(id: NodeId, reg: NodeRegistry, memo = new Map<NodeId, number>()): number {
	if (memo.has(id)) return memo.get(id)!;
	const n = reg.get(id);
	if (typeof n.value === 'number') { memo.set(id, n.value); return n.value; }
	if (!n.left || !n.right || !n.op) throw new Error(`Invalid TT node: ${id}`);
	const a = evalNodeRecursive(n.left, reg, memo);
	const b = evalNodeRecursive(n.right, reg, memo);
	let v: number;
	switch (n.op) {
		case 'ADD': v = a + b; break;
		case 'SUB': v = a - b; break;
		case 'MUL': v = a * b; break;
		default: throw new Error(`Unknown op: ${n.op}`);
	}
	memo.set(id, v);
	return v;
}

/* =========
   Evaluation B: topological order (Kahn)
   ========= */

// Collect subgraph nodes reachable from roots
function collectSubgraph(reg: NodeRegistry, roots: NodeId[]): Set<NodeId> {
	const seen = new Set<NodeId>();
	const visit = (id: NodeId) => {
		if (seen.has(id)) return;
		seen.add(id);
		const n = reg.get(id);
		if (n.left) visit(n.left);
		if (n.right) visit(n.right);
	};
	for (const r of roots) visit(r);
	return seen;
}

/**
 * Build topological order using Kahn's algorithm on edges child -> parent
 * so that leaves (FF) have in-degree 0 and appear first.
 */
function topoOrder(reg: NodeRegistry, roots: NodeId[]): NodeId[] {
	const nodes = Array.from(collectSubgraph(reg, roots));
	const indeg = new Map<NodeId, number>(nodes.map(id => [id, 0]));
	const out: Record<string, NodeId[]> = {};
	for (const id of nodes) out[id] = [];

	// For each TT node, create edges from child -> parent
	for (const id of nodes) {
		const n = reg.get(id);
		if (n.left) { indeg.set(id, (indeg.get(id) || 0) + 1); out[n.left].push(id); }
		if (n.right) { indeg.set(id, (indeg.get(id) || 0) + 1); out[n.right].push(id); }
	}

	const q: NodeId[] = [];
	for (const id of nodes) if ((indeg.get(id) || 0) === 0) q.push(id);

	const order: NodeId[] = [];
	while (q.length) {
		const u = q.shift()!;
		order.push(u);
		for (const v of out[u]) {
			indeg.set(v, (indeg.get(v) || 0) - 1);
			if ((indeg.get(v) || 0) === 0) q.push(v);
		}
	}

	if (order.length !== nodes.length) {
		throw new Error('Cycle detected during topological sort');
	}
	return order;
}

/** Evaluate by topological order: children first, then parent */
function evalTopo(reg: NodeRegistry, roots: NodeId[]): Map<NodeId, number> {
	const order = topoOrder(reg, roots);
	const val = new Map<NodeId, number>();
	for (const id of order) {
		const n = reg.get(id);
		if (typeof n.value === 'number') {
			val.set(id, n.value);
		} else {
			const a = val.get(n.left!);
			const b = val.get(n.right!);
			if (a == null || b == null) throw new Error('Missing child value during topo eval');
			switch (n.op) {
				case 'ADD': val.set(id, a + b); break;
				case 'SUB': val.set(id, a - b); break;
				case 'MUL': val.set(id, a * b); break;
				default: throw new Error(`Unknown op: ${n.op}`);
			}
		}
	}
	return val;
}

/* =========
   AST validation & DOT export
   ========= */

function validateAST(reg: NodeRegistry, roots: NodeId[]) {
	// Basic FF/TT integrity
	for (const n of reg.all()) {
		const isFF = typeof n.value === 'number';
		const isTT = n.left != null && n.right != null && n.op != null;
		if (isFF === isTT) return { ok: false, reason: `Node ${n.id} must be either FF or TT` };
		if (isTT) {
			try { reg.get(n.left!); reg.get(n.right!); } catch {
				return { ok: false, reason: `Node ${n.id} references undefined child` };
			}
		}
	}
	// Acyclic: topo sort must succeed on reachable subgraph
	try { topoOrder(reg, roots); } catch (e) {
		return { ok: false, reason: 'Cycle detected' };
	}
	return { ok: true as const };
}

function toDOT(reg: NodeRegistry, roots?: NodeId[]) {
	const q = (s: string) => s.replace(/"/g, '\\"');
	const out: string[] = [];
	out.push('digraph AST {');
	out.push('  rankdir=LR;');
	for (const n of reg.all()) {
		const shape = n.kind === 'FF' ? 'ellipse' : 'box';
		const label = q((n.label ?? '') + `\\n(${n.id})`);
		out.push(`  "${n.id}" [label="${label}", shape=${shape}];`);
	}
	for (const n of reg.all()) {
		if (n.left) out.push(`  "${n.id}" -> "${n.left}" [label="L:${n.op}"];`);
		if (n.right) out.push(`  "${n.id}" -> "${n.right}" [label="R:${n.op}"];`);
	}
	if (roots?.length) {
		const list = roots.map(r => `"${r}"`).join(', ');
		out.push(`  { rank=source; ${list} }`);
	}
	out.push('}');
	return out.join('\n');
}

/* =========
   Fixture & EXPECT
   ========= */

const PREV: Record<string, number> = {
	'現金': 50,
	'売上': 1000,
	'売上原価': 600,
	'販管費': 100,
	'営業外利益': 10,
	'営業外費用': 5,
};

const RULES: Record<string, RuleInput> = {
	'経常利益': {
		type: 'CALCULATION',
		refs: [
			{ period: 'CURR', account: '営業利益', sign: +1 },
			{ period: 'CURR', account: '営業外利益', sign: +1 },
			{ period: 'CURR', account: '営業外費用', sign: -1 },
		],
	},
	'売上': { type: 'GROWTH_RATE', value: 0.10, refs: [{ period: 'PREV', account: '売上' }] },
	'売上原価': { type: 'GROWTH_RATE', value: 0.00, refs: [{ period: 'PREV', account: '売上原価' }] },
	'販管費': { type: 'GROWTH_RATE', value: 0.00, refs: [{ period: 'PREV', account: '販管費' }] },
	'営業外利益': { type: 'GROWTH_RATE', value: 0.00, refs: [{ period: 'PREV', account: '営業外利益' }] },
	'営業外費用': { type: 'GROWTH_RATE', value: 0.00, refs: [{ period: 'PREV', account: '営業外費用' }] },
	'営業利益': {
		type: 'CALCULATION',
		refs: [
			{ period: 'CURR', account: '売上', sign: +1 },
			{ period: 'CURR', account: '売上原価', sign: -1 },
			{ period: 'CURR', account: '販管費', sign: -1 },
		],
	},
};

const EXPECT = {
	SALES: 1100,
	COGS: 600,
	SGA: 100,
	NON_OP_INC: 10,
	NON_OP_EXP: 5,
	OP_INCOME: 400,
	ORDINARY_INCOME: 405,
	CASH_END: 455,
};

/* =========
   Tests
   ========= */

describe('Unified AST with topological evaluation (no per-account order)', () => {
	const ctx = compileUnifiedAST(PREV, RULES);

	const roots = ['現金', '経常利益', '営業利益', '売上', '売上原価', '販管費', '営業外利益', '営業外費用']
		.filter(a => ctx.roots[a])
		.map(a => ctx.roots[a]);

	test('AST validation passes', () => {
		const res = validateAST(ctx.reg, roots);
		expect(res.ok).toBe(true);
	});

	test('Topological order has children before parents', () => {
		const order = topoOrder(ctx.reg, roots);
		const pos = new Map<NodeId, number>(order.map((id, i) => [id, i]));
		for (const n of ctx.reg.all()) {
			if (n.left) expect(pos.get(n.left)!).toBeLessThan(pos.get(n.id)!);
			if (n.right) expect(pos.get(n.right)!).toBeLessThan(pos.get(n.id)!);
		}
	});

	test('Values via topological eval == recursive eval', () => {
		const topoVals = evalTopo(ctx.reg, roots);
		for (const name of Object.keys(ctx.roots)) {
			const root = ctx.roots[name];
			const vTopo = Math.round(topoVals.get(root)!);
			const vRec = Math.round(evalNodeRecursive(root, ctx.reg));
			expect(vTopo).toBe(vRec);
		}
	});

	test('Numbers match EXPECT (evaluated by topo)', () => {
		const vals = evalTopo(ctx.reg, roots);
		const get = (acct: string) => Math.round(vals.get(ctx.roots[acct])!);
		expect(get('売上')).toBe(EXPECT.SALES);
		expect(get('売上原価')).toBe(EXPECT.COGS);
		expect(get('販管費')).toBe(EXPECT.SGA);
		expect(get('営業利益')).toBe(EXPECT.OP_INCOME);
		expect(get('経常利益')).toBe(EXPECT.ORDINARY_INCOME);
		expect(get('現金')).toBe(EXPECT.CASH_END);
	});

	test('DOT(Graphviz) contains TT nodes (no FF:+営業利益(curr) leaves)', () => {
		const dot = toDOT(ctx.reg, [ctx.roots['現金'], ctx.roots['経常利益']]);
		expect(dot).toContain('TT:営業利益:acc');
		expect(dot).toContain('TT:経常利益:acc');
		expect(dot).not.toContain('FF:+営業利益(curr)');
		// console.log(dot); // visualize if needed
	});
});
