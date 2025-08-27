// server/src/__tests__/errorCases.test.ts
import { FAM } from '@/fam/fam.js';
import type { Account, Period, RuleInput } from '@/model/types.js';
import type { CFI } from '@/model/bc.js';

// === ヘルパ ===
const ACC = (id: string, name: string): Account => ({ id, AccountName: name, fs_type: 'PL' });

const A = {
  現金: ACC('CASH', '現金'),
  売上: ACC('SALES', '売上'),
  売上原価: ACC('COGS', '売上原価'),
  販管費: ACC('SGA', '販管費'),
  営業利益: ACC('OP', '営業利益'),
  経常利益: ACC('OI', '経常利益'),
  架空科目: ACC('XXX', '架空科目'), // エラー検証用に実在/非実在の切替に使うことも
};

const CURR: Period   = { Period_type: 'Yearly', AF_type: 'Forecast', Period_val: null, offset: 0 };
const PREV_P: Period = { Period_type: 'Yearly', AF_type: 'Actual',   Period_val: null, offset: -1 };

const PREVS_OK: Array<Record<string, number>> = [
  { '現金': 10, '売上': 1000, '売上原価': 600, '販管費': 100, '営業利益': 300, '経常利益': 300 },
  { '現金': 20, '売上': 1100, '売上原価': 600, '販管費': 100, '営業利益': 400, '経常利益': 400 },
];

// B&C 実装の有無で test / test.skip を切り替えるヘルパ
const famForBC = () => new FAM();
const hasSetBC = (fam: FAM) => typeof (fam as any).setBalanceChange === 'function';
const bctest: jest.It = hasSetBC(new FAM()) ? test : test.skip;

describe('エラー処理: ルール定義/参照の妥当性', () => {
  test('未定義科目を参照すると throw', () => {
    const fam = new FAM();
    fam.importActuals(PREVS_OK, Object.values(A));

    // 「営業利益」が存在しない科目「存在しない」を参照
    const RULES: Record<string, RuleInput> = {
      '営業利益': {
        type: 'CALCULATION',
        refs: [{ period: CURR, account: { id:'NOPE', AccountName:'存在しない', fs_type:'PL' }, sign: +1 }],
      },
    };
    fam.setRules(RULES);

    expect(() =>
      fam.compute({ years: 1, baseProfitAccount: '経常利益', cashAccount: '現金' }),
    ).toThrow(/(未定義|not\s*found|存在しない)/i);
  });

  test('循環依存（A→B, B→A）で throw', () => {
    const fam = new FAM();
    fam.importActuals(PREVS_OK, Object.values(A));

    const RULES: Record<string, RuleInput> = {
      A: { type: 'CALCULATION', refs: [{ period: CURR, account: { id:'B', AccountName:'B', fs_type:'PL' }, sign: +1 }] },
      B: { type: 'CALCULATION', refs: [{ period: CURR, account: { id:'A', AccountName:'A', fs_type:'PL' }, sign: +1 }] },
    };
    fam.setRules(RULES);

    expect(() =>
      fam.compute({ years: 1, baseProfitAccount: '経常利益', cashAccount: '現金' }),
    ).toThrow(/(循環|circular|cycle)/i);
  });

  test('PREV参照だが実績が無い → throw', () => {
    const fam = new FAM();
    // 実績ゼロ件で PREV を参照
    fam.importActuals([], Object.values(A));

    const RULES: Record<string, RuleInput> = {
      '売上': { type: 'GROWTH_RATE', value: 0.1, refs: [{ period: PREV_P, account: A.売上 }] },
    };
    fam.setRules(RULES);

    expect(() =>
      fam.compute({ years: 1, baseProfitAccount: '経常利益', cashAccount: '現金' }),
    ).toThrow(/(前期|prev|previous|実績)/i);
  });

  test('係数が NaN → throw', () => {
    const fam = new FAM();
    fam.importActuals(PREVS_OK, Object.values(A));

    const RULES: Record<string, RuleInput> = {
      '売上': { type: 'GROWTH_RATE', value: Number.NaN as unknown as number, refs: [{ period: PREV_P, account: A.売上 }] },
    };
    fam.setRules(RULES);

    expect(() =>
      fam.compute({ years: 1, baseProfitAccount: '経常利益', cashAccount: '現金' }),
    ).toThrow(/(NaN|不正|invalid)/i);
  });

  test('必須パラメータ欠落（GROWTH_RATE に refs なし）→ throw', () => {
    const fam = new FAM();
    fam.importActuals(PREVS_OK, Object.values(A));

    const RULES = {
      '売上': { type: 'GROWTH_RATE', value: 0.1 } as unknown as RuleInput, // 故意に不完全
    };
    fam.setRules(RULES);

    expect(() =>
      fam.compute({ years: 1, baseProfitAccount: '経常利益', cashAccount: '現金' }),
    ).toThrow(/(必須|required|refs|base)/i);
  });
});

