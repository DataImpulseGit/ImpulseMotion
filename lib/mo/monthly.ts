/**
 * The monthly workshop of Mo — the client's monthly report built on the board,
 * then published as a Google Slides deck in the client's Drive.
 *
 * A « monthly » card holds the document: the sections of the agency's common
 * trunk (HQ skills slides-impulse / monthly-reproduction: remise en contexte,
 * vue globale, depuis le début de l'année, un détail et des créas par canal,
 * budget & next steps), pre-filled with the month's figures. The consultant
 * writes the messages (titles, learnings, next steps), drags creatives in from
 * a creatives card and gives each its verdict; `monthlyChecks` reads the
 * document as the agency's review does (HQ skill monthly-qa) before it goes out.
 *
 * Pure: types, sanitation, edits and checks. The figures come from
 * lib/mo/monthly-build.ts, the deck from lib/mo/monthly-deck.ts.
 */

export type MonthlyKind = "context" | "overview" | "ytd" | "channel" | "creatives" | "next";
export type MonthlyListKey = "previous" | "done" | "todo" | "learnings" | "nextSteps" | "budget";
export type MonthlyBadge = "winner" | "watch" | "cut";
export type MonthlyTone = "good" | "bad" | "neutral";

export const MONTHLY_BADGES: Record<MonthlyBadge, { label: string; hex: string }> = {
  winner: { label: "WINNER", hex: "6AA84F" },
  watch: { label: "À SURVEILLER", hex: "E69138" },
  cut: { label: "À COUPER", hex: "CC4125" },
};
export const MONTHLY_LIST_LABELS: Record<MonthlyListKey, string> = {
  previous: "Enseignements du monthly précédent",
  done: "Mis en place ce mois-ci",
  todo: "Reste à mettre en place",
  learnings: "Learnings",
  nextSteps: "Next steps",
  budget: "Budget du mois prochain",
};
/** The lists a section of each kind carries, in the order they are shown. */
export const MONTHLY_LISTS: Record<MonthlyKind, MonthlyListKey[]> = {
  context: ["previous", "done", "todo"],
  overview: ["learnings"],
  ytd: ["learnings"],
  channel: ["learnings", "nextSteps"],
  creatives: ["learnings", "nextSteps"],
  next: ["budget", "nextSteps"],
};
export const MONTHLY_KIND_LABELS: Record<MonthlyKind, string> = { context: "Remise en contexte", overview: "Vue globale", ytd: "Depuis le début de l'année", channel: "Détail du canal", creatives: "Créas", next: "Budget & next steps" };
export const PLATFORM_LABELS: Record<string, string> = { meta: "Meta Ads", google: "Google Ads", tiktok: "TikTok Ads" };

export interface MonthlyKpi { label: string; value: string; delta?: string; tone?: MonthlyTone }
export interface MonthlyTable { columns: string[]; rows: string[][] }
/** One creative of the monthly: a visual, its short name, 3-4 figures and the consultant's verdict. */
export interface MonthlyCreative { name: string; image?: string; adId?: string; assetId?: string; platform?: string; metrics: Record<string, string>; badge?: MonthlyBadge }

export interface MonthlySection {
  id: string;
  kind: MonthlyKind;
  /** The channel of a « channel » / « creatives » section. */
  platform?: string;
  /** The slide's title: a message (« En octobre, un CPL 13 % sous l'objectif »), not a theme. */
  title: string;
  kpis?: MonthlyKpi[];
  table?: MonthlyTable;
  creatives?: MonthlyCreative[];
  lists: Partial<Record<MonthlyListKey, string[]>>;
}

export interface MonthlyDoc {
  clientId: string;
  clientName: string;
  /** « 2026-10 » */
  month: string;
  period: { since: string; until: string };
  /** What the figures are compared with (« vs septembre 2026 »). */
  compareLabel: string;
  /** What the consultant says of the month (budget change, launch, promotion…): it explains the figures. */
  context: string;
  /** Date of the next monthly, as it will be written on the last slide. */
  nextDate: string;
  sections: MonthlySection[];
  /** The Google Slides published from this document. */
  deck?: { link: string; at: string };
}

