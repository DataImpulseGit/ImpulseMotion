"use client";

/**
 * A table card shown and worked like a spreadsheet (lib/mo/sheet.ts): column
 * letters and row numbers, a grid, cells that select (click, shift, drag,
 * arrows), edit (double-click, Enter, or just type), copy (⌘C) — and, per
 * column, a sort, filters and a colour scale; on a selection, fill / text
 * colours and bold; colour rules (« ROAS > 3 → vert, toute la ligne »).
 *
 * Every change goes up as one `SheetEdit` (onEdit) and is kept on the card.
 * The keyboard lands in a hidden field, so the board's own shortcuts (Suppr,
 * G, X, S…) stay out of the way while the sheet is used. Menus open as a band
 * under the toolbar, never as a floating layer: the board is zoomed and
 * panned, a floating layer would be clipped by the card.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownAZ, ArrowUpAZ, Bold, ChevronDown, Eraser, Filter, PaintBucket, Palette, Plus, Rows3, Trash2, Type, X } from "lucide-react";
import type { MoCard } from "@/lib/mo/model";
import {
  SHEET_COLORS, SHEET_OP_LABELS, SHEET_OPS, SHEET_PALETTE, SHEET_MAX_COLS, SHEET_MAX_ROWS, columnLetter, columnValues, describeSheetView, styleResolver, visibleRows,
  type MoSheetView, type ResolvedStyle, type SheetCellStyle, type SheetColor, type SheetEdit, type SheetFilter, type SheetOp, type SheetRule,
} from "@/lib/mo/sheet";

type TableCard = Extract<MoCard, { type: "table" }>;
/** A cell of the grid as shown: display row (−1 = the header row) and column. */
interface Pos { r: number; c: number }
interface Sel { a: Pos; f: Pos }
type Band = null | { kind: "column"; col: number } | { kind: "rule" } | { kind: "fill" } | { kind: "color" };

const NUMERIC = /^[\s\d.,%€$+\-−–—kKM]+(\s?(€|%|\$|k|M))?$/;
const box = (s: Sel) => ({ r0: Math.min(s.a.r, s.f.r), r1: Math.max(s.a.r, s.f.r), c0: Math.min(s.a.c, s.f.c), c1: Math.max(s.a.c, s.f.c) });
const cssOf = (st: ResolvedStyle): React.CSSProperties => ({
  ...(st.fill ? { background: SHEET_PALETTE[st.fill].fill } : st.scale ? { background: st.scale.color === "green" ? `rgba(34,197,94,${(0.08 + st.scale.strength * 0.4).toFixed(3)})` : `rgba(239,68,68,${(0.08 + st.scale.strength * 0.4).toFixed(3)})` } : {}),
  ...(st.color ? { color: SHEET_PALETTE[st.color].text } : {}),
  ...(st.bold ? { fontWeight: 600 } : {}),
});

const btn = "inline-flex items-center gap-1 rounded-md border border-ui-line bg-ui-raised px-1.5 py-1 text-[11px] text-ui-fg2 hover:text-ui-fg hover:border-ui-line-strong disabled:opacity-40 disabled:pointer-events-none";
const field = "rounded-md border border-ui-line bg-ui-bg px-1.5 py-1 text-[11px] text-ui-fg outline-none focus:border-ui-accent";

