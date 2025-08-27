import { FAM } from '@/fam/fam.js';
import type { Account, Period, RuleInput } from '@/model/types.js';
// B&C型（実装がまだ無ければ、テスト内に同等型を宣言してもOK）
import type { CFI } from '@/model/bc.js';

const ACC = (id: string, name: string): Account => ({ id, AccountName: name, fs_type: 'PL' });

const A = {
	現金: ACC('CASH', '現金'),
	利益剰余金: ACC('RE', '利益剰余金'),
	建物機械等: ACC('PPE', '建物・機械等'),
	減価償却費: ACC('DEP', '減価償却費'),
	設備投資: ACC('CAPEX', '設備投資'),
	経常利益: ACC('OI', '経常利益'),
};

describe('Balance & Change (B&C) PoC', () => {
	test('減価償却：PPE 減少 / 利益剰余金 減少 / 現金はB&Cで影響なし', () => {
		const fam = new FAM();

		// 実績（古→新）
		const PREVS = [
			{ '現金': 100, '利益剰余金': 500, '建物・機械等': 1000, '減価償却費': 0, '設備投資': 0 },
			{ '現金': 100, '利益剰余金': 500, '建物・機械等': 1000, '減価償却費': 0, '設備投資': 0 },
		];
		fam.importActuals(PREVS, Object.values(A));

		// PLルール：減価償却費(FY+1)=100、経常利益(FY+1)=0（現金の基点利益影響を消すため）
		const RULES: Record<string, RuleInput> = {
			'減価償却費': { type: 'FIXED_VALUE', value: 100 },
			'経常利益': { type: 'FIXED_VALUE', value: 0 },
		};
		fam.setRules(RULES);

		// B&C定義：PPE を 減価償却費 により減じ、相手方は 利益剰余金
		const cfis: CFI[] = [{
			target: '建物・機械等',
			isCredit: false,
			sign: 'MINUS',
			driver: { name: '減価償却費' },
			counter: '利益剰余金',
		}];
		// まだ実装が無ければ setBalanceChange は未定義のはず（→テストFail狙い）
		// 実装後は fam.compute の中で B&C を適用する想定
		(fam as any).setBalanceChange?.(cfis);

		// 計算（1年先、基点利益=経常利益、現金連動ON）
		fam.compute({ years: 1, baseProfitAccount: '経常利益', cashAccount: '現金' });

		// FY推定：importActualsが2000,2001を割当 → 予測は 2002
		const y = 2002;
		const table = fam.getTable({ fs: 'PL', years: [y] });
		const col = table.columns.indexOf(`FY:${y}`);
		const row = (name: string) => table.rows.findIndex(r => r.name === name);
		const at = (name: string) => table.data[row(name)][col];

		// 期待：PPE=1000-100=900、RE=500-100=400、現金=100（B&Cでは現金不変、基点利益0のため現金合算も0）
		expect(at('建物・機械等')).toBe(900);
		expect(at('利益剰余金')).toBe(400);
		expect(at('現金')).toBe(100);
	});

	test('設備投資：PPE 増加 / 現金 減少（PL非経由）', () => {
		const fam = new FAM();

		const PREVS = [
			{ '現金': 100, '利益剰余金': 500, '建物・機械等': 1000, '減価償却費': 0, '設備投資': 0 },
			{ '現金': 100, '利益剰余金': 500, '建物・機械等': 1000, '減価償却費': 0, '設備投資': 0 },
		];
		fam.importActuals(PREVS, Object.values(A));

		const RULES: Record<string, RuleInput> = {
			'経常利益': { type: 'FIXED_VALUE', value: 0 }, // 現金の基点利益影響を消す
		};
		fam.setRules(RULES);

		// B&C定義：PPE を 設備投資(=200) で増加、相手方は 現金（キャッシュアウト）
		const cfis: CFI[] = [{
			target: '建物・機械等',
			isCredit: false,
			sign: 'PLUS',
			value: 200,
			counter: '現金',
		}];
		(fam as any).setBalanceChange?.(cfis);

		fam.compute({ years: 1, baseProfitAccount: '経常利益', cashAccount: '現金' });

		const y = 2002;
		const table = fam.getTable({ fs: 'PL', years: [y] });
		const col = table.columns.indexOf(`FY:${y}`);
		const row = (name: string) => table.rows.findIndex(r => r.name === name);
		const at = (name: string) => table.data[row(name)][col];

		// 期待：PPE=1000+200=1200、現金=100-200= -100（基点利益0）
		expect(at('建物・機械等')).toBe(1200);
		expect(at('現金')).toBe(-100);
		// 利益剰余金はこのB&Cでは変化しない
		expect(at('利益剰余金')).toBe(500);
	});
});
