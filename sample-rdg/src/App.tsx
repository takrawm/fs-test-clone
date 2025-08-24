import React from "react";
import { Column, DataGrid, RenderCellProps, textEditor } from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { createPortal } from "react-dom";

type Row = { id: string } & Record<string, string>; // 各セルは「生値(raw)」の文字列
type Op = "+" | "-" | "*" | "/";
type Term = { op: Op; ref: string };
type CellFormula = { terms: Term[] };
type CellData = { note?: string; tags?: string[]; formula?: CellFormula };
type CellDataMap = Record<string, CellData | undefined>;

const COLS = 6; // A..F
const ROWS = 20;

const colIdxToName = (i: number) => String.fromCharCode("A".charCodeAt(0) + i);
const colNameToIdx = (name: string) =>
  name.toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
const makeCellId = (colKey: string, rowIndex: number | string) => {
  const n = typeof rowIndex === "string" ? Number(rowIndex) : rowIndex;
  return `${colKey}${n + 1}`;
};
const parseAddress = (addr: string) => {
  const m = addr.match(/^([A-Z])([1-9]\d{0,2})$/i);
  if (!m) return null;
  return { col: m[1].toUpperCase(), row: parseInt(m[2], 10) };
};

// セル値の取得（数値化）
function getNumericValue(rows: Row[], addr: string): number {
  const p = parseAddress(addr);
  if (!p) return NaN;
  const r = rows[p.row - 1];
  if (!r) return NaN;
  const raw = r[p.col];
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

// 複数演算を順次適用
function computeComposite(
  baseRaw: string,
  formula: CellFormula | undefined,
  rows: Row[]
): number | null {
  if (!formula || formula.terms.length === 0) return null;
  let acc = Number(baseRaw);
  if (!Number.isFinite(acc)) return null;

  for (const { op, ref } of formula.terms) {
    const v = getNumericValue(rows, ref);
    if (!Number.isFinite(v)) return null;
    switch (op) {
      case "+":
        acc += v;
        break;
      case "-":
        acc -= v;
        break;
      case "*":
        acc *= v;
        break;
      case "/":
        if (v === 0) return NaN;
        acc /= v;
        break;
    }
  }
  return acc;
}

// --- ポップオーバー ---
function CellPopover(props: {
  anchorRect: DOMRect;
  initial?: CellData;
  availableCells: string[];
  onSubmit: (data: CellData) => void;
  onClose: () => void;
}) {
  const { anchorRect, initial, availableCells, onSubmit, onClose } = props;

  const [note, setNote] = React.useState(initial?.note ?? "");
  const [tags, setTags] = React.useState((initial?.tags ?? []).join(", "));
  const [terms, setTerms] = React.useState<Term[]>(
    initial?.formula?.terms?.length
      ? initial.formula.terms
      : [{ op: "+", ref: "" }]
  );
  const [err, setErr] = React.useState("");

  const style: React.CSSProperties = {
    position: "fixed",
    top: anchorRect.bottom + 6,
    left: Math.min(anchorRect.left, window.innerWidth - 380),
    width: 360,
    zIndex: 1000,
    background: "#fff",
    border: "1px solid #ddd",
    borderRadius: 10,
    boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
    padding: 12,
  };

  const refDiv = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!refDiv.current) return;
      if (!refDiv.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const setTerm = (i: number, patch: Partial<Term>) =>
    setTerms((prev) =>
      prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t))
    );

  const addTerm = () => setTerms((prev) => [...prev, { op: "+", ref: "" }]);
  const removeTerm = (i: number) =>
    setTerms((prev) => prev.filter((_, idx) => idx !== i));

  const validateAndSubmit = () => {
    for (const { ref } of terms) {
      if (!ref) continue;
      const p = parseAddress(ref);
      if (!p) return setErr("参照セルが不正です（例: A3）");
      if (colNameToIdx(p.col) >= COLS || p.row < 1 || p.row > ROWS)
        return setErr(
          `参照セルが範囲外です（A1〜${colIdxToName(COLS - 1)}${ROWS}）`
        );
    }
    const normalized: Term[] = terms
      .filter((t) => t.ref.trim())
      .map((t) => ({ op: t.op, ref: t.ref.toUpperCase().trim() }));

    setErr("");
    onSubmit({
      note: note.trim() || undefined,
      tags: tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      formula: normalized.length ? { terms: normalized } : undefined,
    });
  };

  return createPortal(
    <div ref={refDiv} style={style} role="dialog" aria-modal="true">
      <div style={{ fontWeight: 700, marginBottom: 8 }}>セル設定</div>

      {/* 複数演算行 */}
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>演算（上から順に適用）</div>
        {terms.map((t, i) => (
          <div
            key={i}
            style={{ display: "flex", gap: 8, alignItems: "center" }}
          >
            <select
              value={t.op}
              onChange={(e) => setTerm(i, { op: e.target.value as Op })}
            >
              <option value="+">＋</option>
              <option value="-">－</option>
              <option value="*">×</option>
              <option value="/">÷</option>
            </select>

            <select
              value={
                availableCells.includes(t.ref.toUpperCase())
                  ? t.ref.toUpperCase()
                  : ""
              }
              onChange={(e) => setTerm(i, { ref: e.target.value })}
            >
              <option value="">（選択）</option>
              {availableCells.map((cid) => (
                <option key={cid} value={cid}>
                  {cid}
                </option>
              ))}
            </select>

            <input
              style={{ width: 80 }}
              placeholder="例: A3"
              value={t.ref}
              onChange={(e) => setTerm(i, { ref: e.target.value })}
            />

            <button onClick={() => removeTerm(i)}>✕</button>
          </div>
        ))}

        <div>
          <button onClick={addTerm}>＋ 行を追加</button>
        </div>
      </div>

      {/* 任意フィールド */}
      <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span>メモ（任意）</span>
          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span>タグ（任意・カンマ区切り）</span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="urgent, client-x"
          />
        </label>
      </div>

      {err && (
        <div style={{ color: "#b00", fontSize: 12, marginTop: 6 }}>{err}</div>
      )}

      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          marginTop: 10,
        }}
      >
        <button onClick={onClose}>キャンセル</button>
        <button onClick={validateAndSubmit}>保存</button>
      </div>
    </div>,
    document.body
  );
}

