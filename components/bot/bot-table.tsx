"use client";

/**
 * A table in an assistant reply, with « Ouvrir dans Google Sheets »: the cells
 * as shown go to POST /api/bot/[botId]/sheet, which creates the sheet in the
 * client's Drive folder and shares it with them; the sheet opens in a new tab.
 */

import { Children, isValidElement, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, Loader2, Sheet } from "lucide-react";
import { buildTableView, sortOrder, type SortState, type Tone } from "@/lib/bot-table-view";

type El = React.ReactElement<{ children?: React.ReactNode }>;

function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as El).props.children);
  return "";
}

const kids = (node: React.ReactNode): El[] => Children.toArray(node).filter(isValidElement) as El[];

/** Header cells and body rows of the Markdown table, as React elements. */
function readTable(children: React.ReactNode): { head: El[]; body: El[][] } {
  let head: El[] = [];
  const body: El[][] = [];
  for (const section of kids(children)) {
    for (const tr of kids(section.props.children)) {
      const cells = kids(tr.props.children);
      if (section.type === "thead" && head.length === 0) head = cells;
      else body.push(cells);
    }
  }
  return { head, body };
}

// Good / bad as a tint behind the figure: the number stays readable in both themes.
const TONE_STYLE: Record<Exclude<Tone, null>, React.CSSProperties> = {
  pos: { backgroundColor: "color-mix(in srgb, var(--ui-pos) 20%, transparent)", color: "color-mix(in srgb, var(--ui-pos) 70%, var(--ui-fg))" },
  neg: { backgroundColor: "color-mix(in srgb, var(--ui-neg) 20%, transparent)", color: "color-mix(in srgb, var(--ui-neg) 70%, var(--ui-fg))" },
};

export function BotTable({ botId, title, children }: { botId: string; title: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);
  const [state, setState] = useState<{ busy: boolean; url?: string; error?: string; notified?: boolean }>({ busy: false });
  const [sort, setSort] = useState<SortState>(null);

  async function exportSheet() {
    const el = ref.current;
    if (!el) return;
    const text = (c: Element) => (c.textContent ?? "").trim();
    const head = el.querySelector("thead tr");
    const bodyRows = Array.from(el.querySelectorAll("tbody tr"));
    const columns = head ? Array.from(head.children).map(text) : Array.from(bodyRows.shift()?.children ?? []).map(text);
    const rows = bodyRows.map((r) => Array.from(r.children).map(text));
    // Opened at once (inside the click) so the browser does not block it, then pointed at the sheet.
    const win = window.open("", "_blank");
    setState({ busy: true });
    try {
      const res = await fetch(`/api/bot/${botId}/sheet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, columns, rows }),
      });
      const j = (await res.json().catch(() => ({}))) as { url?: string; notified?: boolean; error?: string };
      if (!res.ok || !j.url) throw new Error(j.error || `Erreur ${res.status}`);
      if (win) win.location.href = j.url;
      setState({ busy: false, url: j.url, notified: j.notified });
    } catch (e) {
      win?.close();
      setState({ busy: false, error: e instanceof Error ? e.message : "Export impossible" });
    }
  }

  const { head, body } = readTable(children);
  const headers = head.map((c) => textOf(c.props.children).trim());
  const rows = body.map((r) => r.map((c) => textOf(c.props.children).trim()));
  const signature = JSON.stringify([headers, rows]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- headers/rows are rebuilt on every render; their content is the key
  const view = useMemo(() => buildTableView(headers, rows), [signature]);
  const order = sortOrder(view, rows, sort);
  const sortable = rows.length > 2;

  function toggleSort(col: number) {
    // Figures: best first on the first click. Text: A → Z. Third click: back to the reply's order.
    const first = view.numeric[col] ? "desc" : "asc";
    setSort((s) => (s?.col !== col ? { col, dir: first } : s.dir === first ? { col, dir: first === "desc" ? "asc" : "desc" } : null));
  }

  return (
    <div className="not-prose my-4">
      <div className="overflow-x-auto rounded-lg border border-ui-line">
        <table ref={ref} className="w-full text-xs tabular-nums border-collapse">
          {head.length > 0 && (
            <thead>
              <tr className="bg-ui-raised">
                {head.map((c, i) => {
                  const active = sort?.col === i;
                  const Icon = active && sort?.dir === "asc" ? ArrowUp : ArrowDown;
                  return (
                    <th
                      key={i}
                      scope="col"
                      aria-sort={active ? (sort?.dir === "asc" ? "ascending" : "descending") : undefined}
                      className={`px-3 py-2 font-medium text-ui-fg2 border-b border-ui-line-strong whitespace-nowrap ${view.numeric[i] ? "text-right" : "text-left"} ${i === 0 ? "sticky left-0 bg-ui-raised" : ""}`}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(i)}
                          title="Trier"
                          className={`group inline-flex items-center gap-1 hover:text-ui-fg transition-colors duration-150 ${view.numeric[i] ? "flex-row-reverse" : ""} ${active ? "text-ui-fg" : ""}`}
                        >
                          <span>{c.props.children}</span>
                          <Icon className={`w-3 h-3 shrink-0 ${active ? "opacity-100" : "opacity-0 group-hover:opacity-40"}`} strokeWidth={1.5} />
                        </button>
                      ) : c.props.children}
                    </th>
                  );
                })}
              </tr>
            </thead>
          )}
          <tbody>
            {order.map((r) => (
              <tr key={r} className={`group/row ${view.totals[r] ? "font-medium bg-ui-raised" : "hover:bg-ui-raised"}`}>
                {body[r].map((c, i) => {
                  const tone = view.tones[r]?.[i] ?? null;
                  return (
                    <td
                      key={i}
                      style={tone ? TONE_STYLE[tone] : undefined}
                      data-tone={tone ?? undefined}
                      className={`px-3 py-1.5 border-b border-ui-line text-ui-fg ${view.numeric[i] ? "text-right whitespace-nowrap" : "text-left"} ${i === 0 ? `sticky left-0 font-medium ${view.totals[r] ? "bg-ui-raised" : "bg-ui-bg group-hover/row:bg-ui-raised"}` : ""}`}
                    >
                      {c.props.children}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.ranked && (
        <p className="mt-1.5 flex items-center gap-3 text-[11px] text-ui-muted">
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "var(--ui-pos)" }} />meilleur que la médiane du tableau</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "var(--ui-neg)" }} />moins bon</span>
        </p>
      )}
      <div className="mt-2 flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => void exportSheet()}
          disabled={state.busy}
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-ui-fg2 hover:text-ui-fg hover:bg-ui-raised disabled:opacity-50 transition-colors duration-150"
        >
          {state.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sheet className="w-3.5 h-3.5" strokeWidth={1.5} />}
          {state.busy ? "Création de la feuille" : "Ouvrir dans Google Sheets"}
        </button>
        {state.url && (
          <a href={state.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ui-accent-ink hover:underline">
            Feuille créée <ExternalLink className="w-3 h-3" strokeWidth={1.5} />
          </a>
        )}
        {state.notified && <span className="text-ui-muted">Un e-mail d&apos;accès vous a été envoyé par Google</span>}
        {state.error && <span className="text-ui-neg">{state.error}</span>}
      </div>
    </div>
  );
}
