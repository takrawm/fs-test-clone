// src/fam/fam.ts
import { compileUnifiedAST, evalTopo } from '@/engine/ast.js';
import { cellId, periodKey } from '@/model/ids.js';
import type { Account, RuleInput } from '@/model/types.js';

type Grid = Map<string, number>; // accountName -> value

export interface ComputeOptions {
	years?: number;                 // 何年先まで（デフォルト 5）
	baseProfitAccount?: string;     // 現金連動の基点（デフォルト：税前利益）
	cashAccount?: string;           // 現金科目名（デフォルト：現金）
}

export class FAM {
	// 設計方針：
	// - 実績：PREVS（古→新）
	// - 予測：compute() で逐次年計算し、FAM上に書き戻す
	// - 依存：RULESの参照で解決（未定義はエラー）

	private fs: 'PL' = 'PL';                      // MVP: PLのみ
	private accounts: Record<string, Account> = {};
	private actualYears: Array<number> = [];      // 実績年リスト（例: [2021,2022,2023]）
	private rules: Record<string, RuleInput> = {};
	private table: Map<string, number> = new Map(); // key: cellId(fs, FY, accountId) -> value
	private orderAccounts: string[] = [];         // 表示順（account.id の順）

	importActuals(PREVS: Array<Record<string, number>>, accountsMaster?: Account[]) {
		if (!PREVS.length) throw new Error('PREVS is empty');

		// アカウント辞書（引数で与えられればそれを採用、なければ PREVS のキーから生成）
		const names = new Set<string>();
		for (const snap of PREVS) for (const k of Object.keys(snap)) names.add(k);

		if (accountsMaster) {
			for (const acc of accountsMaster) this.accounts[acc.id] = acc;
		} else {
			// AccountName = 科目名、idは "acc:<hash>" で安定化
			for (const name of names) {
				const id = `acc:${encodeURIComponent(name)}`; // 安定かつASCIIに寄せる
				this.accounts[id] = { id, AccountName: name, fs_type: 'PL' };
			}
		}

		// 表示順
		this.orderAccounts = Array.from(names);

		// 実績年は PREVS の添字基準で FY を採番（例：末尾が基点の最新年）
		const startYear = 2000; // MVP: 仮置き（TODO: ユーザー入力からFY決定）
		this.actualYears = PREVS.map((_, i) => startYear + i);

		// 実績を表に書き込み
		for (let i = 0; i < PREVS.length; i++) {
			const fy = this.actualYears[i];
			const snapshot = PREVS[i];
			for (const name of Object.keys(snapshot)) {
				const account = this.ensureAccount(name);
				if (!account) continue;
				const cid = cellId(this.fs, periodKey(fy), account.id);
				this.table.set(cid, snapshot[name]);
			}
		}
	}

	setRules(rules: Record<string, RuleInput>) {
		this.rules = { ...rules };
	}

	updateRule(accountName: string, rule: RuleInput) {
		const acc = this.findAccountByName(accountName);
		if (!acc) throw new Error(`Unknown account: ${accountName}`);
		this.rules[accountName] = rule;
		// TODO: ここで依存グラフから dirty セルを特定して増分再計算（MVPでは compute() で全期再計算）
	}

	compute(opts?: ComputeOptions) {
		const years = opts?.years ?? 5;
		const baseProfit = opts?.baseProfitAccount ?? '税前利益';
		const cash = opts?.cashAccount ?? '現金';
		if (!this.actualYears.length) throw new Error('No actual years imported');

		// 逐次年：最新実績 → Y+1 → Y+2 …
		let prev = this.snapshotLatestActual();

		for (let k = 1; k <= years; k++) {
			const fy = this.actualYears[this.actualYears.length - 1] + k;
			// RULES が未定義の科目が参照される場合はエラー
			// （コンパイル時に buildAccountNode が検出）

			const ctx = compileUnifiedAST(prev, this.rules, cash, baseProfit);

			// 評価 & FAMへ書き戻し（PL科目+現金）
			const roots = Object.keys(ctx.roots).map(name => ctx.roots[name]);
			const vals = evalTopo(ctx.reg, roots);

			// 科目名→値
			const name2val: Record<string, number> = {};
			for (const name of Object.keys(ctx.roots)) {
				name2val[name] = vals.get(ctx.roots[name])!;
			}

			// 表へ書き込み
			for (const name of Object.keys(name2val)) {
				const acc = this.ensureAccount(name);
				const cid = cellId(this.fs, periodKey(fy), acc.id);
				this.table.set(cid, name2val[name]);
			}

			// 次年の prev を更新（現金/PL など必要科目を寄せる）
			prev = name2val;
		}
	}

