"use client";

/**
 * Pages of the client bot: saved questions shown as tabs above the chat.
 *   BotRoutineTabs — « Conversation » + one tab per page (renamed in place) + « Nouvelle page »
 *   BotRoutineHead — title of the open page: last update, frequency, refresh, edit, delete
 *   BotRoutineForm — create a page or change its question
 * The state and the calls live in bot-chat.tsx: a page is a conversation of
 * its own, so its answer is followed and shown like any reply.
 */

import { useEffect, useRef, useState } from "react";
import { History, Loader2, MessageSquare, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ROUTINE_NAME_CHARS, ROUTINE_PROMPT_CHARS, SCHEDULE_OPTIONS, scheduleLabel, type PublicRoutine } from "@/lib/bot-routines";

const TAB = "group relative shrink-0 h-10 px-3 inline-flex items-center gap-2 text-sm border-b-2 -mb-px transition-colors duration-150";
const TAB_ON = "border-ui-accent text-ui-fg";
const TAB_OFF = "border-transparent text-ui-fg2 hover:text-ui-fg";

export function BotRoutineTabs({
  routines, activeRoutineId, creating, running, canAdd, onChat, onOpen, onNew, onRename,
}: {
  routines: PublicRoutine[];
  activeRoutineId: string | null;
  creating: boolean;
  /** Conversation ids on which a reply is being produced. */
  running: Set<string>;
  canAdd: boolean;
  onChat: () => void;
  onOpen: (r: PublicRoutine) => void;
  onNew: () => void;
  onRename: (r: PublicRoutine, name: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  function commit(r: PublicRoutine) {
    const name = draft.replace(/\s+/g, " ").trim();
    setEditing(null);
    if (name && name !== r.name) onRename(r, name);
  }

  return (
    <nav className="shrink-0 border-b border-ui-line px-2 sm:px-4 flex items-stretch gap-1 overflow-x-auto" aria-label="Pages de l'assistant">
      <button type="button" onClick={onChat} className={`${TAB} ${!activeRoutineId && !creating ? TAB_ON : TAB_OFF}`}>
        <MessageSquare className="w-4 h-4" strokeWidth={1.5} />
        Conversation
      </button>
      {routines.map((r) => {
        const active = r.id === activeRoutineId && !creating;
        if (editing === r.id) {
          return (
            <span key={r.id} className={`${TAB} ${TAB_ON}`}>
              <input
                ref={inputRef}
                value={draft}
                maxLength={ROUTINE_NAME_CHARS}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commit(r)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit(r);
                  else if (e.key === "Escape") setEditing(null);
                }}
                aria-label="Nom de la page"
                className="w-40 bg-transparent text-sm text-ui-fg border-b border-ui-line-strong focus:outline-none focus:border-ui-accent"
              />
            </span>
          );
        }
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => (active ? (setDraft(r.name), setEditing(r.id)) : onOpen(r))}
            onDoubleClick={() => { setDraft(r.name); setEditing(r.id); }}
            title={active ? "Cliquer pour renommer" : r.prompt}
            className={`${TAB} ${active ? TAB_ON : TAB_OFF}`}
          >
            {running.has(r.conversationId) && <Loader2 className="w-3.5 h-3.5 animate-spin text-ui-accent-ink" strokeWidth={1.5} aria-label="Mise à jour en cours" />}
            <span className="max-w-[14rem] truncate">{r.name}</span>
            {active && <Pencil className="w-3 h-3 text-ui-muted opacity-0 group-hover:opacity-100 transition-opacity duration-150" strokeWidth={1.5} />}
          </button>
        );
      })}
      {canAdd && (
        <button type="button" onClick={onNew} className={`${TAB} ${creating ? TAB_ON : "border-transparent text-ui-muted hover:text-ui-fg"}`}>
          <Plus className="w-4 h-4" strokeWidth={1.5} />
          Nouvelle page
        </button>
      )}
    </nav>
  );
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "jamais";
  try {
    return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
}

const ICON_BTN = "h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg text-xs text-ui-fg2 hover:text-ui-fg hover:bg-ui-raised disabled:opacity-50 transition-colors duration-150";