export const MONTHLY_MAX = { sections: 16, list: 6, line: 280, creatives: 8, kpis: 8, tableRows: 14, tableCols: 8, metrics: 5 } as const;
/** What the agency's rules ask per slide (HQ monthly-qa): beyond it the check warns, the document still holds it. */
export const MONTHLY_RULES = { learnings: 3, nextSteps: 3, creativesPerSlide: 4 } as const;

const KINDS: MonthlyKind[] = ["context", "overview", "ytd", "channel", "creatives", "next"];
const LIST_KEYS: MonthlyListKey[] = ["previous", "done", "todo", "learnings", "nextSteps", "budget"];
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const lines = (v: unknown, max: number = MONTHLY_MAX.list) => (Array.isArray(v) ? v : []).map((x) => str(x, MONTHLY_MAX.line).replace(/\s*\n\s*/g, " ")).filter(Boolean).slice(0, max);
const tone = (v: unknown): MonthlyTone | undefined => (v === "good" || v === "bad" || v === "neutral" ? v : undefined);
const badge = (v: unknown): MonthlyBadge | undefined => (v === "winner" || v === "watch" || v === "cut" ? v : undefined);
/** A picture a card may show: an application path (visual handle, asset) or an https link. */
const imageOk = (v: string) => /^\/api\/(mo\/ad-image|studio\/assets|studio\/media|media)\/[\w\-./?=&%:+,]{1,400}$/.test(v) || /^https:\/\/[^\s"'<>]{1,1500}$/.test(v);

export function sanitizeMonthlyCreative(raw: unknown): MonthlyCreative | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 80);
  if (!name) return null;
  const image = str(r.image, 1500);
  const metrics: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.metrics && typeof r.metrics === "object" ? (r.metrics as Record<string, unknown>) : {})) {
    if (Object.keys(metrics).length >= MONTHLY_MAX.metrics) break;
    const key = str(k, 30); const val = str(v, 40);
    if (key && val) metrics[key] = val;
  }
  const adId = /^[\w:-]{3,60}$/.test(String(r.adId ?? "")) ? String(r.adId) : undefined;
  const assetId = /^[\w-]{3,40}$/.test(String(r.assetId ?? "")) ? String(r.assetId) : undefined;
  const platform = /^(meta|google|tiktok|linkedin)$/.test(String(r.platform ?? "")) ? String(r.platform) : undefined;
  const b = badge(r.badge);
  return { name, ...(image && imageOk(image) ? { image } : {}), ...(adId ? { adId } : {}), ...(assetId ? { assetId } : {}), ...(platform ? { platform } : {}), metrics, ...(b ? { badge: b } : {}) };
}

function sanitizeSection(raw: unknown, i: number): MonthlySection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = KINDS.find((k) => k === r.kind);
  if (!kind) return null;
  const id = /^[a-z0-9-]{1,24}$/.test(String(r.id ?? "")) ? String(r.id) : `s${i + 1}`;
  const platform = /^(meta|google|tiktok|linkedin)$/.test(String(r.platform ?? "")) ? String(r.platform) : undefined;
  const lists: Partial<Record<MonthlyListKey, string[]>> = {};
  const given = r.lists && typeof r.lists === "object" ? (r.lists as Record<string, unknown>) : {};
  for (const key of MONTHLY_LISTS[kind]) lists[key] = lines(given[key]);
  const kpis = (Array.isArray(r.kpis) ? r.kpis : []).slice(0, MONTHLY_MAX.kpis).map((k): MonthlyKpi | null => {
    if (!k || typeof k !== "object") return null;
    const x = k as Record<string, unknown>;
    const label = str(x.label, 40); const value = str(x.value, 40); const delta = str(x.delta, 40); const t = tone(x.tone);
    return label && value ? { label, value, ...(delta ? { delta } : {}), ...(t ? { tone: t } : {}) } : null;
  }).filter((k): k is MonthlyKpi => !!k);
  let table: MonthlyTable | undefined;
  if (r.table && typeof r.table === "object") {
    const t = r.table as Record<string, unknown>;
    const columns = (Array.isArray(t.columns) ? t.columns : []).slice(0, MONTHLY_MAX.tableCols).map((c) => str(c, 40));
    const rows = (Array.isArray(t.rows) ? t.rows : []).slice(0, MONTHLY_MAX.tableRows).map((row) => columns.map((_, j) => str(Array.isArray(row) ? row[j] : "", 80)));
    if (columns.length && rows.length) table = { columns, rows };
  }
  const creatives = (Array.isArray(r.creatives) ? r.creatives : []).map(sanitizeMonthlyCreative).filter((c): c is MonthlyCreative => !!c).slice(0, MONTHLY_MAX.creatives);
  return {
    id, kind, ...(platform ? { platform } : {}), title: str(r.title, 140) || MONTHLY_KIND_LABELS[kind],
    ...(kpis.length ? { kpis } : {}), ...(table ? { table } : {}), ...(kind === "creatives" ? { creatives } : {}), lists,
  };
}

