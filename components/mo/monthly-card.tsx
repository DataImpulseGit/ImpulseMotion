"use client";

/**
 * Body of a « monthly » card — the monthly workshop (lib/mo/monthly.ts).
 * The sections of the deck from top to bottom: the consultant writes the
 * messages (a title that says something, learnings, next steps — one line
 * each), drops creatives in from any creatives card of the board, gives each
 * its verdict, reads what the review still flags, then publishes the deck
 * as Google Slides in the client's Drive.
 *
 * Text is kept locally while it is typed and goes up when the field is left.
 */

import { memo, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, ImagePlus, Loader2, Presentation, Trash2, X } from "lucide-react";
import type { MoCard } from "@/lib/mo/model";
import { CreativeImage } from "@/components/mo/card";
import {
  MONTHLY_BADGES, MONTHLY_KIND_LABELS, MONTHLY_LIST_LABELS, MONTHLY_LISTS, MONTHLY_MAX, MONTHLY_RULES, PLATFORM_LABELS, capitalize, monthLabel, monthlyChecks,
  type MonthlyBadge, type MonthlyEdit, type MonthlyListKey, type MonthlySection,
} from "@/lib/mo/monthly";

type MonthlyCard = Extract<MoCard, { type: "monthly" }>;
/** What the card asks of the page: an edit, a creative dropped in from another card, or the publication. */
export type MonthlyOp = { edit: MonthlyEdit } | { from: { cardId: string; item: number; section: string } } | { publish: true };
/** What a dragged creative carries (set by the creatives card, components/mo/card.tsx). */
export const CREATIVE_DRAG_TYPE = "application/x-mo-creative";

const field = "w-full rounded-md border border-ui-line bg-ui-bg px-2 py-1.5 text-[12px] text-ui-fg outline-none placeholder:text-ui-muted focus:border-ui-accent";
const LIST_LIMIT: Partial<Record<MonthlyListKey, number>> = { learnings: MONTHLY_RULES.learnings, nextSteps: MONTHLY_RULES.nextSteps };
const LIST_HINT: Record<MonthlyListKey, string> = {
  previous: "Ce qu'on avait retenu le mois dernier — une ligne par point",
  done: "Ce qui a été fait ce mois-ci — une ligne par action",
  todo: "Ce qui reste à mettre en place — une ligne par action",
  learnings: "Pourquoi ces chiffres — 3 au plus, 2 lignes chacun, sans recopier le tableau",
  nextSteps: "Verbe d'action, chiffré, campagne nommée, date — 3 au plus",
  budget: "Budget par levier pour le mois prochain — une ligne par levier",
};

/** A text kept locally while it is typed; goes up (onCommit) when the field is left, only if it changed. */
function useDraft(value: string, onCommit: (v: string) => void) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [seen, setSeen] = useState(value);
  // A new value from outside (Mo wrote, the server answered) replaces the draft unless the person is typing in it.
  if (value !== seen) { setSeen(value); if (!focused) setDraft(value); }
  return {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onFocus: () => setFocused(true),
    onBlur: () => { setFocused(false); if (draft !== value) onCommit(draft); },
  };
}

function TextField({ value, placeholder, onCommit, className = "", rows }: { value: string; placeholder: string; onCommit: (v: string) => void; className?: string; rows?: number }) {
  const d = useDraft(value, onCommit);
  return rows
    ? <textarea {...d} rows={rows} placeholder={placeholder} className={`${field} resize-y leading-snug ${className}`} />
    : <input {...d} placeholder={placeholder} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} className={`${field} ${className}`} />;
}

/** A list written one line per item. */
function ListField({ label, hint, items, limit, onCommit }: { label: string; hint: string; items: string[]; limit?: number; onCommit: (items: string[]) => void }) {
  const text = items.join("\n");
  const d = useDraft(text, (v) => onCommit(v.split("\n").map((l) => l.trim()).filter(Boolean)));
  const count = d.value.split("\n").filter((l) => l.trim()).length;
  const over = limit !== undefined && count > limit;
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-ui-fg2">
        <span>{"// "}{label}</span>
        {limit !== undefined && <span className={over ? "text-ui-warn" : "text-ui-muted"}>{count}/{limit}</span>}
      </span>
      <textarea {...d} rows={Math.min(7, Math.max(3, count + 1))} placeholder={hint} className={`${field} resize-y leading-snug ${over ? "border-ui-warn" : ""}`} />
    </label>
  );
}

