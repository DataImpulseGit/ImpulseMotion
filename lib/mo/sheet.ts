/**
 * A table card worked like a spreadsheet: what the consultant (or Mo, on
 * request) did to it — a sort, filters, colour rules, cell colours, column
 * widths — kept on the card next to its rows, and applied when it is shown
 * or exported. The rows themselves stay as the tool wrote them (strings as
 * displayed: « 1 245,30 € »); a cell edit changes the row.
 *
 * Pure: no React, no database. Shared by the card (components/mo/sheet-table.tsx),
 * the act route (lib/mo/act.ts), Mo's tool (lib/mo/tools.ts) and the export
 * (lib/xlsx.ts).
 */

import { parseDisplayNumber } from "@/lib/sheet-values";

/** The colours of a sheet: a closed palette, so a card never carries arbitrary CSS. */
export const SHEET_COLORS = ["green", "red", "yellow", "orange", "blue", "purple", "gray"] as const;
export type SheetColor = (typeof SHEET_COLORS)[number];
/** Fill (soft, on the dark board) and text of each colour; `xlsx` = the same intent on a white sheet. */
export const SHEET_PALETTE: Record<SheetColor, { fill: string; text: string; xlsxFill: string; xlsxText: string; label: string }> = {
  green: { fill: "rgba(34,197,94,0.22)", text: "#4ade80", xlsxFill: "D9EAD3", xlsxText: "137333", label: "Vert" },
  red: { fill: "rgba(239,68,68,0.24)", text: "#f87171", xlsxFill: "F4CCCC", xlsxText: "A50E0E", label: "Rouge" },
  yellow: { fill: "rgba(234,179,8,0.24)", text: "#facc15", xlsxFill: "FFF2CC", xlsxText: "7F6000", label: "Jaune" },
  orange: { fill: "rgba(249,115,22,0.24)", text: "#fb923c", xlsxFill: "FCE5CD", xlsxText: "B45F06", label: "Orange" },
  blue: { fill: "rgba(59,130,246,0.24)", text: "#60a5fa", xlsxFill: "CFE2F3", xlsxText: "1155CC", label: "Bleu" },
  purple: { fill: "rgba(112,67,245,0.28)", text: "#a78bfa", xlsxFill: "D9D2E9", xlsxText: "674EA7", label: "Violet" },
  gray: { fill: "rgba(148,163,184,0.2)", text: "#94a3b8", xlsxFill: "EFEFEF", xlsxText: "666666", label: "Gris" },
};

export type SheetOp = "contains" | "not_contains" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "empty" | "not_empty";
export const SHEET_OPS: SheetOp[] = ["contains", "not_contains", "eq", "neq", "gt", "gte", "lt", "lte", "empty", "not_empty"];
export const SHEET_OP_LABELS: Record<SheetOp, string> = { contains: "contient", not_contains: "ne contient pas", eq: "est égal à", neq: "est différent de", gt: "supérieur à", gte: "supérieur ou égal à", lt: "inférieur à", lte: "inférieur ou égal à", empty: "est vide", not_empty: "n'est pas vide" };

/** A filter on one column: a condition, or a pick of values (« in »). */
export type SheetFilter = { col: number; op: SheetOp; value?: string } | { col: number; op: "in"; values: string[] };
/** A colour rule: cells of `col` meeting the condition take the colour (the whole row with scope « row »); « scale » shades the column from low to high. */
export type SheetRule =
  | { col: number; op: SheetOp; value?: string; color: SheetColor; scope?: "cell" | "row" }
  | { col: number; op: "scale"; /** High values are good (green) or bad (red). */ high: "good" | "bad" };
export interface SheetCellStyle { fill?: SheetColor; color?: SheetColor; bold?: boolean }

export interface MoSheetView {
  sort?: { col: number; dir: "asc" | "desc" };
  filters?: SheetFilter[];
  rules?: SheetRule[];
  /** Styles set by hand, by cell « r:c » (r = index of the row as stored, before sort and filters; « h » = the header). */
  cells?: Record<string, SheetCellStyle>;
  /** Column widths in pixels, by column index. */
  widths?: Array<number | null>;
}