/** What a card may keep of a monthly document (from the browser, a tool or storage). Null when it is not one. */
export function sanitizeMonthlyDoc(raw: unknown): MonthlyDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const clientId = /^[A-Za-z0-9_-]{1,40}$/.test(String(r.clientId ?? "")) ? String(r.clientId) : "";
  const clientName = str(r.clientName, 80);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(r.month ?? "")) ? String(r.month) : "";
  if (!clientId || !clientName || !month) return null;
  const p = r.period && typeof r.period === "object" ? (r.period as Record<string, unknown>) : {};
  const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : "");
  const range = monthRange(month);
  const seen = new Set<string>();
  const sections = (Array.isArray(r.sections) ? r.sections : []).slice(0, MONTHLY_MAX.sections).map(sanitizeSection).filter((s): s is MonthlySection => !!s)
    .map((s, i) => { let id = s.id; while (seen.has(id)) id = `${s.id.slice(0, 20)}-${i}`; seen.add(id); return { ...s, id }; });
  if (!sections.length) return null;
  const d = r.deck && typeof r.deck === "object" ? (r.deck as Record<string, unknown>) : null;
  const link = d ? str(d.link, 500) : "";
  return {
    clientId, clientName, month, period: { since: day(p.since) || range.since, until: day(p.until) || range.until },
    compareLabel: str(r.compareLabel, 80), context: str(r.context, 2000), nextDate: str(r.nextDate, 60), sections,
    ...(link && /^https:\/\/[^\s"'<>]+$/.test(link) ? { deck: { link, at: str(d!.at, 40) } } : {}),
  };
}

/** The figures a creative card of the monthly shows (HQ monthly-reproduction: the spend, the business KPI, CTR, hook rate — 3 or 4, never more). */
export function creativeFigures(metrics: Record<string, string>): Record<string, string> {
  const has = (k: string) => !!metrics[k] && metrics[k] !== "—";
  // One cost — the account's own (a lead account's CPA is its CPL: said once) —, then attention, then volumes.
  const cost = ["CPL", "Coût par achat", "CPA"].find(has);
  const order = ["Dépense", ...(cost ? [cost] : []), "ROAS", "CTR", "Hook rate", "Leads", "Achats", "Conversions"];
  const out: Record<string, string> = {};
  for (const k of order) { if (Object.keys(out).length >= 4) break; if (has(k)) out[k] = metrics[k]; }
  return out;
}

// ── Months ──────────────────────────────────────────────────────────────────
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const pad = (n: number) => String(n).padStart(2, "0");
/** « 2026-10 » → its first and last day. */
export function monthRange(month: string): { since: string; until: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { since: `${y}-${pad(m)}-01`, until: `${y}-${pad(m)}-${pad(last)}` };
}
export const previousMonth = (month: string): string => { const [y, m] = month.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`; };
/** « octobre 2026 » */
export const monthLabel = (month: string): string => { const [y, m] = month.split("-").map(Number); return `${MONTHS[m - 1] ?? "?"} ${y}`; };
export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** The month a monthly is about when none is named: the last complete one. */
export function lastCompleteMonth(today: string): string { return previousMonth(today.slice(0, 7)); }
/** A month as said or written (« octobre », « 2026-10 », « oct 2026 », « le mois dernier ») → « YYYY-MM », else null. */
export function parseMonth(raw: string, today: string): string | null {
  const t = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  if (!t) return null;
  const iso = /^(\d{4})-(\d{1,2})$/.exec(t);
  if (iso && +iso[2] >= 1 && +iso[2] <= 12) return `${iso[1]}-${pad(+iso[2])}`;
  if (/mois dernier|dernier mois/.test(t)) return lastCompleteMonth(today);
  if (/ce mois|mois en cours/.test(t)) return today.slice(0, 7);
  const names = MONTHS.map((m) => m.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
  // A month by its name, or by its first letters (« oct », « sept ») — three at least, and only one month may start so.
  let idx = -1;
  for (const w of t.split(/[^a-z]+/).filter((x) => x.length >= 3)) {
    const exact = names.indexOf(w);
    const starts = names.map((n, k) => (n.startsWith(w) ? k : -1)).filter((k) => k >= 0);
    idx = exact >= 0 ? exact : starts.length === 1 ? starts[0] : -1;
    if (idx >= 0) break;
  }
  if (idx < 0) return null;
  const year = /\b(20\d{2})\b/.exec(t)?.[1];
  if (year) return `${year}-${pad(idx + 1)}`;
  // No year said: the latest such month that is not in the future.
  const [ty, tm] = today.slice(0, 7).split("-").map(Number);
  return `${idx + 1 <= tm ? ty : ty - 1}-${pad(idx + 1)}`;
}

// ── Edits ───────────────────────────────────────────────────────────────────
/** What the consultant (or Mo, on request) changes on a monthly. One field per call is the usual; several are applied in this order. */
export interface MonthlyEdit {
  context?: string;
  nextDate?: string;
  title?: { section: string; value: string };
  /** A list replaced whole (the lines of its text area). */
  list?: { section: string; key: MonthlyListKey; items: string[] };
  /** A creative dropped in a « creatives » section (already resolved from the card it came from). */
  addCreative?: { section: string; creative: MonthlyCreative; at?: number };
  removeCreative?: { section: string; index: number };
  badge?: { section: string; index: number; badge: MonthlyBadge | null };
  moveCreative?: { section: string; from: number; to: number };
  removeSection?: string;
  deck?: { link: string; at: string } | null;
}

/** Applies an edit → the new document (always re-sanitized). Unknown sections and indexes are ignored. */
export function applyMonthlyEdit(doc: MonthlyDoc, edit: MonthlyEdit): MonthlyDoc {
  const next: MonthlyDoc = { ...doc, sections: doc.sections.map((s) => ({ ...s, lists: { ...s.lists }, ...(s.creatives ? { creatives: [...s.creatives] } : {}) })) };
  const find = (id: unknown) => next.sections.find((s) => s.id === id);
  if (typeof edit.context === "string") next.context = edit.context;
  if (typeof edit.nextDate === "string") next.nextDate = edit.nextDate;
  if (edit.title) { const s = find(edit.title.section); const v = str(edit.title.value, 140); if (s && v) s.title = v; }
  if (edit.list) { const s = find(edit.list.section); if (s && MONTHLY_LISTS[s.kind].includes(edit.list.key) && LIST_KEYS.includes(edit.list.key)) s.lists[edit.list.key] = lines(edit.list.items); }
  if (edit.addCreative) {
    const s = find(edit.addCreative.section); const c = sanitizeMonthlyCreative(edit.addCreative.creative);
    if (s && s.kind === "creatives" && c) {
      const list = s.creatives ?? [];
      // The same ad twice says nothing more: it moves instead.
      const same = list.findIndex((x) => (c.adId && x.adId === c.adId) || (c.assetId && x.assetId === c.assetId));
      const kept = same >= 0 ? list.filter((_, i) => i !== same) : list;
      const merged = same >= 0 && !c.badge && list[same].badge ? { ...c, badge: list[same].badge } : c;
      const at = Number.isInteger(edit.addCreative.at) ? Math.min(kept.length, Math.max(0, edit.addCreative.at!)) : kept.length;
      s.creatives = [...kept.slice(0, at), merged, ...kept.slice(at)].slice(0, MONTHLY_MAX.creatives);
    }
  }
  if (edit.removeCreative) { const s = find(edit.removeCreative.section); if (s?.creatives) s.creatives = s.creatives.filter((_, i) => i !== edit.removeCreative!.index); }
  if (edit.badge) { const s = find(edit.badge.section); const c = s?.creatives?.[edit.badge.index]; if (s?.creatives && c) { const { badge: _drop, ...rest } = c; void _drop; s.creatives[edit.badge.index] = edit.badge.badge ? { ...rest, badge: edit.badge.badge } : rest; } }
  if (edit.moveCreative) {
    const s = find(edit.moveCreative.section); const { from, to } = edit.moveCreative;
    if (s?.creatives && s.creatives[from] && Number.isInteger(to) && to >= 0 && to < s.creatives.length) { const list = [...s.creatives]; const [c] = list.splice(from, 1); list.splice(to, 0, c); s.creatives = list; }
  }
  if (typeof edit.removeSection === "string" && next.sections.length > 1) next.sections = next.sections.filter((s) => s.id !== edit.removeSection);
  if (edit.deck === null) delete next.deck; else if (edit.deck) next.deck = edit.deck;
  return sanitizeMonthlyDoc(next) ?? doc;
}

// ── The review before it goes out (HQ skill monthly-qa, the 8 recommendations of July 2026) ──────────────
export interface MonthlyCheck { level: "block" | "warn"; section?: string; message: string }
const PLACEHOLDER = /\[à (compl[ée]ter|valider)\]|\bxx ?%|#div\/0|lorem|à compl[ée]ter/i;
const hasFigure = (s: string) => /\d/.test(s);

/** Reads the document as the agency's review does. « block » = must be fixed before publishing; « warn » = the rule asks for better. */
export function monthlyChecks(doc: MonthlyDoc): MonthlyCheck[] {
  const out: MonthlyCheck[] = [];
  const ctx = doc.sections.find((s) => s.kind === "context");
  if (!doc.context.trim()) out.push({ level: "warn", message: "Contexte du mois vide : sans lui, les chiffres sont décrits au lieu d'être expliqués." });
  if (!ctx) out.push({ level: "warn", message: "Pas de slide de remise en contexte (recommandation n° 1)." });
  else if (!MONTHLY_LISTS.context.some((k) => (ctx.lists[k] ?? []).length)) out.push({ level: "warn", section: ctx.id, message: "Remise en contexte vide : enseignements précédents, actions du mois, ce qui reste à faire." });
  if (!doc.sections.some((s) => s.kind === "ytd")) out.push({ level: "warn", message: "Pas de vue depuis le début de l'année (recommandation n° 2)." });
  for (const s of doc.sections) {
    const label = s.title;
    if (s.title === MONTHLY_KIND_LABELS[s.kind] || /^(performances?|panorama|bilan|r[ée]sultats?|vue|d[ée]tail|cr[ée]as?|top cr[ée]as?)\b/i.test(s.title) && !hasFigure(s.title)) out.push({ level: "warn", section: s.id, message: `« ${label} » : un titre = un message, pas un thème (« En octobre, un CPL 13 % sous l'objectif »).` });
    const learnings = s.lists.learnings ?? []; const steps = s.lists.nextSteps ?? [];
    if (learnings.length > MONTHLY_RULES.learnings) out.push({ level: "warn", section: s.id, message: `« ${label} » : ${learnings.length} learnings, 3 au plus par slide.` });
    if (steps.length > MONTHLY_RULES.nextSteps) out.push({ level: "warn", section: s.id, message: `« ${label} » : ${steps.length} next steps, 3 au plus par slide.` });
    if (MONTHLY_LISTS[s.kind].includes("learnings") && s.kind !== "next" && !learnings.length) out.push({ level: "warn", section: s.id, message: `« ${label} » : aucun learning — commenter, ce n'est pas décrire.` });
    for (const key of MONTHLY_LISTS[s.kind]) for (const line of s.lists[key] ?? []) if (PLACEHOLDER.test(line)) out.push({ level: "block", section: s.id, message: `« ${label} » : il reste un texte à compléter (« ${line.slice(0, 50)} »).` });
    if (PLACEHOLDER.test(s.title)) out.push({ level: "block", section: s.id, message: `« ${label} » : le titre est à compléter.` });
    if (s.kind === "creatives") {
      const list = s.creatives ?? [];
      if (!list.length) out.push({ level: "warn", section: s.id, message: `« ${label} » : aucune créa — glisse-les depuis une carte de créas.` });
      const unjudged = list.filter((c) => !c.badge).length;
      if (unjudged) out.push({ level: "warn", section: s.id, message: `« ${label} » : ${unjudged} créa${unjudged > 1 ? "s" : ""} sans verdict (WINNER, À SURVEILLER, À COUPER).` });
      if (list.some((c) => !c.image)) out.push({ level: "warn", section: s.id, message: `« ${label} » : une créa n'a pas de visuel (elle sortira avec un cadre « visuel à ajouter »).` });
    }
  }
  const last = doc.sections.find((s) => s.kind === "next");
  if (!last || !(last.lists.nextSteps ?? []).length) out.push({ level: "warn", ...(last ? { section: last.id } : {}), message: "Pas de next steps en fin de deck : relier constat, problème et solution, avec une date." });
  if (last && !(last.lists.budget ?? []).length) out.push({ level: "warn", section: last.id, message: "Pas de recommandation de budget pour le mois prochain." });
  if (!doc.nextDate.trim()) out.push({ level: "warn", message: "Date du prochain monthly absente." });
  return out;
}

/** What Mo reads of a monthly card when the person talks about it: sections with their ids, what is written, what is missing. */
export function describeMonthly(doc: MonthlyDoc): string {
  const sec = doc.sections.map((s) => {
    const lists = MONTHLY_LISTS[s.kind].map((k) => `${k}: ${(s.lists[k] ?? []).length ? (s.lists[k] ?? []).map((l) => `« ${l.slice(0, 90)} »`).join(" ; ") : "(vide)"}`).join(" | ");
    const kpis = s.kpis?.length ? ` — chiffres : ${s.kpis.map((k) => `${k.label} ${k.value}${k.delta ? ` (${k.delta})` : ""}`).join(", ")}` : "";
    const table = s.table ? ` — tableau ${s.table.columns.join("/")} : ${s.table.rows.slice(0, 8).map((r) => r.join(" · ")).join(" ‖ ")}` : "";
    const creas = s.kind === "creatives" ? ` — créas : ${(s.creatives ?? []).map((c) => `${c.name}${c.badge ? ` [${MONTHLY_BADGES[c.badge].label}]` : ""} (${Object.entries(c.metrics).map(([k, v]) => `${k} ${v}`).join(", ")})`).join(" ; ") || "(aucune)"}` : "";
    return `  · section ${s.id} [${s.kind}${s.platform ? ` ${s.platform}` : ""}] titre « ${s.title} »${kpis}${table}${creas} — ${lists}`;
  });
  return `monthly ${doc.clientName} ${monthLabel(doc.month)} (${doc.compareLabel || "sans comparaison"}) ; contexte du consultant : ${doc.context ? `« ${doc.context.slice(0, 400)} »` : "(non renseigné)"} ; prochain monthly : ${doc.nextDate || "(non renseigné)"}\n${sec.join("\n")}`;
}
