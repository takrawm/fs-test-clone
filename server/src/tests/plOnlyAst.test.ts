// tests/plOnlyAstTopo.test.ts
import { compileUnifiedAST, evalNodeRecursive, evalTopo, toDOT, topoOrder, validateAST } from '@/engine/ast.js';
import { FAM } from '@/fam/fam.js';
import type { Account, Period, RuleInput } from '@/model/types.js';

// Period ヘルパ
const CURR: Period = { Period_type: 'Yearly', AF_type: 'Forecast', Period_val: null, offset: 0 };
const PREV_P: Period = { Period_type: 'Yearly', AF_type: 'Actual', Period_val: null, offset: -1 };

// Account ヘルパ（安定IDは英数で）
const ACC = (id: string, name: string): Account => ({ id, AccountName: name, fs_type: 'PL' });

const A = {
	現金: ACC('CASH', '現金'),
	売上: ACC('SALES', '売上'),
	売上原価: ACC('COGS', '売上原価'),
	販管費: ACC('SGA', '販管費'),
	営業外利益: ACC('NON_OP_INC', '営業外利益'),
	営業外費用: ACC('NON_OP_EXP', '営業外費用'),
	営業利益: ACC('OP_INCOME', '営業利益'),
	経常利益: ACC('ORDINARY_INCOME', '経常利益'),
};

// 実績（古→新）
const PREVS: Array<Record<string, number>> = [
	{ '現金': 30, '売上': 900, '売上原価': 540, '販管費': 90, '営業外利益': 8, '営業外費用': 4 },
	{ '現金': 40, '売上': 950, '売上原価': 570, '販管費': 95, '営業外利益': 9, '営業外費用': 4 },
	{ '現金': 50, '売上': 1000, '売上原価': 600, '販管費': 100, '営業外利益': 10, '営業外費用': 5 },
];

// 予測ルール（PLのみ）。現金は自動連動：現金=現金(prev)+基点利益（本テストでは基点=経常利益）
const RULES: Record<string, RuleInput> = {
	'経常利益': {
		type: 'CALCULATION',
		refs: [
			{ period: CURR, account: A.営業利益, sign: +1 },
			{ period: CURR, account: A.営業外利益, sign: +1 },
			{ period: CURR, account: A.営業外費用, sign: -1 },
		],
	},
	'売上': { type: 'GROWTH_RATE', value: 0.10, refs: [{ period: PREV_P, account: A.売上 }] },
	'売上原価': { type: 'GROWTH_RATE', value: 0.00, refs: [{ period: PREV_P, account: A.売上原価 }] },
	'販管費': { type: 'GROWTH_RATE', value: 0.00, refs: [{ period: PREV_P, account: A.販管費 }] },
	'営業外利益': { type: 'GROWTH_RATE', value: 0.00, refs: [{ period: PREV_P, account: A.営業外利益 }] },
	'営業外費用': { type: 'GROWTH_RATE', value: 0.00, refs: [{ period: PREV_P, account: A.営業外費用 }] },
	'営業利益': {
		type: 'CALCULATION',
		refs: [
			{ period: CURR, account: A.売上, sign: +1 },
			{ period: CURR, account: A.売上原価, sign: -1 },
			{ period: CURR, account: A.販管費, sign: -1 },
		],
	},
};

// 期待値：1年目・2年目
const EXPECTS = [
	{ SALES: 1100, COGS: 600, SGA: 100, NON_OP_INC: 10, NON_OP_EXP: 5, OP_INCOME: 400, ORDINARY_INCOME: 405, CASH_END: 455 },
	{ SALES: 1210, COGS: 600, SGA: 100, NON_OP_INC: 10, NON_OP_EXP: 5, OP_INCOME: 510, ORDINARY_INCOME: 515, CASH_END: 970 },
];