	getTable(params: { fs?: 'PL'; years?: Array<number> }) {
		const fs = params.fs ?? 'PL';
		const colYears = params.years ?? this.allYears();
		const columns = colYears.map(y => periodKey(y));

		// ★ 指定年に存在するすべてのアカウント名を orderAccounts にマージ
		for (const y of colYears) {
			const pk = periodKey(y);
			for (const [cid, _v] of this.table.entries()) {
				// cid = cell:<hash> なので accountId を直接は取れないため、
				// この簡易実装では "accounts に載っている全科目を候補" とし、
				// 値があるものはそのまま表示され、無いものは 0 として表示
				// → 追加で取りこぼしを防ぐため ensureAccount を compute 側で呼んでいる
				// （= ここでは orderAccounts の拡張は不要にできるが、安全のため下で再確認）
			}
		}

		// rows は orderAccounts の順序で構築（ensureAccount により派生科目も入っている想定）
		const rows = this.orderAccounts.map(name => {
			const acc = this.findAccountByName(name)!;
			return { accountId: acc.id, name, parentId: acc.parent_id ?? null };
		});

		const data: number[][] = rows.map(r => {
			return colYears.map(y => {
				const cid = cellId(fs, periodKey(y), r.accountId);
				const v = this.table.get(cid);
				return v != null ? Math.round(v) : 0; // 単位：1円、丸め：四捨五入
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
		// 実績 + 予測（表に存在する最大FYまで）
		const years = new Set<number>(this.actualYears);
		for (const key of this.table.keys()) {
			const m = key.match(/^cell:[0-9a-f]+$/);
			if (!m) continue;
			// periodKeyは columns 生成時に使うので、ここでは実績年の拡張は snapshot ベースで十分
		}
		// 実績末年から推定（テーブル走査は簡略化）
		const maxFY = Math.max(...this.actualYears, ...this.estimateForecastYearsFromTable());
		const minFY = Math.min(...this.actualYears);
		const out: number[] = [];
		for (let y = minFY; y <= maxFY; y++) out.push(y);
		return out;
	}

	private estimateForecastYearsFromTable(): number[] {
		// 実装簡略：実績末年+最大5年分を見込む（compute の years と一致が理想）
		if (!this.actualYears.length) return [];
		const last = this.actualYears[this.actualYears.length - 1];
		return [last + 1, last + 2, last + 3, last + 4, last + 5];
	}

	private findAccountByName(name: string): Account | undefined {
		// AccountName一致で検索（MVP）
		for (const id of Object.keys(this.accounts)) {
			const a = this.accounts[id];
			if (a.AccountName === name) return a;
		}
		return undefined;
	}

	private ensureAccount(name: string): Account {
		// AccountName 一致で検索して、なければ作成
		let acc = this.findAccountByName(name);
		if (!acc) {
			const id = `acc:${encodeURIComponent(name)}`; // 決定的でASCIIの安定ID
			acc = { id, AccountName: name, fs_type: 'PL' };
			this.accounts[id] = acc;
			if (!this.orderAccounts.includes(name)) this.orderAccounts.push(name);
		} else {
			// 既存でも orderAccounts に無ければ追加（安全側）
			if (!this.orderAccounts.includes(name)) this.orderAccounts.push(name);
		}
		return acc;
	}

}
