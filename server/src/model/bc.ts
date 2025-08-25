// src/model/bc.ts（本ファイルは実装側であとから作る想定。テストでは型だけ import するか、テスト内で再定義しても可）
export type BCSign = 'PLUS' | 'MINUS';

/** CFI: Balance & Change Instruction (PoC)
 * - target:  対象のBS科目（例: 建物・機械等）
 * - isCredit: 対象BS科目の貸借性（PoCでは bool）
 * - driver?:  原因勘定（PL科目など、name指定でFAMからFY+1値を引く）
 * - value?:   非PLの固定フロー（設備投資など、直接数値指定）
 * - counter:  相手方勘定（例: 現金 or 利益剰余金）
 * - sign:     PLUS/MINUS（対象BS科目を増やすか減らすか）
 */
export interface CFI {
  target: string;
  isCredit: boolean | null;
  sign: BCSign;
  driver?: { name: string };     // 例: { name: '減価償却費' } → PLからFY+1の値を参照
  value?: number;                // 例: 200（設備投資）
  counter: string;               // 例: '現金' or '利益剰余金'
}