describe('FAM as global state → RULES→AST→計算→FAM書戻し→表ビュー', () => {
	const fam = new FAM();
	fam.importActuals(PREVS, Object.values(A));
	fam.setRules(RULES);

	// まず 1年目と2年目を逐次計算
	fam.compute({ years: 2, baseProfitAccount: '経常利益', cashAccount: '現金' });

	test('表ビュー抽出（最新実績FY+1, FY+2）', () => {
		const actualYears = [2000, 2001, 2002]; // importActuals の仮FY採番ロジック
		const y1 = actualYears[2] + 1;
		const y2 = actualYears[2] + 2;

		const table = fam.getTable({ fs: 'PL', years: [y1, y2] });
		const colIdx = (fy: number) => table.columns.indexOf(`FY:${fy}`);
		const rowIdxByName = (name: string) => table.rows.findIndex(r => r.name === name);

		// 1年目
		expect(table.data[rowIdxByName('売上')][colIdx(y1)]).toBe(EXPECTS[0].SALES);
		expect(table.data[rowIdxByName('売上原価')][colIdx(y1)]).toBe(EXPECTS[0].COGS);
		expect(table.data[rowIdxByName('販管費')][colIdx(y1)]).toBe(EXPECTS[0].SGA);
		expect(table.data[rowIdxByName('営業利益')][colIdx(y1)]).toBe(EXPECTS[0].OP_INCOME);
		expect(table.data[rowIdxByName('経常利益')][colIdx(y1)]).toBe(EXPECTS[0].ORDINARY_INCOME);
		expect(table.data[rowIdxByName('現金')][colIdx(y1)]).toBe(EXPECTS[0].CASH_END);

		// 2年目（1年目の結果をprevとして再適用）
		expect(table.data[rowIdxByName('売上')][colIdx(y2)]).toBe(EXPECTS[1].SALES);
		expect(table.data[rowIdxByName('売上原価')][colIdx(y2)]).toBe(EXPECTS[1].COGS);
		expect(table.data[rowIdxByName('販管費')][colIdx(y2)]).toBe(EXPECTS[1].SGA);
		expect(table.data[rowIdxByName('営業利益')][colIdx(y2)]).toBe(EXPECTS[1].OP_INCOME);
		expect(table.data[rowIdxByName('経常利益')][colIdx(y2)]).toBe(EXPECTS[1].ORDINARY_INCOME);
		expect(table.data[rowIdxByName('現金')][colIdx(y2)]).toBe(EXPECTS[1].CASH_END);

		// fam.vizAST()
		// console.log(fam.getTable({ fs: 'PL', years: [2001, 2002, 2003, 2004] }));
	});

	test('AST検証（1年目コンテキスト）', () => {
		// FAMの内部では年次ごとにASTを再構築しているため、ここではベース関数で直接確認
		const prev1 = {
			'現金': 50, '売上': 1000, '売上原価': 600, '販管費': 100, '営業外利益': 10, '営業外費用': 5,
		};
		const ctx = compileUnifiedAST(prev1, RULES, '現金', '経常利益');
		const roots = ['現金', '経常利益', '営業利益', '売上', '売上原価', '販管費', '営業外利益', '営業外費用']
			.filter(a => ctx.roots[a]).map(a => ctx.roots[a]);

		const res = validateAST(ctx.reg, roots);
		expect(res.ok).toBe(true);

		const order = topoOrder(ctx.reg, roots);
		const pos = new Map<string, number>(order.map((id, i) => [id, i]));
		for (const n of ctx.reg.all()) {
			if (n.ref1) expect(pos.get(n.ref1)!).toBeLessThan(pos.get(n.id)!);
			if (n.ref2) expect(pos.get(n.ref2)!).toBeLessThan(pos.get(n.id)!);
		}

		const topoVals = evalTopo(ctx.reg, roots);
		for (const name of Object.keys(ctx.roots)) {
			const root = ctx.roots[name];
			const vTopo = Math.round(topoVals.get(root)!);
			const vRec = Math.round(evalNodeRecursive(root, ctx.reg));
			expect(vTopo).toBe(vRec);
		}

		const dot = toDOT(ctx.reg, [ctx.roots['現金'], ctx.roots['経常利益']]);
		expect(dot).toContain('TT:営業利益');
		expect(dot).toContain('TT:経常利益');
	});
});
