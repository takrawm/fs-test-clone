// src/model/types.ts
export type Op = 'ADD' | 'SUB' | 'MUL';

export type PeriodType = 'Yearly' | 'Monthly' | null;
export type AFType = 'Actual' | 'Forecast' | null;
export type FsType = 'PL' | 'BS' | 'CF' | 'PPE' | 'OTHER' | null;

export interface Period {
	Period_type: PeriodType;        // MVP: Yearly
	AF_type: AFType;                // Actual / Forecast
	Period_val: string | number | null; // FY表記や数値年
	offset?: number | null;         // 実績基点からの相対参照（prev: -1）
}

export interface Account {
	id: string;                     // 安定ID（英数推奨）
	AccountName?: string | null;    // 表示名
	account?: string | null;        // PoC互換
	GlobalAccountID?: string | null;
	fs_type?: FsType;               // MVP: PL
	parent_id?: string | null;
	isCredit?: boolean | null;
	parameters?: unknown | null;
	FlowAccountCF?: string | null;
	DisplayOrder_id?: string | null;
}

export type ParamType =
	| 'INPUT' | 'CALCULATION' | 'CHILDREN_SUM' | 'FIXED_VALUE'
	| 'REFERENCE' | 'GROWTH_RATE' | 'PROPORTIONATE' | 'PERCENTAGE'
	| null;

export type NodeId = string;

export interface Node {
	id: NodeId;                     // ASTノードID（内部用：任意、外部露出しない）
	paramType?: ParamType;
	value?: number;                 // FF: valueあり, TT: undefined
	ref1?: NodeId | null;
	ref2?: NodeId | null;
	operator?: Op | null;
	kind?: 'FF' | 'TT';
	label?: string;                 // DOT/デバッグ用
}

export interface Cell extends Node {
	account?: Account | null;       // 表ビュー・依存解決のために保持
	period?: Period | null;
}

export interface RefInput {
	period: Period;
	account: Account;
	sign?: 1 | -1;
}

export type RuleInput =
	| { type: 'INPUT'; value: number }
	| { type: 'CALCULATION'; refs: RefInput[] }
	| { type: 'CHILDREN_SUM' }
	| { type: 'FIXED_VALUE'; value: number }
	| { type: 'REFERENCE'; ref: RefInput }
	| { type: 'GROWTH_RATE'; value: number; refs: [RefInput] }
	| {
		type: 'PROPORTIONATE';
		driverCurr: RefInput;
		driverPrev: RefInput;
		base?: RefInput;            // 省略時: 自科目 PREV
		coeff?: number;
	}
	| { type: 'PERCENTAGE'; value: number; ref: RefInput };
