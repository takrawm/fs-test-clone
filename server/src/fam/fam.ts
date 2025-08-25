// src/fam/fam.ts
import {
	ACC_NAME,
	evalTopo,
	isPrevPeriod, makeFF, makeTT,
	toDOT,
} from '@/engine/ast.js';
import { cellId, periodKey } from '@/model/ids.js';
import { NodeRegistry } from '@/model/registry.js';
import type { Account, Period, RuleInput } from '@/model/types.js';

type Grid = Map<string, number>; // accountName -> value

export interface ComputeOptions {
	years?: number;                 // 何年先まで（デフォルト 5）
	baseProfitAccount?: string;     // 現金連動の基点（デフォルト：税前利益）
	cashAccount?: string;           // 現金科目名（デフォルト：現金）
}

export class FAM {
	private fs: 'PL' = 'PL';                      // MVP: PLのみ
	private accounts: Record<string, Account> = {};
	private actualYears: Array<number> = [];      // 実績年リスト（例: [2021,2022,2023]）
	private rules: Record<string, RuleInput> = {};
	private table: Map<string, number> = new Map(); // key: cellId(fs, FY, accountId) -> value
	private orderAccounts: string[] = [];         // 表示順（AccountName）
	// === AST（常駐） ===
	private reg: NodeRegistry = new NodeRegistry();
	private cellRoots = new Map<string, string>();  // key = `${fy}::${name}` -> NodeId
	private visiting = new Set<string>();           // build時の循環検出

	vizAST() {
		console.log(toDOT(this.reg));
	}

	// ---- Public API ----
	importActuals(PREVS: Array<Record<string, number>>, accountsMaster?: Account[]) {
		if (!PREVS.length) throw new Error('PREVS is empty');

		// アカウント辞書準備
		const names = new Set<string>();
		for (const snap of PREVS) for (const k of Object.keys(snap)) names.add(k);

		if (accountsMaster) {
			for (const acc of accountsMaster) this.accounts[acc.id] = acc;
		} else {
			for (const name of names) {
				const id = `acc:${encodeURIComponent(name)}`;
				this.accounts[id] = { id, AccountName: name, fs_type: 'PL' };
			}
		}
		this.orderAccounts = Array.from(names);

		// FY 仮採番（必要なら後で外部入力に差し替え）
		const startYear = 2000;
		this.actualYears = PREVS.map((_, i) => startYear + i);

		// 実績を表 & AST(FF Cell) へ
		for (let i = 0; i < PREVS.length; i++) {
			const fy = this.actualYears[i];
			const snapshot = PREVS[i];
			for (const name of Object.keys(snapshot)) {
				const acc = this.ensureAccount(name);
				const cid = cellId(this.fs, periodKey(fy), acc.id);
				const v = snapshot[name];
				this.table.set(cid, v);

				// AST: 各実績セルを FF として固定
				const p: Period = { Period_type: 'Yearly', AF_type: 'Actual', Period_val: fy, offset: 0 };
				const nodeId = makeFF(this.reg, v, `${name}(FY${fy})[Actual]`, { account: acc, period: p });
				this.setCellRoot(fy, name, nodeId);
			}
		}
	}

	setRules(rules: Record<string, RuleInput>) {
		this.rules = { ...rules };
	}

	updateRule(accountName: string, rule: RuleInput) {
		const acc = this.ensureAccount(accountName);
		this.rules[accountName] = rule;
		// TODO: 将来的に依存グラフで dirty セルだけ再計算
	}

	compute(opts?: ComputeOptions) {
		const years = opts?.years ?? 5;
		const baseProfit = opts?.baseProfitAccount ?? '税前利益';
		const cash = opts?.cashAccount ?? '現金';
		if (!this.actualYears.length) throw new Error('No actual years imported');

		const latestFY = this.actualYears[this.actualYears.length - 1];

		for (let k = 1; k <= years; k++) {
			const fy = latestFY + k;

			// ✅ 新: RULES 定義科目のみを先に ensureCell
			const targets = new Set<string>([...Object.keys(this.rules)]);
			for (const name of targets) this.ensureCell(fy, name);

			// ✅ 現金は attachCash で合成（FY-1 の現金 + 当期の基点）
			this.attachCash(fy, baseProfit, cash);

			// 評価ルートは RULES 科目 + 現金
			const roots: string[] = [];
			for (const name of [...targets, cash]) {
				const id = this.getCellRoot(fy, name);
				if (id) roots.push(id);
			}
			const vals = evalTopo(this.reg, roots);

			// 表へ書戻し（RULES 科目 + 現金）
			for (const name of [...targets, cash]) {
				const acc = this.ensureAccount(name);
				const cid = cellId(this.fs, periodKey(fy), acc.id);
				const id = this.getCellRoot(fy, name);
				if (id) {
					const v = vals.get(id);
					if (v != null) this.table.set(cid, v);
				}
			}
		}
	}