export const SheetTable = memo(function SheetTable({ card, active, onEdit }: { card: TableCard; /** The card is selected: its toolbar shows. */ active: boolean; onEdit?: (edit: SheetEdit) => void }) {
  const { columns, rows } = card;
  const view = card.sheet;
  const order = useMemo(() => visibleRows(rows, view), [rows, view]);
  const styleOf = useMemo(() => styleResolver(rows, view), [rows, view]);
  const right = useMemo(() => columns.map((_, j) => card.align?.[j] === "right" || (j > 0 && rows.length > 0 && rows.every((r) => !r[j] || NUMERIC.test(r[j])))), [columns, rows, card.align]);

  const [sel, setSel] = useState<Sel | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const [band, setBand] = useState<Band>(null);
  const keysRef = useRef<HTMLTextAreaElement | null>(null);
  const editRef = useRef<HTMLInputElement | null>(null);
  const dragging = useRef(false);
  const canEdit = !!onEdit;

  const rowCount = order.length; const colCount = columns.length;
  const clamp = useCallback((p: Pos): Pos => ({ r: Math.min(rowCount - 1, Math.max(-1, p.r)), c: Math.min(colCount - 1, Math.max(0, p.c)) }), [rowCount, colCount]);
  /** Display row → what is stored: « h » for the header, the stored row index otherwise. */
  const stored = useCallback((r: number): number | "h" => (r < 0 ? "h" : order[r]), [order]);
  const textAt = useCallback((r: number, c: number) => (r < 0 ? columns[c] ?? "" : rows[order[r]]?.[c] ?? ""), [columns, rows, order]);

  const setView = useCallback((patch: Partial<MoSheetView>) => { onEdit?.({ view: { ...(view ?? {}), ...patch } }); }, [onEdit, view]);
  const focusKeys = () => keysRef.current?.focus({ preventScroll: true });

  // An edit opened on a cell: its field takes the keyboard. Opened by typing, the caret goes after what was typed;
  // opened by a double-click or Enter, the whole value is selected.
  const typedStart = useRef(false);
  useEffect(() => {
    const el = editRef.current;
    if (!editing || !el) return;
    el.focus();
    if (typedStart.current) el.setSelectionRange(el.value.length, el.value.length); else el.select();
  }, [editing?.r, editing?.c]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const up = () => { dragging.current = false; }; window.addEventListener("mouseup", up); return () => window.removeEventListener("mouseup", up); }, []);

  // The edit in progress is read from a ref when it is committed: the change goes up from the event, never from a render.
  const editingRef = useRef<{ r: number; c: number; value: string } | null>(null);
  const setEdit = useCallback((v: { r: number; c: number; value: string } | null) => { editingRef.current = v; setEditing(v); }, []);
  const commit = useCallback((move?: Pos) => {
    const e = editingRef.current;
    if (e) {
      setEdit(null);
      if (e.value !== textAt(e.r, e.c)) onEdit?.({ set: [{ row: stored(e.r), col: e.c, value: e.value }] });
    }
    if (move) { const p = clamp(move); setSel({ a: p, f: p }); }
    window.setTimeout(focusKeys, 0);
  }, [clamp, onEdit, setEdit, stored, textAt]);

  const startEdit = useCallback((p: Pos, initial?: string) => { if (!canEdit) return; typedStart.current = initial !== undefined; setEdit({ r: p.r, c: p.c, value: initial ?? textAt(p.r, p.c) }); }, [canEdit, setEdit, textAt]);

  /** Applies a style to the selection (or clears it): hand styles are kept by stored cell. */
  const styleSelection = useCallback((patch: Partial<SheetCellStyle> | null) => {
    if (!sel) return;
    const b = box(sel); const cells = { ...(view?.cells ?? {}) };
    for (let r = b.r0; r <= b.r1; r++) for (let c = b.c0; c <= b.c1; c++) {
      const key = `${stored(r)}:${c}`;
      if (patch === null) { delete cells[key]; continue; }
      const next: SheetCellStyle = { ...(cells[key] ?? {}), ...patch };
      for (const k of Object.keys(next) as Array<keyof SheetCellStyle>) if (next[k] === undefined || next[k] === false) delete next[k];
      if (Object.keys(next).length) cells[key] = next; else delete cells[key];
    }
    setView({ cells });
  }, [sel, setView, stored, view?.cells]);

  const copy = useCallback(() => {
    if (!sel) return;
    const b = box(sel);
    const lines: string[] = [];
    for (let r = b.r0; r <= b.r1; r++) lines.push(Array.from({ length: b.c1 - b.c0 + 1 }, (_, i) => textAt(r, b.c0 + i).replace(/[\t\n]/g, " ")).join("\t"));
    void navigator.clipboard?.writeText(lines.join("\n")).catch(() => undefined);
  }, [sel, textAt]);

  const onKeys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!sel) return;
    const mod = e.ctrlKey || e.metaKey;
    const move = (dr: number, dc: number) => { e.preventDefault(); const f = clamp({ r: sel.f.r + dr, c: sel.f.c + dc }); setSel(e.shiftKey ? { a: sel.a, f } : { a: f, f }); };
    switch (e.key) {
      case "ArrowUp": return move(-1, 0);
      case "ArrowDown": return move(1, 0);
      case "ArrowLeft": return move(0, -1);
      case "ArrowRight": return move(0, 1);
      case "Tab": return move(0, e.shiftKey ? -1 : 1);
      case "Enter": case "F2": e.preventDefault(); return startEdit(sel.a);
      case "Escape": e.preventDefault(); setSel(null); setBand(null); keysRef.current?.blur(); return;
      case "Delete": case "Backspace": {
        e.preventDefault();
        if (!canEdit) return;
        const b = box(sel); const set: NonNullable<SheetEdit["set"]> = [];
        for (let r = Math.max(0, b.r0); r <= b.r1; r++) for (let c = b.c0; c <= b.c1; c++) if (textAt(r, c)) set.push({ row: stored(r), col: c, value: "" });
        if (set.length) onEdit?.({ set });
        return;
      }
    }
    if (mod && e.key.toLowerCase() === "c") { e.preventDefault(); copy(); return; }
    if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); setSel({ a: { r: -1, c: 0 }, f: { r: rowCount - 1, c: colCount - 1 } }); return; }
    if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); const k = `${stored(sel.a.r)}:${sel.a.c}`; styleSelection({ bold: !(view?.cells?.[k]?.bold) }); return; }
  };
  /** A character typed on a selected cell starts the edit with it (the hidden field received it). */
  const onKeysInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const v = e.currentTarget.value; e.currentTarget.value = "";
    if (v && sel && canEdit) startEdit(sel.a, v.replace(/[\r\n]/g, ""));
  };

  const cellDown = (p: Pos, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // The click must not take the focus away from the hidden keyboard field (a cell is not focusable).
    e.preventDefault();
    if (editing) commit();
    // Second click of a double-click: the cell opens (read from the click count, which every browser gives).
    if (e.detail >= 2 && !e.shiftKey) { setSel({ a: p, f: p }); startEdit(p); return; }
    dragging.current = true;
    setSel((s) => (e.shiftKey && s ? { a: s.a, f: p } : { a: p, f: p }));
    focusKeys();
  };
  const cellEnter = (p: Pos) => { if (dragging.current) setSel((s) => (s ? { a: s.a, f: p } : s)); };

  // Column widths: dragged on the edge of a letter. The board is zoomed: screen pixels are brought back to the card's.
  const resize = (col: number, e: React.MouseEvent<HTMLSpanElement>) => {
    e.preventDefault(); e.stopPropagation();
    const th = e.currentTarget.parentElement as HTMLElement;
    const rect = th.getBoundingClientRect(); const k = rect.width / Math.max(1, th.offsetWidth);
    const startX = e.clientX; const startW = th.offsetWidth;
    const widths: Array<number | null> = Array.from({ length: colCount }, (_, j) => view?.widths?.[j] ?? null);
    let last = startW;
    const moveFn = (ev: MouseEvent) => { last = Math.min(600, Math.max(48, Math.round(startW + (ev.clientX - startX) / k))); th.style.width = `${last}px`; th.style.minWidth = `${last}px`; };
    const upFn = () => { window.removeEventListener("mousemove", moveFn); window.removeEventListener("mouseup", upFn); widths[col] = last; setView({ widths }); };
    window.addEventListener("mousemove", moveFn); window.addEventListener("mouseup", upFn);
  };

  const b = sel ? box(sel) : null;
  const inSel = (r: number, c: number) => !!b && r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1;
  const isActive = (r: number, c: number) => !!sel && sel.a.r === r && sel.a.c === c;
  const filterOn = (c: number) => !!view?.filters?.some((f) => f.col === c);
  const activeCol = sel ? sel.a.c : 0;
  const summary = describeSheetView(columns, view);
  const hasFormat = !!(view?.cells && Object.keys(view.cells).length) || !!view?.rules?.length;

  const renderCell = (r: number, c: number) => {
    const header = r < 0;
    const st = styleOf(stored(r), c);
    const selected = inSel(r, c); const act = isActive(r, c);
    const isEditing = editing && editing.r === r && editing.c === c;
    const Tag = header ? "th" : "td";
    return (
      <Tag key={c} onMouseDown={(e) => cellDown({ r, c }, e)} onMouseEnter={() => cellEnter({ r, c })}
        style={{ ...cssOf(st), ...(selected && !st.fill && !st.scale ? { background: "var(--ui-accent-soft)" } : {}), ...(act ? { outline: "2px solid var(--ui-accent)", outlineOffset: "-2px" } : {}) }}
        className={`relative border border-ui-line px-2 py-1 align-middle ${header ? "sticky top-[21px] z-[2] bg-ui-raised text-[11px] font-semibold text-ui-fg whitespace-nowrap" : `text-[12px] ${c === 0 ? "text-ui-fg" : "text-ui-fg2"}`} ${right[c] ? "text-right tabular-nums whitespace-nowrap" : "text-left"} ${selected && (st.fill || st.scale) ? "brightness-125" : ""} cursor-cell select-none`}>
        {isEditing ? (
          <input ref={editRef} value={editing.value} onChange={(e) => setEdit({ r, c, value: e.target.value })} onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); commit({ r: r + 1, c }); } else if (e.key === "Tab") { e.preventDefault(); commit({ r, c: c + (e.shiftKey ? -1 : 1) }); } else if (e.key === "Escape") { e.preventDefault(); setEdit(null); window.setTimeout(focusKeys, 0); } }}
            onBlur={() => commit()} className="absolute inset-0 w-full bg-ui-bg px-2 text-[12px] text-ui-fg outline-none ring-2 ring-ui-accent" />
        ) : header ? (
          <span className="flex items-center gap-1">
            <span className={`flex-1 truncate ${right[c] ? "text-right" : ""}`}>{columns[c]}{view?.sort?.col === c ? <span className="ml-1 text-ui-accent-ink">{view.sort.dir === "desc" ? "↓" : "↑"}</span> : null}</span>
            <button type="button" aria-label={`Trier et filtrer ${columns[c]}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setSel({ a: { r: -1, c }, f: { r: rowCount - 1, c } }); setBand((x) => (x?.kind === "column" && x.col === c ? null : { kind: "column", col: c })); }}
              className={`shrink-0 rounded p-0.5 hover:bg-ui-bg ${filterOn(c) ? "text-ui-accent-ink" : "text-ui-muted hover:text-ui-fg"}`}>{filterOn(c) ? <Filter className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}</button>
          </span>
        ) : (textAt(r, c) || " ")}
      </Tag>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      {active && canEdit && (
        <div className="flex flex-wrap items-center gap-1" onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== "INPUT" && (e.target as HTMLElement).tagName !== "SELECT") e.preventDefault(); }}>
          <button type="button" className={btn} disabled={!sel} title="Couleur de fond de la sélection" onClick={() => setBand((x) => (x?.kind === "fill" ? null : { kind: "fill" }))}><PaintBucket className="w-3.5 h-3.5" /> Fond</button>
          <button type="button" className={btn} disabled={!sel} title="Couleur du texte de la sélection" onClick={() => setBand((x) => (x?.kind === "color" ? null : { kind: "color" }))}><Type className="w-3.5 h-3.5" /> Texte</button>
          <button type="button" className={btn} disabled={!sel} title="Gras (⌘B)" onClick={() => { if (sel) styleSelection({ bold: !(view?.cells?.[`${stored(sel.a.r)}:${sel.a.c}`]?.bold) }); }}><Bold className="w-3.5 h-3.5" /></button>
          <button type="button" className={btn} title="Colorer selon une condition (« ROAS supérieur à 3 → vert »)" onClick={() => setBand((x) => (x?.kind === "rule" ? null : { kind: "rule" }))}><Palette className="w-3.5 h-3.5" /> Règle{view?.rules?.length ? ` (${view.rules.length})` : ""}</button>
          <button type="button" className={btn} disabled={!hasFormat && !view?.filters?.length && !view?.sort} title="Retire couleurs, règles, filtres et tri" onClick={() => { onEdit?.({ view: view?.widths ? { widths: view.widths } : null }); setBand(null); }}><Eraser className="w-3.5 h-3.5" /> Tout effacer</button>
          <span className="mx-0.5 h-4 w-px bg-ui-line" />
          <button type="button" className={btn} disabled={rows.length >= SHEET_MAX_ROWS} title="Ajouter une ligne" onClick={() => onEdit?.({ addRow: true })}><Plus className="w-3.5 h-3.5" /> Ligne</button>
          <button type="button" className={btn} disabled={columns.length >= SHEET_MAX_COLS} title="Ajouter une colonne" onClick={() => onEdit?.({ addColumn: "" })}><Plus className="w-3.5 h-3.5" /> Colonne</button>
          <button type="button" className={btn} disabled={!b || b.r1 < 0} title="Supprimer les lignes sélectionnées" onClick={() => { if (!b) return; const del: number[] = []; for (let r = Math.max(0, b.r0); r <= b.r1; r++) del.push(order[r]); onEdit?.({ deleteRows: del }); setSel(null); }}><Rows3 className="w-3.5 h-3.5" /><Trash2 className="w-3 h-3" /></button>
          <span className="ml-auto truncate text-[10px] text-ui-muted">{[summary, rowCount !== rows.length ? `${rowCount} / ${rows.length} lignes` : `${rows.length} ligne${rows.length > 1 ? "s" : ""}`].filter(Boolean).join(" · ")}</span>
        </div>
      )}
      {active && canEdit && band && (
        <div className="rounded-lg border border-ui-line bg-ui-raised p-2 text-[11px] text-ui-fg2" onMouseDown={(e) => e.stopPropagation()}>
          {(band.kind === "fill" || band.kind === "color") && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span>{band.kind === "fill" ? "Fond" : "Texte"} de la sélection :</span>
              {SHEET_COLORS.map((col) => (
                <button key={col} type="button" title={SHEET_PALETTE[col].label} onClick={() => { styleSelection(band.kind === "fill" ? { fill: col } : { color: col }); focusKeys(); }}
                  className="h-5 w-5 rounded border border-ui-line-strong" style={{ background: band.kind === "fill" ? SHEET_PALETTE[col].fill : SHEET_PALETTE[col].text }} />
              ))}
              <button type="button" className={btn} onClick={() => { styleSelection(band.kind === "fill" ? { fill: undefined } : { color: undefined }); focusKeys(); }}>Aucune</button>
              <button type="button" className="ml-auto text-ui-muted hover:text-ui-fg" aria-label="Fermer" onClick={() => setBand(null)}><X className="w-3.5 h-3.5" /></button>
            </div>
          )}
          {band.kind === "column" && <ColumnBand key={band.col} col={band.col} columns={columns} rows={rows} view={view} canDelete={columns.length > 1} onView={setView} onDelete={() => { onEdit?.({ deleteColumn: band.col }); setBand(null); setSel(null); }} onClose={() => setBand(null)} />}
          {band.kind === "rule" && <RuleBand columns={columns} initialCol={activeCol} rules={view?.rules ?? []} onRules={(rules) => setView({ rules })} onClose={() => setBand(null)} />}
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-auto mo-scroll rounded-md border border-ui-line">
        <textarea ref={keysRef} onKeyDown={onKeys} onInput={onKeysInput} aria-label="Clavier du tableau" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          className="pointer-events-none absolute left-0 top-0 h-px w-px resize-none border-0 p-0 opacity-0 outline-none" />
        <table className="w-full border-collapse" style={{ tableLayout: view?.widths ? "fixed" : "auto" }}>
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-[4] h-[21px] w-8 min-w-8 border border-ui-line bg-ui-sunken" onMouseDown={(e) => { e.preventDefault(); setSel({ a: { r: -1, c: 0 }, f: { r: rowCount - 1, c: colCount - 1 } }); focusKeys(); }} />
              {columns.map((_, c) => (
                <th key={c} style={view?.widths?.[c] ? { width: view.widths[c]!, minWidth: view.widths[c]! } : undefined}
                  onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setSel({ a: { r: -1, c }, f: { r: rowCount - 1, c } }); focusKeys(); }}
                  className={`sticky top-0 z-[3] h-[21px] border border-ui-line text-center text-[10px] font-medium select-none cursor-pointer ${b && c >= b.c0 && c <= b.c1 ? "bg-ui-accent-soft text-ui-accent-ink" : "bg-ui-sunken text-ui-muted"}`}>
                  {columnLetter(c)}
                  {canEdit && <span onMouseDown={(e) => resize(c, e)} className="absolute right-[-3px] top-0 z-[5] h-full w-[6px] cursor-col-resize" />}
                </th>
              ))}
            </tr>
            <tr>
              <th className={`sticky left-0 top-[21px] z-[4] w-8 min-w-8 border border-ui-line text-center text-[10px] font-medium select-none ${b && b.r0 <= -1 ? "bg-ui-accent-soft text-ui-accent-ink" : "bg-ui-sunken text-ui-muted"}`}>1</th>
              {columns.map((_, c) => renderCell(-1, c))}
            </tr>
          </thead>
          <tbody>
            {order.map((_, r) => (
              <tr key={order[r]}>
                <th onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); setSel({ a: { r, c: 0 }, f: { r, c: colCount - 1 } }); focusKeys(); }}
                  className={`sticky left-0 z-[1] w-8 min-w-8 border border-ui-line text-center text-[10px] font-medium select-none cursor-pointer ${b && r >= b.r0 && r <= b.r1 ? "bg-ui-accent-soft text-ui-accent-ink" : "bg-ui-sunken text-ui-muted"}`}>{r + 2}</th>
                {columns.map((__, c) => renderCell(r, c))}
              </tr>
            ))}
            {!order.length && <tr><td colSpan={colCount + 1} className="border border-ui-line px-2 py-3 text-center text-[12px] text-ui-muted">{rows.length ? "Aucune ligne ne passe les filtres" : "Aucune ligne"}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
});

/** Sort, filter, colour scale and deletion of one column. */
function ColumnBand({ col, columns, rows, view, canDelete, onView, onDelete, onClose }: { col: number; columns: string[]; rows: string[][]; view: MoSheetView | undefined; canDelete: boolean; onView: (patch: Partial<MoSheetView>) => void; onDelete: () => void; onClose: () => void }) {
  const others = (view?.filters ?? []).filter((f) => f.col !== col);
  const mine = (view?.filters ?? []).find((f) => f.col === col);
  const [op, setOp] = useState<SheetOp>(mine && mine.op !== "in" ? mine.op : "contains");
  const [value, setValue] = useState(mine && mine.op !== "in" ? mine.value ?? "" : "");
  const values = useMemo(() => columnValues(rows, col, 40), [rows, col]);
  const picked = mine?.op === "in" ? new Set(mine.values) : null;
  const scale = (view?.rules ?? []).find((r) => r.col === col && r.op === "scale");
  const setFilter = (f: SheetFilter | null) => onView({ filters: f ? [...others, f] : others });
  const toggleValue = (v: string) => {
    const next = new Set(picked ?? values);
    if (next.has(v)) next.delete(v); else next.add(v);
    setFilter(next.size === values.length ? null : { col, op: "in", values: [...next] });
  };
  const setScale = (high: "good" | "bad" | null) => onView({ rules: [...(view?.rules ?? []).filter((r) => !(r.col === col && r.op === "scale")), ...(high ? [{ col, op: "scale" as const, high }] : [])] });
  const needsValue = op !== "empty" && op !== "not_empty";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-ui-fg">{columnLetter(col)} · {columns[col]}</span>
        <button type="button" className={btn} onClick={() => onView({ sort: { col, dir: "asc" } })}><ArrowDownAZ className="w-3.5 h-3.5" /> Croissant</button>
        <button type="button" className={btn} onClick={() => onView({ sort: { col, dir: "desc" } })}><ArrowUpAZ className="w-3.5 h-3.5" /> Décroissant</button>
        {view?.sort?.col === col && <button type="button" className={btn} onClick={() => onView({ sort: undefined })}>Retirer le tri</button>}
        <span className="mx-0.5 h-4 w-px bg-ui-line" />
        <span>Échelle de couleurs :</span>
        <button type="button" className={`${btn} ${scale?.op === "scale" && scale.high === "good" ? "border-ui-accent text-ui-fg" : ""}`} onClick={() => setScale("good")}>haut = bon</button>
        <button type="button" className={`${btn} ${scale?.op === "scale" && scale.high === "bad" ? "border-ui-accent text-ui-fg" : ""}`} onClick={() => setScale("bad")}>haut = mauvais</button>
        {scale && <button type="button" className={btn} onClick={() => setScale(null)}>Retirer</button>}
        <button type="button" className="ml-auto text-ui-muted hover:text-ui-fg" aria-label="Fermer" onClick={onClose}><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Filter className="w-3.5 h-3.5" /><span>Garder les lignes où la valeur</span>
        <select className={field} value={op} onChange={(e) => setOp(e.target.value as SheetOp)}>{SHEET_OPS.map((o) => <option key={o} value={o}>{SHEET_OP_LABELS[o]}</option>)}</select>
        {needsValue && <input className={`${field} w-28`} value={value} placeholder="valeur" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && value.trim()) setFilter({ col, op, value: value.trim() }); }} />}
        <button type="button" className={btn} disabled={needsValue && !value.trim()} onClick={() => setFilter(needsValue ? { col, op, value: value.trim() } : { col, op })}>Filtrer</button>
        {mine && <button type="button" className={btn} onClick={() => { setFilter(null); setValue(""); }}>Retirer le filtre</button>}
        {canDelete && <button type="button" className={`${btn} ml-auto`} onClick={onDelete}><Trash2 className="w-3.5 h-3.5" /> Supprimer la colonne</button>}
      </div>
      {values.length > 1 && values.length <= 40 && (
        <div className="flex max-h-20 flex-wrap gap-1 overflow-auto mo-scroll">
          {values.map((v) => { const on = picked ? picked.has(v) : true; return (
            <button key={v} type="button" onClick={() => toggleValue(v)} className={`max-w-[160px] truncate rounded-full border px-2 py-0.5 text-[10px] ${on ? "border-ui-accent bg-ui-accent-soft text-ui-fg" : "border-ui-line text-ui-muted line-through"}`}>{v || "(vide)"}</button>
          ); })}
        </div>
      )}
    </div>
  );
}

/** Colour rules: « colonne · condition · valeur → couleur (la cellule ou toute la ligne) ». */
function RuleBand({ columns, initialCol, rules, onRules, onClose }: { columns: string[]; initialCol: number; rules: SheetRule[]; onRules: (rules: SheetRule[]) => void; onClose: () => void }) {
  const [col, setCol] = useState(Math.min(initialCol, columns.length - 1));
  const [op, setOp] = useState<SheetOp>("gt");
  const [value, setValue] = useState("");
  const [color, setColor] = useState<SheetColor>("green");
  const [row, setRow] = useState(false);
  const needsValue = op !== "empty" && op !== "not_empty";
  const add = () => { if (needsValue && !value.trim()) return; onRules([...rules, { col, op, ...(needsValue ? { value: value.trim() } : {}), color, ...(row ? { scope: "row" as const } : {}) }]); setValue(""); };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span>Si</span>
        <select className={field} value={col} onChange={(e) => setCol(Number(e.target.value))}>{columns.map((c, j) => <option key={j} value={j}>{columnLetter(j)} · {c}</option>)}</select>
        <select className={field} value={op} onChange={(e) => setOp(e.target.value as SheetOp)}>{SHEET_OPS.map((o) => <option key={o} value={o}>{SHEET_OP_LABELS[o]}</option>)}</select>
        {needsValue && <input className={`${field} w-24`} value={value} placeholder="valeur" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") add(); }} />}
        <span>→</span>
        {SHEET_COLORS.map((c) => <button key={c} type="button" title={SHEET_PALETTE[c].label} onClick={() => setColor(c)} className={`h-5 w-5 rounded border ${color === c ? "border-ui-fg ring-1 ring-ui-fg" : "border-ui-line-strong"}`} style={{ background: SHEET_PALETTE[c].fill }} />)}
        <label className="inline-flex items-center gap-1"><input type="checkbox" checked={row} onChange={(e) => setRow(e.target.checked)} /> toute la ligne</label>
        <button type="button" className={btn} disabled={needsValue && !value.trim()} onClick={add}><Plus className="w-3.5 h-3.5" /> Ajouter</button>
        <button type="button" className="ml-auto text-ui-muted hover:text-ui-fg" aria-label="Fermer" onClick={onClose}><X className="w-3.5 h-3.5" /></button>
      </div>
      {rules.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {rules.map((r, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full border border-ui-line px-2 py-0.5 text-[10px]" style={r.op === "scale" ? undefined : { background: SHEET_PALETTE[r.color].fill }}>
              {r.op === "scale" ? `${columns[r.col]} : échelle (haut = ${r.high === "good" ? "bon" : "mauvais"})` : `${columns[r.col]} ${SHEET_OP_LABELS[r.op]}${r.value ? ` ${r.value}` : ""}${r.scope === "row" ? " · ligne" : ""}`}
              <button type="button" aria-label="Retirer la règle" className="text-ui-muted hover:text-ui-fg" onClick={() => onRules(rules.filter((_, j) => j !== i))}><X className="w-3 h-3" /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