describe('エラー処理: 現金（特別科目）と compute オプション', () => {
  test('cashAccount 未指定 → throw', () => {
    const fam = new FAM();
    fam.importActuals(PREVS_OK, Object.values(A));
    fam.setRules({
      '経常利益': { type: 'FIXED_VALUE', value: 0 },
    });

    expect(() =>
      fam.compute({ years: 1, baseProfitAccount: '経常利益' } as any),
    ).toThrow(/(cash|現金|required|must)/i);
  });

  test('cashAccount 名称不整合 → throw（実装が "現金" を特扱する前提）', () => {
    const fam = new FAM();
    fam.importActuals(PREVS_OK, Object.values(A));
    fam.setRules({
      '経常利益': { type: 'FIXED_VALUE', value: 0 },
    });

    expect(() =>
      fam.compute({ years: 1, baseProfitAccount: '経常利益', cashAccount: 'キャッシュ' }),
    ).toThrow(/(現金|cash)/i);
  });
});

describe('エラー処理: Balance & Change（実装がある場合のみ実行）', () => {
  bctest('B&C: 不正ターゲット → throw', () => {
    const fam = famForBC();
    fam.importActuals(PREVS_OK, Object.values(A));
    fam.setRules({ '経常利益': { type: 'FIXED_VALUE', value: 0 } });

    const cfis: CFI[] = [{
      target: '存在しない科目', // 不正
      isCredit: false,
      sign: 'PLUS',
      value: 100,
      counter: '現金',
    }];

    (fam as any).setBalanceChange(cfis);

    expect(() =>
      fam.compute({ years: 1, baseProfitAccount: '経常利益', cashAccount: '現金' }),
    ).toThrow(/(対象|target|not\s*found|存在しない)/i);
  });

  bctest('B&C: driver/value の両方欠落 → throw', () => {
    const fam = famForBC();
    fam.importActuals(PREVS_OK, Object.values(A));
    fam.setRules({ '経常利益': { type: 'FIXED_VALUE', value: 0 } });

    const cfis: CFI[] = [{
      target: '売上',          // ターゲットは有効だが…
      isCredit: false,
      sign: 'MINUS',
      // value も driver も無い
      counter: '現金',
    } as any];

    (fam as any).setBalanceChange(cfis);

    expect(() =>
      fam.compute({ years: 1, baseProfitAccount: '経常利益', cashAccount: '現金' }),
    ).toThrow(/(driver|value|必須|required)/i);
  });

  bctest('B&C: sign が不正値 → throw', () => {
    const fam = famForBC();
    fam.importActuals(PREVS_OK, Object.values(A));
    fam.setRules({ '経常利益': { type: 'FIXED_VALUE', value: 0 } });

    const cfis: CFI[] = [{
      target: '売上',
      isCredit: false,
      sign: 'PLUS_MINUS' as any, // 不正
      value: 10,
      counter: '現金',
    }];

    (fam as any).setBalanceChange(cfis);

    expect(() =>
      fam.compute({ years: 1, baseProfitAccount: '経常利益', cashAccount: '現金' }),
    ).toThrow(/(sign|不正|invalid)/i);
  });
});