	getTable(params: { fs?: 'PL'; years?: Array<number> }) {
		const fs = params.fs ?? 'PL';
		const colYears = params.years ?? this.allYears();
		const columns = colYears.map(y => periodKey(y));

		const rows = this.orderAccounts.map(name => {
			const acc = this.findAccountByName(name)!;
			return { accountId: acc.id, name, parentId: acc.parent_id ?? null };
		});

		const data: number[][] = rows.map(r => {
			return colYears.map(y => {
				const cid = cellId(fs, periodKey(y), r.accountId);
				const v = this.table.get(cid);
				return v != null ? Math.round(v) : 0;
			});
		});

		return { rows, columns, data };
	}

	snapshotLatestActual(): Record<string, number> {
		const latestYear = this.actualYears[this.actualYears.length - 1];
		const result: Record<string, number> = {};
		for (const name of this.orderAccounts) {
			const acc = this.findAccountByName(name);
			if (!acc) continue;
			const cid = cellId(this.fs, periodKey(latestYear), acc.id);
			const v = this.table.get(cid);
			if (v != null) result[name] = v;
		}
		return result;
	}

	allYears(): number[] {
		const last = this.actualYears[this.actualYears.length - 1] ?? 2000;
		// 実績末期 + 5年を表示範囲とする簡易実装（compute の years と一致が理想）
		const maxFY = Math.max(...this.actualYears, last + 5);
		const minFY = Math.min(...this.actualYears);
		const out: number[] = [];
		for (let y = minFY; y <= maxFY; y++) out.push(y);
		return out;
	}

	// ---- AST 常駐ビルド（FY×科目の Cell を再利用/追加） ----
	private ensureCell(fy: number, name: string): string {
		const key = this.key(fy, name);
		const existing = this.cellRoots.get(key);
		if (existing) return existing;
		if (this.visiting.has(key)) throw new Error(`Cycle while building: ${name} FY${fy}`);
		this.visiting.add(key);

		// 実績FYなら importActuals 時点で確保済
		if (this.actualYears.includes(fy)) {
			const id = this.getCellRoot(fy, name);
			if (!id) throw new Error(`Actual cell missing: ${name} FY${fy}`);
			this.visiting.delete(key);
			return id;
		}

		// 予測FY：RULES必須（現金は attachCash で別途合成）
		if (!this.rules[name]) {
			this.visiting.delete(key);
			// 現金はここで素通り（attachCashで作るため）。他はエラー停止のポリシー。
			if (name !== '現金') throw new Error(`No rule for ${name} (FY${fy})`);
			return this.ensureCashShellIfAny(fy) ?? ((): never => { throw new Error(`cash shell missing FY${fy}`); })();
		}

		const rule = this.rules[name];
		const acc = this.ensureAccount(name);
		const p: Period = { Period_type: 'Yearly', AF_type: 'Forecast', Period_val: fy, offset: 0 };

		let id: string;

		switch (rule.type) {
			case 'INPUT':
				id = makeFF(this.reg, rule.value, `${name}(FY${fy})[Input]`, { account: acc, period: p });
				break;

			case 'FIXED_VALUE':
				id = makeFF(this.reg, rule.value, `${name}(FY${fy})[Fixed]`, { account: acc, period: p });
				break;

			case 'REFERENCE': {
				const r = rule.ref;
				const refName = ACC_NAME(r.account);
				const fyRef = isPrevPeriod(r.period) ? fy - 1 : fy;
				const base = this.ensureCell(fyRef, refName);
				// 参照のみなら Cell 自体をこの base に同一化しても良いが、FY の識別を保ちたいので 1×1 乗算でラップしても良い。
				id = base;
				break;
			}

			case 'GROWTH_RATE': {
				const r = rule.refs[0];
				const refName = ACC_NAME(r.account);
				const fyRef = isPrevPeriod(r.period) ? fy - 1 : fy;
				const base = this.ensureCell(fyRef, refName);
				const factor = makeFF(this.reg, 1 + rule.value, `1+growth(${rule.value})`);
				id = makeTT(this.reg, base, factor, 'MUL', `${name}=ref*factor(FY${fy})`, { account: acc, period: p });
				break;
			}

			case 'PERCENTAGE': {
				const refName = ACC_NAME(rule.ref.account);
				const fyRef = isPrevPeriod(rule.ref.period) ? fy - 1 : fy;
				const ref = this.ensureCell(fyRef, refName);
				const rate = makeFF(this.reg, rule.value, `pct(${rule.value})`);
				id = makeTT(this.reg, ref, rate, 'MUL', `${name}=ref*pct(FY${fy})`, { account: acc, period: p });
				break;
			}

			case 'PROPORTIONATE': {
				// TODO: 正式な除算ノード導入までは ratio を placeholder=1 で近似
				const baseRef = rule.base ?? {
					account: { id: `acc:${name}`, AccountName: name },
					period: { Period_type: 'Yearly', AF_type: 'Actual', Period_val: fy - 1, offset: -1 },
				};
				const bName = ACC_NAME(baseRef.account);
				const bNode = this.ensureCell(isPrevPeriod(baseRef.period) ? fy - 1 : fy, bName);
				let node = makeTT(this.reg, bNode, makeFF(this.reg, 1, 'ratio~placeholder'), 'MUL', `${name}=base*ratio(FY${fy})`, { account: acc, period: p });
				if (rule.coeff != null) {
					const c = makeFF(this.reg, rule.coeff, `coeff(${rule.coeff})`);
					node = makeTT(this.reg, node, c, 'MUL', `${name}*coeff(FY${fy})`, { account: acc, period: p });
				}
				id = node;
				break;
			}

			case 'CHILDREN_SUM': {
				// MVP: 0（将来: 勘定ツリーで子を集計）
				id = makeFF(this.reg, 0, `${name}(FY${fy})[children_sum=0]`, { account: acc, period: p });
				break;
			}

			case 'CALCULATION': {
				const terms: string[] = [];
				for (const ref of rule.refs) {
					const s = ref.sign ?? 1;
					const refName = ACC_NAME(ref.account);
					const fyRef = isPrevPeriod(ref.period) ? fy - 1 : fy;
					let base = this.ensureCell(fyRef, refName);
					if (s === -1) {
						base = makeTT(this.reg, base, makeFF(this.reg, -1, '-1'), 'MUL', `${refName}*(-1)(FY${fy})`);
					}
					terms.push(base);
				}
				if (terms.length === 0) {
					id = makeFF(this.reg, 0, `${name}(FY${fy})[0]`, { account: acc, period: p });
				} else if (terms.length === 1) {
					id = terms[0];
				} else {
					let accNode = makeTT(this.reg, terms[0], terms[1], 'ADD', `${name}:acc(FY${fy})`, { account: acc, period: p });
					for (let i = 2; i < terms.length; i++) {
						accNode = makeTT(this.reg, accNode, terms[i], 'ADD', `${name}:acc(FY${fy})`, { account: acc, period: p });
					}
					id = accNode;
				}
				break;
			}

			default: {
				const _exhaustive: never = rule;
				throw new Error(`Unsupported rule type: ${(rule as any).type}`);
			}
		}

		this.setCellRoot(fy, name, id);
		this.visiting.delete(key);
		return id;
	}

