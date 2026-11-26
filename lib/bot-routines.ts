/**
 * Pages of the client bot (model BotRoutine): a saved question shown as a tab
 * the person names, refreshed on demand or on a schedule. Pure rules here —
 * limits, schedule reading, « is it due this morning ».
 *
 * A page's runs are appended to its own conversation, so a follow-up question
 * on the page is an ordinary turn of that conversation.
 */

import { localParts } from "@/lib/routines/schedule";

export const MAX_ROUTINES_PER_USER = 8;
export const ROUTINE_NAME_CHARS = 40;
export const ROUTINE_PROMPT_CHARS = 2000;
const TIMEZONE = "Europe/Paris";

export type RoutineSchedule = "manual" | "daily" | "monthly" | `weekly:${1 | 2 | 3 | 4 | 5 | 6 | 7}`;

const WEEKDAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

export const SCHEDULE_OPTIONS: Array<{ value: RoutineSchedule; label: string }> = [
  { value: "manual", label: "À la demande" },
  { value: "daily", label: "Chaque matin" },
  ...WEEKDAYS.map((d, i) => ({ value: `weekly:${i + 1}` as RoutineSchedule, label: `Chaque ${d} matin` })),
  { value: "monthly", label: "Le 1er de chaque mois" },
];

export function parseSchedule(raw: unknown): RoutineSchedule | null {
  return typeof raw === "string" && SCHEDULE_OPTIONS.some((o) => o.value === raw) ? (raw as RoutineSchedule) : null;
}

export function scheduleLabel(schedule: string): string {
  return SCHEDULE_OPTIONS.find((o) => o.value === schedule)?.label ?? "À la demande";
}

export function cleanName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, ROUTINE_NAME_CHARS) : "";
}

export function cleanPrompt(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, ROUTINE_PROMPT_CHARS) : "";
}

/** Day number (days since epoch) of an instant on the Paris calendar, and its weekday (1 = Monday). */
function parisDay(at: Date): { day: number; weekday: number; dayOfMonth: number } {
  const p = localParts(at, TIMEZONE);
  const utc = Date.UTC(p.year, p.month - 1, p.day);
  return { day: Math.round(utc / 86_400_000), weekday: ((new Date(utc).getUTCDay() + 6) % 7) + 1, dayOfMonth: p.day };
}

/**
 * Should the morning pass refresh this page now? Once per occurrence: a page
 * already refreshed since its latest occurrence (by the pass or by hand) waits
 * for the next one. A pass that was missed is caught up within the week
 * (weekly) or the month (monthly), never replayed twice.
 */
export function isRoutineDue(schedule: string, lastRunAt: Date | null, now: Date): boolean {
  const s = parseSchedule(schedule);
  if (!s || s === "manual") return false;
  const today = parisDay(now);
  let occurrence = today.day;
  if (s === "monthly") occurrence = today.day - (today.dayOfMonth - 1);
  else if (s !== "daily") occurrence = today.day - ((today.weekday - Number(s.slice(7)) + 7) % 7);
  return !lastRunAt || parisDay(lastRunAt).day < occurrence;
}

export interface PublicRoutine {
  id: string;
  conversationId: string;
  name: string;
  prompt: string;
  schedule: string;
  lastRunAt: string | null;
}

export const ROUTINE_SELECT = { id: true, conversationId: true, name: true, prompt: true, schedule: true, lastRunAt: true } as const;

export function publicRoutine(r: { id: string; conversationId: string; name: string; prompt: string; schedule: string; lastRunAt: Date | null }): PublicRoutine {
  return { id: r.id, conversationId: r.conversationId, name: r.name, prompt: r.prompt, schedule: r.schedule, lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null };
}
