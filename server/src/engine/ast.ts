// src/engine/ast.ts
import { NodeRegistry } from '@/model/registry.js';
import type { Account, Cell, NodeId, Op, Period, RefInput, RuleInput } from '@/model/types.js';

export const ACC_NAME = (a: Account) => a.AccountName ?? a.account ?? a.id;
export const isPrevPeriod = (p: Period) => p.AF_type === 'Actual' || (p.offset ?? 0) < 0;

export function makeFF(reg: NodeRegistry, v: number, label: string, extra?: Partial<Cell>): NodeId {
	const id = reg.newId();
	reg.add({ id, value: v, label: `FF:${label}`, kind: 'FF', paramType: null, ref1: null, ref2: null, operator: null, ...extra });
	return id;
}
export function makeTT(reg: NodeRegistry, left: NodeId, right: NodeId, op: Op, label: string, extra?: Partial<Cell>): NodeId {
	const id = reg.newId();
	reg.add({ id, ref1: left, ref2: right, operator: op, label: `TT:${label}`, kind: 'TT', ...extra });
	return id;
}

export interface CompileCtx {
	reg: NodeRegistry;
	prev: Record<string, number>;
	rules: Record<string, RuleInput>;
	roots: Record<string, NodeId>;
	visiting: Set<string>;
}

function buildAccountNode(ctx: CompileCtx, acctKey: string): NodeId {
	if (ctx.roots[acctKey]) return ctx.roots[acctKey];
	if (ctx.visiting.has(acctKey)) throw new Error(`Cycle detected while building: ${acctKey}`);
	ctx.visiting.add(acctKey);

	const rule = ctx.rules[acctKey];
	if (!rule) throw new Error(`No rule for account: ${acctKey}`);

	let nodeId: NodeId;

	switch (rule.type) {
		case 'INPUT':
			nodeId = makeFF(ctx.reg, rule.value, `${acctKey}(input)`); break;

		case 'FIXED_VALUE':
			nodeId = makeFF(ctx.reg, rule.value, `${acctKey}(fixed)`); break;

		case 'REFERENCE': {
			const r = rule.ref; const name = ACC_NAME(r.account);
			nodeId = isPrevPeriod(r.period)
				? makeFF(ctx.reg, ctx.prev[name], `${name}(prev)`)
				: buildAccountNode(ctx, name);
			break;
		}

		case 'GROWTH_RATE': {
			const r = rule.refs[0]; const name = ACC_NAME(r.account);
			const base = isPrevPeriod(r.period)
				? makeFF(ctx.reg, ctx.prev[name], `${name}(prev)`)
				: buildAccountNode(ctx, name);
			const factor = makeFF(ctx.reg, 1 + rule.value, `1+growth(${rule.value})`);
			nodeId = makeTT(ctx.reg, base, factor, 'MUL', `${acctKey}=ref*factor`); break;
		}

		case 'PERCENTAGE': {
			const name = ACC_NAME(rule.ref.account);
			const ref = isPrevPeriod(rule.ref.period)
				? makeFF(ctx.reg, ctx.prev[name], `${name}(prev)`)
				: buildAccountNode(ctx, name);
			const rate = makeFF(ctx.reg, rule.value, `pct(${rule.value})`);
			nodeId = makeTT(ctx.reg, ref, rate, 'MUL', `${acctKey}=ref*pct`); break;
		}

		case 'PROPORTIONATE': {
			// TODO: 除算ノードの正式実装（現状は簡略）
			const baseRef: RefInput = rule.base ?? {
				account: { id: `acc:${acctKey}`, AccountName: acctKey },
				period: { Period_type: null, AF_type: 'Actual', Period_val: null, offset: -1 },
			};
			const bName = ACC_NAME(baseRef.account);
			const bNode = isPrevPeriod(baseRef.period)
				? makeFF(ctx.reg, ctx.prev[bName], `${bName}(prev)`)
				: buildAccountNode(ctx, bName);
			const ratioPlaceholder = makeFF(ctx.reg, 1, 'ratio~placeholder');
			let node = makeTT(ctx.reg, bNode, ratioPlaceholder, 'MUL', `${acctKey}=base*ratio`);
			if (rule.coeff != null) {
				const c = makeFF(ctx.reg, rule.coeff, `coeff(${rule.coeff})`);
				node = makeTT(ctx.reg, node, c, 'MUL', `${acctKey}*coeff`);
			}
			nodeId = node; break;
		}

		case 'CHILDREN_SUM':
			nodeId = makeFF(ctx.reg, 0, `${acctKey}(children_sum=0)`); break;

		case 'CALCULATION': {
			const terms: NodeId[] = [];
			for (const ref of rule.refs) {
				const s = ref.sign ?? 1;
				const name = ACC_NAME(ref.account);
				let base = isPrevPeriod(ref.period)
					? makeFF(ctx.reg, ctx.prev[name], `${name}(prev)`)
					: buildAccountNode(ctx, name);
				if (s === -1) {
					const m1 = makeFF(ctx.reg, -1, '-1');
					base = makeTT(ctx.reg, base, m1, 'MUL', `${name}*(-1)`);
				}
				terms.push(base);
			}
			if (terms.length === 0) nodeId = makeFF(ctx.reg, 0, '0');
			else if (terms.length === 1) nodeId = terms[0];
			else {
				// NOTE: TT×TT子の禁則は現状 Warning レベル（TODO: 正規化）
				let acc = makeTT(ctx.reg, terms[0], terms[1], 'ADD', `${acctKey}:acc`);
				for (let i = 2; i < terms.length; i++) acc = makeTT(ctx.reg, acc, terms[i], 'ADD', `${acctKey}:acc`);
				nodeId = acc;
			}
			break;
		}

		default: {
			const _exhaustive: never = rule;
			throw new Error(`Unsupported rule type: ${(rule as any).type}`);
		}
	}

	ctx.roots[acctKey] = nodeId;
	ctx.visiting.delete(acctKey);
	return nodeId;
}