	// ＜現金連動＞ FY レイヤーに現金セルを合成
	private attachCash(fy: number, baseProfitAccount: string, cashName: string) {
		const leftPrev = this.getCellRoot(fy - 1, cashName) ?? this.ensureCell(fy - 1, cashName);
		const right = this.ensureCell(fy, baseProfitAccount);
		const acc = this.ensureAccount(cashName);
		const p: Period = { Period_type: 'Yearly', AF_type: 'Forecast', Period_val: fy, offset: 0 };
		const node = makeTT(this.reg, leftPrev, right, 'ADD', `${cashName}=prev+${baseProfitAccount}(FY${fy})`, { account: acc, period: p });
		this.setCellRoot(fy, cashName, node);
		// 表の行にも確実に出す
		if (!this.orderAccounts.includes(cashName)) this.orderAccounts.push(cashName);
	}

	// 現金の FY シェルが必要な場合の補助（通常は importActuals で FY-1 がある前提）
	private ensureCashShellIfAny(fy: number): string | undefined {
		const id = this.getCellRoot(fy, '現金');
		return id;
	}

	// ---- helpers ----
	private key(fy: number, name: string) { return `${fy}::${name}`; }
	private getCellRoot(fy: number, name: string) { return this.cellRoots.get(this.key(fy, name)); }
	private setCellRoot(fy: number, name: string, id: string) { this.cellRoots.set(this.key(fy, name), id); }

	private findAccountByName(name: string): Account | undefined {
		for (const id of Object.keys(this.accounts)) {
			const a = this.accounts[id];
			if (a.AccountName === name) return a;
		}
		return undefined;
	}
	private ensureAccount(name: string): Account {
		let acc = this.findAccountByName(name);
		if (!acc) {
			const id = `acc:${encodeURIComponent(name)}`;
			acc = { id, AccountName: name, fs_type: 'PL' };
			this.accounts[id] = acc;
		}
		if (!this.orderAccounts.includes(name)) this.orderAccounts.push(name);
		return acc;
	}
}