const BADGE_ORDER: MonthlyBadge[] = ["winner", "watch", "cut"];

function CreativesZone({ section, canEdit, onOp }: { section: MonthlySection; canEdit: boolean; onOp: (op: MonthlyOp) => void }) {
  const [over, setOver] = useState(false);
  const list = section.creatives ?? [];
  const accepts = (e: React.DragEvent) => canEdit && Array.from(e.dataTransfer?.types ?? []).includes(CREATIVE_DRAG_TYPE);
  return (
    <div onDragOver={(e) => { if (!accepts(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!accepts(e)) return;
        e.preventDefault(); e.stopPropagation(); setOver(false);
        try { const d = JSON.parse(e.dataTransfer.getData(CREATIVE_DRAG_TYPE)) as { cardId?: string; index?: number }; if (typeof d.cardId === "string" && Number.isInteger(d.index)) onOp({ from: { cardId: d.cardId, item: d.index!, section: section.id } }); } catch { /* not ours */ }
      }}
      className={`rounded-lg border border-dashed p-2 transition-colors ${over ? "border-ui-accent bg-ui-accent-soft" : "border-ui-line-strong"}`}>
      {list.length > 0 && (
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          {list.map((c, i) => (
            <div key={`${c.adId ?? c.assetId ?? c.name}-${i}`} className="group relative flex flex-col overflow-hidden rounded-lg border border-ui-line bg-ui-raised">
              <div className="relative">
                {c.image ? <CreativeImage src={c.image} alt={c.name} ratio="aspect-square" /> : <div className="flex aspect-square items-center justify-center bg-yellow-500/20 text-[10px] font-semibold text-yellow-200">VISUEL À AJOUTER</div>}
                {c.badge && <span className="absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold text-white" style={{ background: `#${MONTHLY_BADGES[c.badge].hex}` }}>{MONTHLY_BADGES[c.badge].label}</span>}
                {canEdit && <button type="button" aria-label={`Retirer ${c.name} du monthly`} onClick={() => onOp({ edit: { removeCreative: { section: section.id, index: i } } })} className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white opacity-0 hover:bg-black group-hover:opacity-100 focus:opacity-100"><X className="h-3 w-3" /></button>}
              </div>
              <div className="flex flex-1 flex-col gap-1 px-2 py-1.5">
                <div className="truncate text-[11px] font-medium text-ui-fg" title={c.name}>{c.name}</div>
                <dl className="grid grid-cols-2 gap-x-2 text-[10px]">
                  {Object.entries(c.metrics).map(([k, v]) => <div key={k} className="contents"><dt className="truncate text-ui-muted">{k}</dt><dd className="text-right tabular-nums text-ui-fg2">{v}</dd></div>)}
                </dl>
                {canEdit && (
                  <div className="mt-auto flex gap-1 pt-1">
                    {BADGE_ORDER.map((b) => (
                      <button key={b} type="button" title={MONTHLY_BADGES[b].label} onClick={() => onOp({ edit: { badge: { section: section.id, index: i, badge: c.badge === b ? null : b } } })}
                        className={`flex-1 rounded px-1 py-0.5 text-[9px] font-semibold ${c.badge === b ? "text-white" : "border border-ui-line text-ui-muted hover:text-ui-fg"}`} style={c.badge === b ? { background: `#${MONTHLY_BADGES[b].hex}` } : undefined}>
                        {b === "winner" ? "Winner" : b === "watch" ? "Surveiller" : "Couper"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className={`flex items-center justify-center gap-1.5 text-[11px] text-ui-muted ${list.length ? "pt-2" : "py-6"}`}>
        <ImagePlus className="h-3.5 w-3.5" />
        {list.length >= MONTHLY_MAX.creatives ? `${MONTHLY_MAX.creatives} créas au plus par section` : list.length ? `Glisse d'autres créas ici (${MONTHLY_RULES.creativesPerSlide} par slide${list.length > MONTHLY_RULES.creativesPerSlide ? ", donc 2 slides" : ""})` : "Glisse ici des créas depuis une carte de créas du tableau"}
      </div>
    </div>
  );
}

function SectionBlock({ section, index, canEdit, flagged, onOp }: { section: MonthlySection; index: number; canEdit: boolean; flagged: number; onOp: (op: MonthlyOp) => void }) {
  const label = section.kind === "channel" || section.kind === "creatives" ? `${MONTHLY_KIND_LABELS[section.kind]} · ${PLATFORM_LABELS[section.platform ?? ""] ?? section.platform ?? ""}` : MONTHLY_KIND_LABELS[section.kind];
  return (
    <section data-section={section.id} className="flex flex-col gap-2 rounded-xl border border-ui-line bg-ui-card p-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-ui-muted">
        <span className="rounded-full bg-ui-raised px-2 py-0.5 text-ui-fg2">{index + 1} · {label}</span>
        {flagged > 0 && <span className="inline-flex items-center gap-1 text-ui-warn"><AlertTriangle className="h-3 w-3" /> {flagged} à revoir</span>}
        {canEdit && section.kind !== "next" && section.kind !== "overview" && <button type="button" title="Retirer cette section du monthly" onClick={() => onOp({ edit: { removeSection: section.id } })} className="ml-auto rounded p-1 text-ui-muted hover:bg-ui-raised hover:text-ui-fg"><Trash2 className="h-3.5 w-3.5" /></button>}
      </div>
      <TextField value={section.title} placeholder="Le titre de la slide : un message, pas un thème (« En octobre, un CPL 13 % sous l'objectif »)" onCommit={(v) => onOp({ edit: { title: { section: section.id, value: v } } })} className="!text-[14px] font-semibold !text-ui-accent-ink" />
      {!!section.kpis?.length && (
        <div className="flex flex-wrap gap-1.5">
          {section.kpis.map((k, i) => (
            <div key={i} className="min-w-[104px] flex-1 rounded-lg bg-ui-raised px-2.5 py-1.5">
              <div className="truncate text-[9px] font-semibold uppercase text-ui-muted">{k.label}</div>
              <div className="text-[14px] font-semibold tabular-nums text-ui-fg">{k.value}</div>
              {k.delta && <div className={`text-[10px] font-semibold tabular-nums ${k.tone === "good" ? "text-ui-pos" : k.tone === "bad" ? "text-ui-neg" : "text-ui-muted"}`}>{k.delta}</div>}
            </div>
          ))}
        </div>
      )}
      {section.table && (
        <div className="overflow-x-auto mo-scroll rounded-md border border-ui-line">
          <table className="w-full border-collapse text-[11px]">
            <thead><tr>{section.table.columns.map((c, j) => <th key={j} className={`whitespace-nowrap bg-ui-raised px-2 py-1 text-[10px] font-semibold uppercase text-ui-fg2 ${j ? "text-right" : "text-left"}`}>{c}</th>)}</tr></thead>
            <tbody>{section.table.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j} className={`whitespace-nowrap border-t border-ui-line px-2 py-1 ${j ? "text-right tabular-nums text-ui-fg2" : "text-left text-ui-fg"}`}>{cell || "—"}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {section.kind === "creatives" && <CreativesZone section={section} canEdit={canEdit} onOp={onOp} />}
      <div className="flex flex-wrap gap-2">
        {MONTHLY_LISTS[section.kind].map((key) => (
          <ListField key={key} label={MONTHLY_LIST_LABELS[key]} hint={LIST_HINT[key]} items={section.lists[key] ?? []} limit={LIST_LIMIT[key]}
            onCommit={(items) => onOp({ edit: { list: { section: section.id, key, items } } })} />
        ))}
      </div>
    </section>
  );
}

export const MonthlyCardBody = memo(function MonthlyCardBody({ card, publishing, onOp }: { card: MonthlyCard; publishing: boolean; onOp?: (op: MonthlyOp) => void }) {
  const doc = card.doc;
  const checks = useMemo(() => monthlyChecks(doc), [doc]);
  const [showChecks, setShowChecks] = useState(false);
  const canEdit = !!onOp;
  const op = (o: MonthlyOp) => onOp?.(o);
  const blocking = checks.filter((c) => c.level === "block").length;
  const bySection = useMemo(() => { const m = new Map<string, number>(); for (const c of checks) if (c.section) m.set(c.section, (m.get(c.section) ?? 0) + 1); return m; }, [checks]);
  // A click on a check brings its section into view.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const goTo = (id?: string) => { if (id) rootRef.current?.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }); };
  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ui-fg">{doc.clientName} — {capitalize(monthLabel(doc.month))}</div>
          <div className="truncate text-[10px] text-ui-muted">{doc.period.since} → {doc.period.until}{doc.compareLabel ? ` · ${doc.compareLabel}` : ""} · {doc.sections.length} sections</div>
        </div>
        <button type="button" onClick={() => setShowChecks((v) => !v)} disabled={!checks.length} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] ${checks.length ? (blocking ? "border-ui-neg text-ui-neg" : "border-ui-warn text-ui-warn") : "border-ui-line text-ui-pos"}`}>
          {checks.length ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          {checks.length ? `Relecture : ${checks.length} point${checks.length > 1 ? "s" : ""}` : "Relecture : rien à signaler"}
        </button>
        {doc.deck && <a href={doc.deck.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded-full border border-ui-line bg-ui-raised px-2.5 py-1 text-[11px] text-ui-fg hover:border-ui-line-strong"><ExternalLink className="h-3.5 w-3.5" /> Ouvrir le Slides</a>}
        {canEdit && (
          <button type="button" disabled={publishing || blocking > 0} title={blocking ? "Un texte reste à compléter (voir la relecture)" : "Crée (ou met à jour) le Google Slides dans le dossier « Monthly » du Drive du client"} onClick={() => op({ publish: true })}
            className="inline-flex items-center gap-1.5 rounded-full bg-ui-accent px-3 py-1 text-[11px] font-semibold text-ui-on-accent hover:opacity-90 disabled:opacity-50">
            {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Presentation className="h-3.5 w-3.5" />}
            {publishing ? "Publication…" : doc.deck ? "Mettre à jour le Slides" : "Publier en Google Slides"}
          </button>
        )}
      </div>
      {showChecks && checks.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-ui-line bg-ui-raised p-2 text-[11px]">
          {checks.map((c, i) => (
            <li key={i}><button type="button" onClick={() => goTo(c.section)} className={`w-full text-left ${c.section ? "hover:underline" : "cursor-default"} ${c.level === "block" ? "text-ui-neg" : "text-ui-fg2"}`}>{c.level === "block" ? "Bloquant — " : "• "}{c.message}</button></li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <label className="flex min-w-[260px] flex-[3] flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-ui-fg2">Contexte du mois</span>
          {canEdit ? <TextField value={doc.context} rows={2} placeholder="Ce qui a changé ce mois-ci : budget, lancements, offres, incidents de tracking… Sans lui, les chiffres sont décrits ; avec lui, ils sont expliqués." onCommit={(v) => op({ edit: { context: v } })} /> : <p className="text-[12px] text-ui-fg2">{doc.context || "—"}</p>}
        </label>
        <label className="flex min-w-[160px] flex-1 flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-ui-fg2">Prochain monthly</span>
          {canEdit ? <TextField value={doc.nextDate} placeholder="mardi 9 décembre" onCommit={(v) => op({ edit: { nextDate: v } })} /> : <p className="text-[12px] text-ui-fg2">{doc.nextDate || "—"}</p>}
        </label>
      </div>
      {doc.sections.map((s, i) => <SectionBlock key={s.id} section={s} index={i} canEdit={canEdit} flagged={bySection.get(s.id) ?? 0} onOp={op} />)}
    </div>
  );
});