export function compileUnifiedAST(
	prev: Record<string, number>,
	flatRules: Record<string, RuleInput>,
	cashAccount = '現金',
	baseProfitAccount: string = '税前利益' // 指定があれば上書き
) {
	const ctx: CompileCtx = { reg: new NodeRegistry(), prev, rules: flatRules, roots: {}, visiting: new Set() };
	for (const acct of Object.keys(flatRules)) buildAccountNode(ctx, acct);

	// 現金 = 現金(prev) + 基点利益（デフォルト：税前利益）
	if (ctx.roots[baseProfitAccount] != null && prev[cashAccount] != null) {
		const cashPrev = makeFF(ctx.reg, prev[cashAccount], `${cashAccount}(prev)`);
		const cashRoot = makeTT(ctx.reg, cashPrev, ctx.roots[baseProfitAccount], 'ADD', `${cashAccount}=prev+${baseProfitAccount}`);
		ctx.roots[cashAccount] = cashRoot;
	}

	return ctx;
}

export function evalNodeRecursive(id: NodeId, reg: NodeRegistry, memo = new Map<NodeId, number>()): number {
	if (memo.has(id)) return memo.get(id)!;
	const n = reg.get(id);
	if (typeof n.value === 'number') { memo.set(id, n.value); return n.value; }
	if (!n.ref1 || !n.ref2 || !n.operator) throw new Error(`Invalid TT node: ${id}`);
	const a = evalNodeRecursive(n.ref1, reg, memo);
	const b = evalNodeRecursive(n.ref2, reg, memo);
	const v =
		n.operator === 'ADD' ? a + b :
			n.operator === 'SUB' ? a - b :
				n.operator === 'MUL' ? a * b : (() => { throw new Error(`Unknown op: ${n.operator}`); })();
	memo.set(id, v);
	return v;
}

function collectSubgraph(reg: NodeRegistry, roots: NodeId[]): Set<NodeId> {
	const seen = new Set<NodeId>();
	const visit = (id: NodeId) => {
		if (seen.has(id)) return;
		seen.add(id);
		const n = reg.get(id);
		if (n.ref1) visit(n.ref1);
		if (n.ref2) visit(n.ref2);
	};
	for (const r of roots) visit(r);
	return seen;
}

export function topoOrder(reg: NodeRegistry, roots: NodeId[]): NodeId[] {
	const nodes = Array.from(collectSubgraph(reg, roots));
	const indeg = new Map<NodeId, number>(nodes.map(id => [id, 0]));
	const out: Record<string, NodeId[]> = {};
	for (const id of nodes) out[id] = [];

	for (const id of nodes) {
		const n = reg.get(id);
		if (n.ref1) { indeg.set(id, (indeg.get(id) || 0) + 1); out[n.ref1].push(id); }
		if (n.ref2) { indeg.set(id, (indeg.get(id) || 0) + 1); out[n.ref2].push(id); }
	}

	const q: NodeId[] = [];
	for (const id of nodes) if ((indeg.get(id) || 0) === 0) q.push(id);

	const order: NodeId[] = [];
	while (q.length) {
		const u = q.shift()!; order.push(u);
		for (const v of out[u]) {
			indeg.set(v, (indeg.get(v) || 0) - 1);
			if ((indeg.get(v) || 0) === 0) q.push(v);
		}
	}
	if (order.length !== nodes.length) throw new Error('Cycle detected during topological sort');
	return order;
}

export function evalTopo(reg: NodeRegistry, roots: NodeId[]): Map<NodeId, number> {
	const order = topoOrder(reg, roots);
	const val = new Map<NodeId, number>();
	for (const id of order) {
		const n = reg.get(id);
		if (typeof n.value === 'number') val.set(id, n.value);
		else {
			const a = val.get(n.ref1!); const b = val.get(n.ref2!);
			if (a == null || b == null) throw new Error('Missing child value during topo eval');
			val.set(id,
				n.operator === 'ADD' ? a + b :
					n.operator === 'SUB' ? a - b :
						n.operator === 'MUL' ? a * b : NaN
			);
		}
	}
	return val;
}

export function validateAST(reg: NodeRegistry, roots: NodeId[]) {
	for (const n of reg.all()) {
		const isFF = typeof n.value === 'number';
		const isTT = n.ref1 != null && n.ref2 != null && n.operator != null;
		if (isFF === isTT) return { ok: false, reason: `Node ${n.id} must be either FF or TT` };
		if (isTT) { try { reg.get(n.ref1!); reg.get(n.ref2!); } catch { return { ok: false, reason: `Node ${n.id} references undefined child` }; } }
	}
	try { topoOrder(reg, roots); } catch { return { ok: false, reason: 'Cycle detected' }; }
	// NOTE: TT×TT子の禁則は今は警告のみ（TODO）
	return { ok: true as const };
}

export function toDOT(reg: NodeRegistry, roots?: NodeId[]) {
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
		if (n.ref1) out.push(`  "${n.id}" -> "${n.ref1}" [label="L:${n.operator}"];`);
		if (n.ref2) out.push(`  "${n.id}" -> "${n.ref2}" [label="R:${n.operator}"];`);
	}
	if (roots?.length) {
		const list = roots.map(r => `"${r}"`).join(', ');
		out.push(`  { rank=source; ${list} }`);
	}
	out.push('}');
	return out.join('\n');
}