// --- セル描画（右上ボタン + 計算表示） ---
function CellWithButton<RowT extends Row>(props: {
  cellProps: RenderCellProps<RowT>;
  cellData?: CellData;
  onOpen: (anchorRect: DOMRect) => void;
  rows: Row[];
}) {
  const { cellProps, cellData, onOpen, rows } = props;
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const key = cellProps.column.key as string;
  const raw = cellProps.row[key] ?? "";

  // 表示値の決定
  let display: React.ReactNode = raw;
  const result = computeComposite(String(raw), cellData?.formula, rows);
  if (result !== null) {
    display = Number.isFinite(result) ? (
      String(result)
    ) : (
      <span style={{ color: "#b00" }}>#ERR</span>
    );
  }

  return (
    <div ref={wrapperRef} style={{ position: "relative", height: "100%" }}>
      <div
        style={{
          paddingRight: 28,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={typeof display === "string" ? display : undefined}
      >
        {display}
      </div>

      {cellData?.formula && (
        <span
          title={cellData.formula.terms
            .map((t) => `${t.op} ${t.ref}`)
            .join(" ")}
          style={{
            position: "absolute",
            left: 6,
            bottom: 6,
            fontSize: 10,
            background: "#eef6ff",
            border: "1px solid #bcd8ff",
            padding: "1px 4px",
            borderRadius: 4,
          }}
        >
          {cellData.formula.terms.map((t, i) => (
            <span key={i}>
              {t.op} {t.ref}{" "}
            </span>
          ))}
        </span>
      )}

      <button
        aria-label="セル設定を開く"
        onClick={(e) => {
          e.stopPropagation();
          const rect = wrapperRef.current!.getBoundingClientRect();
          onOpen(rect);
        }}
        style={{
          position: "absolute",
          top: 4,
          right: 4,
          width: 22,
          height: 22,
          borderRadius: 6,
          border: "1px solid #ddd",
          background: "#fafafa",
          cursor: "pointer",
        }}
      >
        🧮
      </button>
    </div>
  );
}

export default function App() {
  const [rows, setRows] = React.useState<Row[]>(
    Array.from({ length: ROWS }, (_, r) => {
      const base: Row = { id: String(r) };
      for (let c = 0; c < COLS; c++) base[colIdxToName(c)] = "";
      return base;
    })
  );

  const [cellDataMap, setCellDataMap] = React.useState<CellDataMap>({});

  const [popoverState, setPopoverState] = React.useState<{
    open: boolean;
    anchorRect?: DOMRect;
    cellId?: string;
  }>({ open: false });

  const openPopover = React.useCallback((cellId: string, rect: DOMRect) => {
    setPopoverState({ open: true, anchorRect: rect, cellId });
  }, []);
  const closePopover = React.useCallback(() => {
    setPopoverState({ open: false, anchorRect: undefined, cellId: undefined });
  }, []);

  // 列定義
  const columns = React.useMemo<Column<Row>[]>(() => {
    const cols: Column<Row>[] = [
      {
        key: "row",
        name: "#",
        width: 46,
        frozen: true,
        renderCell: ({ row }) => Number(row.id) + 1,
      },
    ];
    for (let c = 0; c < COLS; c++) {
      const key = colIdxToName(c);
      cols.push({
        key,
        name: key,
        editable: true,
        renderEditCell: textEditor,
        width: 140,
        renderCell: (p) => {
          const cellId = makeCellId(key, p.row.id);
          return (
            <CellWithButton
              cellProps={p}
              rows={rows}
              cellData={cellDataMap[cellId]}
              onOpen={(rect) => openPopover(cellId, rect)}
            />
          );
        },
      });
    }
    return cols;
  }, [cellDataMap, openPopover, rows]);

  const onRowsChange = (newRows: Row[]) => setRows(newRows);

  const availableCells = React.useMemo(() => {
    const all: string[] = [];
    for (let r = 1; r <= ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        all.push(`${colIdxToName(c)}${r}`);
      }
    }
    return all;
  }, []);

  return (
    <div
      style={{
        height: 560,
        position: "relative",
        overflow: "hidden",
        contain: "layout size",
      }}
    >
      <DataGrid columns={columns} rows={rows} onRowsChange={onRowsChange} />

      {popoverState.open && popoverState.anchorRect && popoverState.cellId && (
        <CellPopover
          anchorRect={popoverState.anchorRect}
          initial={cellDataMap[popoverState.cellId]}
          availableCells={availableCells}
          onClose={closePopover}
          onSubmit={(data) => {
            const cellId = popoverState.cellId!;
            setCellDataMap((prev) => ({ ...prev, [cellId]: data }));
            closePopover();
          }}
        />
      )}
    </div>
  );
}