const MAX_FILTERS = 12; const MAX_RULES = 16; const MAX_STYLED = 800; const MAX_VALUES = 60;
const isColor = (v: unknown): v is SheetColor => typeof v === "string" && (SHEET_COLORS as readonly string[]).includes(v);
const isOp = (v: unknown): v is SheetOp => typeof v === "string" && (SHEET_OPS as string[]).includes(v);
const colOk = (v: unknown, cols: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < cols;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/** What a card may keep of a sheet view (from the browser, the model or storage): anything else is dropped. Undefined when nothing is left. */
export function sanitizeSheetView(raw: unknown, cols: number, rows: number): MoSheetView | undefined {
  if (!raw || typeof raw !== "object" || cols <= 0) return undefined;
  const r = raw as Record<string, unknown>;
  const out: MoSheetView = {};
  const s = r.sort as Record<string, unknown> | undefined;
  if (s && typeof s === "object" && colOk(s.col, cols)) out.sort = { col: s.col, dir: s.dir === "desc" ? "desc" : "asc" };
  const filters: SheetFilter[] = [];
  for (const f of Array.isArray(r.filters) ? r.filters.slice(0, MAX_FILTERS) : []) {
    if (!f || typeof f !== "object") continue;
    const x = f as Record<string, unknown>;
    if (!colOk(x.col, cols)) continue;
    if (x.op === "in") {
      const values = (Array.isArray(x.values) ? x.values : []).slice(0, MAX_VALUES).map((v) => text(v, 160));
      filters.push({ col: x.col, op: "in", values });
    } else if (isOp(x.op)) {
      const value = text(x.value, 160);
      if (x.op === "empty" || x.op === "not_empty") filters.push({ col: x.col, op: x.op });
      else if (value) filters.push({ col: x.col, op: x.op, value });
    }
  }
  if (filters.length) out.filters = filters;
  const rules: SheetRule[] = [];
  for (const f of Array.isArray(r.rules) ? r.rules.slice(0, MAX_RULES) : []) {
    if (!f || typeof f !== "object") continue;
    const x = f as Record<string, unknown>;
    if (!colOk(x.col, cols)) continue;
    if (x.op === "scale") rules.push({ col: x.col, op: "scale", high: x.high === "bad" ? "bad" : "good" });
    else if (isOp(x.op) && isColor(x.color)) {
      const value = text(x.value, 160);
      if (!value && x.op !== "empty" && x.op !== "not_empty") continue;
      rules.push({ col: x.col, op: x.op, ...(value ? { value } : {}), color: x.color, ...(x.scope === "row" ? { scope: "row" as const } : {}) });
    }
  }
  if (rules.length) out.rules = rules;
  const cells: Record<string, SheetCellStyle> = {};
  let n = 0;
  for (const [key, v] of Object.entries(r.cells && typeof r.cells === "object" ? (r.cells as Record<string, unknown>) : {})) {
    if (n >= MAX_STYLED) break;
    const m = /^(h|\d{1,3}):(\d{1,2})$/.exec(key);
    if (!m || !v || typeof v !== "object") continue;
    if (Number(m[2]) >= cols || (m[1] !== "h" && Number(m[1]) >= rows)) continue;
    const x = v as Record<string, unknown>;
    const style: SheetCellStyle = { ...(isColor(x.fill) ? { fill: x.fill } : {}), ...(isColor(x.color) ? { color: x.color } : {}), ...(x.bold === true ? { bold: true } : {}) };
    if (Object.keys(style).length) { cells[key] = style; n++; }
  }
  if (n) out.cells = cells;
  if (Array.isArray(r.widths)) {
    const widths = r.widths.slice(0, cols).map((w) => (typeof w === "number" && Number.isFinite(w) ? Math.min(600, Math.max(48, Math.round(w))) : null));
    if (widths.some((w) => w !== null)) out.widths = widths;
  }
  return Object.keys(out).length ? out : undefined;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const numberOf = (s: string): number | null => parseDisplayNumber(s)?.value ?? null;

/** Does a cell meet a condition? Numbers compare as numbers when both sides read as numbers (« 1 245 € » > « 1000 »), text otherwise. */
export function cellMatches(cell: string, op: SheetOp, value = ""): boolean {
  const c = cell ?? "";
  if (op === "empty") return !c.trim() || c.trim() === "—";
  if (op === "not_empty") return !!c.trim() && c.trim() !== "—";
  if (op === "contains") return norm(c).includes(norm(value));
  if (op === "not_contains") return !norm(c).includes(norm(value));
  const a = numberOf(c); const b = numberOf(value);
  if (a !== null && b !== null) {
    switch (op) { case "eq": return a === b; case "neq": return a !== b; case "gt": return a > b; case "gte": return a >= b; case "lt": return a < b; case "lte": return a <= b; }
  }
  if (op === "eq") return norm(c) === norm(value);
  if (op === "neq") return norm(c) !== norm(value);
  // An order asked on something that is not a number: nothing matches.
  return false;
}

/** The rows to show: indexes of the stored rows that pass the filters, in the order of the sort. */
export function visibleRows(rows: string[][], view: MoSheetView | undefined): number[] {
  let idx = rows.map((_, i) => i);
  for (const f of view?.filters ?? []) {
    if (f.op === "in") { const keep = new Set(f.values.map(norm)); idx = idx.filter((i) => keep.has(norm(rows[i][f.col] ?? ""))); }
    else idx = idx.filter((i) => cellMatches(rows[i][f.col] ?? "", f.op, f.value));
  }
  const s = view?.sort;
  if (s) {
    const dir = s.dir === "desc" ? -1 : 1;
    const keyed = idx.map((i) => ({ i, raw: rows[i][s.col] ?? "", n: numberOf(rows[i][s.col] ?? "") }));
    keyed.sort((a, b) => {
      // Empty cells last, whatever the direction; numbers before text.
      const ae = !a.raw.trim() || a.raw.trim() === "—"; const be = !b.raw.trim() || b.raw.trim() === "—";
      if (ae !== be) return ae ? 1 : -1;
      if (a.n !== null && b.n !== null) return (a.n - b.n) * dir || a.i - b.i;
      if ((a.n !== null) !== (b.n !== null)) return a.n !== null ? -1 : 1;
      return norm(a.raw).localeCompare(norm(b.raw), "fr", { numeric: true }) * dir || a.i - b.i;
    });
    idx = keyed.map((k) => k.i);
  }
  return idx;
}

/** Distinct values of a column (as displayed), most frequent first — what the filter menu offers. */
export function columnValues(rows: string[][], col: number, max = MAX_VALUES): string[] {
  const count = new Map<string, number>();
  for (const r of rows) { const v = r[col] ?? ""; count.set(v, (count.get(v) ?? 0) + 1); }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fr", { numeric: true })).slice(0, max).map(([v]) => v);
}

export interface ResolvedStyle { fill?: SheetColor; color?: SheetColor; bold?: boolean; /** Shade of a colour scale: the colour and its strength (0–1). */ scale?: { color: "green" | "red"; strength: number } }

/**
 * The style of every cell: rules first (in order, the last one that matches wins), then what was set by hand.
 * → a function (stored row index, column) → style. Scales are computed over all the stored rows of the column.
 */
export function styleResolver(rows: string[][], view: MoSheetView | undefined): (row: number | "h", col: number) => ResolvedStyle {
  const rules = view?.rules ?? [];
  const cells = view?.cells ?? {};
  const ranges = new Map<number, { min: number; max: number }>();
  for (const r of rules) {
    if (r.op !== "scale" || ranges.has(r.col)) continue;
    const ns = rows.map((row) => numberOf(row[r.col] ?? "")).filter((n): n is number => n !== null);
    if (ns.length) ranges.set(r.col, { min: Math.min(...ns), max: Math.max(...ns) });
  }
  return (row, col) => {
    const out: ResolvedStyle = {};
    if (row !== "h") {
      for (const r of rules) {
        if (r.op === "scale") {
          if (r.col !== col) continue;
          const range = ranges.get(col); const n = numberOf(rows[row]?.[col] ?? "");
          if (!range || n === null || range.max === range.min) continue;
          const t = (n - range.min) / (range.max - range.min); // 0 = lowest, 1 = highest
          const good = r.high === "good" ? t : 1 - t;
          out.scale = good >= 0.5 ? { color: "green", strength: (good - 0.5) * 2 } : { color: "red", strength: (0.5 - good) * 2 };
          delete out.fill;
        } else if ((r.scope === "row" || r.col === col) && cellMatches(rows[row]?.[r.col] ?? "", r.op, r.value)) {
          out.fill = r.color; delete out.scale;
        }
      }
    }
    const own = cells[`${row}:${col}`];
    if (own) { if (own.fill) { out.fill = own.fill; delete out.scale; } if (own.color) out.color = own.color; if (own.bold) out.bold = true; }
    return out;
  };
}

/** What a hand edit of the sheet asks (browser → POST /api/mo/[id]/act { action: "table", … }). */
export interface SheetEdit {
  /** The whole view, replaced (sort, filters, rules, cell styles, widths). */
  view?: MoSheetView | null;
  /** Cell values changed: stored row index (or « h » for a column title), column, new text. */
  set?: Array<{ row: number | "h"; col: number; value: string }>;
  addRow?: boolean;
  addColumn?: string;
  /** Stored row indexes to delete. */
  deleteRows?: number[];
  deleteColumn?: number;
}

export const SHEET_MAX_ROWS = 200; export const SHEET_MAX_COLS = 16;

/** Applies an edit to a table (columns, rows, view) → the new table. Indexes out of range are ignored; cell styles follow deleted rows and columns. */
export function applySheetEdit(table: { columns: string[]; rows: string[][]; align?: Array<"left" | "right">; sheet?: MoSheetView }, edit: SheetEdit): { columns: string[]; rows: string[][]; align?: Array<"left" | "right">; sheet?: MoSheetView } {
  let columns = [...table.columns]; let rows = table.rows.map((r) => [...r]);
  let align = table.align ? [...table.align] : undefined;
  let view: unknown = edit.view === null ? undefined : edit.view ?? table.sheet;
  for (const s of (edit.set ?? []).slice(0, 400)) {
    if (!colOk(s.col, columns.length) || typeof s.value !== "string") continue;
    if (s.row === "h") { const v = s.value.trim().slice(0, 60); if (v) columns[s.col] = v; }
    else if (Number.isInteger(s.row) && s.row >= 0 && s.row < rows.length) rows[s.row][s.col] = s.value.trim().slice(0, 160);
  }
  if (edit.addRow && rows.length < SHEET_MAX_ROWS) rows.push(columns.map(() => ""));
  if (typeof edit.addColumn === "string" && columns.length < SHEET_MAX_COLS) {
    columns.push(edit.addColumn.trim().slice(0, 60) || `Colonne ${columns.length + 1}`);
    rows = rows.map((r) => [...r, ""]);
    if (align) align.push("left");
  }
  const reindexCells = (map: (row: number | "h", col: number) => [number | "h", number] | null) => {
    const v = view as MoSheetView | undefined;
    if (!v?.cells) return;
    const next: Record<string, SheetCellStyle> = {};
    for (const [key, style] of Object.entries(v.cells)) {
      const [r, c] = key.split(":");
      const to = map(r === "h" ? "h" : Number(r), Number(c));
      if (to) next[`${to[0]}:${to[1]}`] = style;
    }
    view = { ...v, cells: next };
  };
  const gone = [...new Set((edit.deleteRows ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < rows.length))].sort((a, b) => a - b);
  if (gone.length) {
    const set = new Set(gone);
    rows = rows.filter((_, i) => !set.has(i));
    reindexCells((r, c) => (r === "h" ? ["h", c] : set.has(r) ? null : [r - gone.filter((g) => g < r).length, c]));
  }
  if (colOk(edit.deleteColumn, columns.length) && columns.length > 1) {
    const d = edit.deleteColumn;
    columns = columns.filter((_, j) => j !== d); rows = rows.map((r) => r.filter((_, j) => j !== d));
    if (align) align = align.filter((_, j) => j !== d);
    reindexCells((r, c) => (c === d ? null : [r, c > d ? c - 1 : c]));
    const v = view as MoSheetView | undefined;
    if (v) {
      const shift = (c: number) => (c > d ? c - 1 : c);
      view = {
        ...v,
        sort: v.sort && v.sort.col !== d ? { ...v.sort, col: shift(v.sort.col) } : undefined,
        filters: v.filters?.filter((f) => f.col !== d).map((f) => ({ ...f, col: shift(f.col) })),
        rules: v.rules?.filter((f) => f.col !== d).map((f) => ({ ...f, col: shift(f.col) })),
        widths: v.widths?.filter((_, j) => j !== d),
      };
    }
  }
  const sheet = sanitizeSheetView(view, columns.length, rows.length);
  return { columns, rows, ...(align ? { align } : {}), ...(sheet ? { sheet } : {}) };
}

/** « A », « B », … « AA »: the letter of a column, as in a spreadsheet. */
export function columnLetter(index: number): string {
  let n = index + 1; let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** One line a person reads: what is applied to the sheet (« trié par Dépense ↓ · 2 filtres · 1 règle de couleur »). */
export function describeSheetView(columns: string[], view: MoSheetView | undefined): string {
  if (!view) return "";
  const parts: string[] = [];
  if (view.sort) parts.push(`trié par ${columns[view.sort.col] ?? "?"} ${view.sort.dir === "desc" ? "↓" : "↑"}`);
  if (view.filters?.length) parts.push(`${view.filters.length} filtre${view.filters.length > 1 ? "s" : ""}`);
  if (view.rules?.length) parts.push(`${view.rules.length} règle${view.rules.length > 1 ? "s" : ""} de couleur`);
  return parts.join(" · ");
}