export function BotRoutineHead({
  routine, busy, hasHistory, showHistory, onRun, onSchedule, onEdit, onDelete, onToggleHistory,
}: {
  routine: PublicRoutine;
  busy: boolean;
  hasHistory: boolean;
  showHistory: boolean;
  onRun: () => void;
  onSchedule: (schedule: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleHistory: () => void;
}) {
  return (
    <div className="pb-6 border-b border-ui-line">
      <h2 className="text-2xl font-normal leading-tight text-ui-fg">{routine.name}</h2>
      <p className="mt-1 text-sm text-ui-fg2">{routine.prompt}</p>
      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2">
        <button
          type="button"
          onClick={onRun}
          disabled={busy}
          className="h-8 px-3 inline-flex items-center gap-1.5 rounded-lg text-xs font-medium bg-ui-accent text-ui-on-accent hover:brightness-110 disabled:opacity-60 transition-[filter] duration-150"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} /> : <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />}
          {busy ? "Mise à jour" : "Actualiser"}
        </button>
        <label className="inline-flex items-center gap-1.5 text-xs text-ui-fg2">
          <span className="sr-only">Fréquence de mise à jour</span>
          <select
            value={routine.schedule}
            onChange={(e) => onSchedule(e.target.value)}
            className="h-8 rounded-lg border border-ui-line bg-ui-bg px-2 text-xs text-ui-fg focus:border-ui-accent focus:outline-none"
          >
            {SCHEDULE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <button type="button" onClick={onEdit} disabled={busy} className={ICON_BTN}><Pencil className="w-3.5 h-3.5" strokeWidth={1.5} />Modifier la question</button>
        {hasHistory && (
          <button type="button" onClick={onToggleHistory} className={ICON_BTN} aria-pressed={showHistory}>
            <History className="w-3.5 h-3.5" strokeWidth={1.5} />{showHistory ? "Dernière version seule" : "Versions précédentes"}
          </button>
        )}
        <button type="button" onClick={onDelete} disabled={busy} className={`${ICON_BTN} hover:text-ui-neg`}><Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />Supprimer</button>
      </div>
      <p className="mt-3 text-xs text-ui-muted">
        Dernière mise à jour : {fmtWhen(routine.lastRunAt)}
        {routine.schedule !== "manual" && <> · mise à jour automatique : {scheduleLabel(routine.schedule).toLowerCase()}</>}
      </p>
    </div>
  );
}

const FIELD = "w-full rounded-lg border border-ui-line bg-ui-bg px-3 py-2 text-sm text-ui-fg placeholder:text-ui-muted focus:border-ui-accent focus:outline-none";

export function BotRoutineForm({
  initial, suggestedPrompt, busy, error, onSubmit, onCancel,
}: {
  /** Set when changing an existing page. */
  initial?: PublicRoutine;
  /** New page: the last question of the open conversation, as a starting point. */
  suggestedPrompt?: string;
  busy: boolean;
  error: string | null;
  onSubmit: (v: { name: string; prompt: string; schedule: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? suggestedPrompt ?? "");
  const [schedule, setSchedule] = useState(initial?.schedule ?? "weekly:1");
  const ok = name.trim() !== "" && prompt.trim() !== "";
  return (
    <form
      className="pt-4 sm:pt-10 max-w-xl space-y-5"
      onSubmit={(e) => { e.preventDefault(); if (ok && !busy) onSubmit({ name: name.trim(), prompt: prompt.trim(), schedule }); }}
    >
      <div>
        <h2 className="text-2xl font-normal leading-tight text-ui-fg">{initial ? "Modifier la page" : "Nouvelle page"}</h2>
        <p className="mt-2 text-sm leading-6 text-ui-fg2">
          Une page garde une question que vous posez souvent. Sa réponse est refaite avec les chiffres du moment, quand vous le demandez ou à la fréquence choisie, et vous attend dans son onglet.
        </p>
      </div>
      <label className="block space-y-1.5">
        <span className="text-xs text-ui-fg2">Nom de l&apos;onglet</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={ROUTINE_NAME_CHARS} placeholder="Bilan de la semaine" className={FIELD} autoFocus />
      </label>
      <label className="block space-y-1.5">
        <span className="text-xs text-ui-fg2">Question posée à chaque mise à jour</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={ROUTINE_PROMPT_CHARS}
          rows={4}
          placeholder="Fais le bilan de mes campagnes sur les 7 derniers jours, comparé aux 7 jours d'avant : dépense, achats, coût par achat et ROAS par campagne, puis les 3 points à retenir."
          className={`${FIELD} resize-y leading-6`}
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-xs text-ui-fg2">Mise à jour</span>
        <select value={schedule} onChange={(e) => setSchedule(e.target.value)} className={FIELD}>
          {SCHEDULE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {error && <div className="text-sm text-ui-neg bg-ui-neg/10 rounded-lg px-3 py-2">{error}</div>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={!ok || busy} className="h-9 px-4 inline-flex items-center gap-2 rounded-lg text-sm font-medium bg-ui-accent text-ui-on-accent hover:brightness-110 disabled:opacity-50 transition-[filter] duration-150">
          {busy && <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />}
          {initial ? "Enregistrer" : "Créer la page"}
        </button>
        <button type="button" onClick={onCancel} className="h-9 px-3 rounded-lg text-sm text-ui-fg2 hover:text-ui-fg hover:bg-ui-raised transition-colors duration-150">Annuler</button>
      </div>
    </form>
  );
}
