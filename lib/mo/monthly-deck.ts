/**
 * The monthly as a deck (.pptx, converted to Google Slides by Drive on upload),
 * in the agency's art direction as the HQ skill slides-impulse states it:
 * 13.33 × 7.5 in, titles Mulish bold blue 2CA6F9, body Open Sans 12 pt, blocks
 * « // LEARNINGS » (bullets on white) and « // NEXT STEPS » (arrows on a grey
 * band), native editable tables (dark header, thin lines), business deltas in
 * green / red, the source at the foot of every data slide — and the creative
 * cards of monthly-reproduction: badge, visual in its own ratio, short name,
 * a small table of 3-4 figures, four cards a row.
 *
 * What is not written yet goes out as « [À COMPLÉTER] » on yellow: the gap is
 * seen in the deck, never papered over.
 */

import PptxGenJS from "pptxgenjs";
import sharp from "sharp";
import {
  MONTHLY_BADGES, MONTHLY_KIND_LABELS, MONTHLY_LIST_LABELS, MONTHLY_RULES, PLATFORM_LABELS, capitalize, monthLabel,
  type MonthlyCreative, type MonthlyDoc, type MonthlyKpi, type MonthlyListKey, type MonthlySection, type MonthlyTable,
} from "@/lib/mo/monthly";

export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";

const C = { blue: "2CA6F9", ink: "1A1A2E", body: "3C4257", muted: "8E9AB3", line: "E8ECF2", soft: "F3F6FA", total: "F3F3F3", green: "6AA84F", red: "CC4125", yellow: "FFF2CC", white: "FFFFFF", violet: "7F5AFD" };
const TITLE_FONT = "Mulish"; const BODY_FONT = "Open Sans";
const W = 13.33; const H = 7.5; const MX = 0.55;
const TODO = "[À COMPLÉTER]";
/** Column titles of the context slide, short enough for one line. */
const CONTEXT_LABELS: Partial<Record<MonthlyListKey, string>> = { previous: "Enseignements précédents", done: "Mis en place ce mois-ci", todo: "Reste à mettre en place" };

type Slide = PptxGenJS.Slide;
type Run = PptxGenJS.TextProps;
export interface DeckImage { buf: Buffer; mimeType: string }
export type DeckImageLoader = (creative: MonthlyCreative) => Promise<DeckImage | null>;

const fmtDay = (iso: string) => new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${iso}T12:00:00Z`));
const toneColor = (k: MonthlyKpi) => (k.tone === "good" ? C.green : k.tone === "bad" ? C.red : C.muted);

/** A visual as the deck embeds it: JPEG, 1200 px at most, with its size (cards keep the ratio). */
async function prepare(img: DeckImage | null): Promise<{ data: string; w: number; h: number } | null> {
  if (!img) return null;
  try {
    const out = await sharp(img.buf).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
    return { data: `image/jpeg;base64,${out.data.toString("base64")}`, w: out.info.width, h: out.info.height };
  } catch { return null; }
}

function header(slide: Slide, title: string, channel?: string) {
  slide.background = { color: C.white };
  slide.addText(title, { x: MX, y: 0.32, w: W - 2 * MX - (channel ? 2.3 : 0), h: 0.85, fontFace: TITLE_FONT, bold: true, fontSize: 22, color: C.blue, valign: "middle", fit: "shrink", margin: 0 });
  if (channel) slide.addText(channel.toUpperCase(), { x: W - MX - 2.1, y: 0.5, w: 2.1, h: 0.36, fontFace: BODY_FONT, bold: true, fontSize: 10, color: C.white, align: "center", valign: "middle", fill: { color: C.ink }, shape: "roundRect", rectRadius: 0.18, margin: 0 });
  slide.addShape("line", { x: MX, y: 1.24, w: W - 2 * MX, h: 0, line: { color: C.line, width: 1 } });
}
function footer(slide: Slide, doc: MonthlyDoc, sources: string, page: number) {
  slide.addText(`Source : ${sources} - du ${fmtDay(doc.period.since)} au ${fmtDay(doc.period.until)}${doc.compareLabel ? `, ${doc.compareLabel}` : ""}`, { x: MX, y: H - 0.42, w: W - 2 * MX - 1, h: 0.25, fontFace: BODY_FONT, fontSize: 7, color: C.muted, margin: 0 });
  slide.addText(String(page), { x: W - MX - 0.6, y: H - 0.42, w: 0.6, h: 0.25, fontFace: BODY_FONT, fontSize: 8, color: C.muted, align: "right", margin: 0 });
}

/** A list block: label « // LEARNINGS », then bullets (white) or arrows (grey band). Empty → the yellow « à compléter ». */
function listBlock(slide: Slide, label: string, items: string[], box: { x: number; y: number; w: number; h: number }, style: "bullets" | "arrows") {
  const band = style === "arrows";
  if (band) slide.addShape("roundRect", { x: box.x, y: box.y, w: box.w, h: box.h, fill: { color: C.soft }, line: { color: C.soft, width: 0 }, rectRadius: 0.08 });
  const pad = band ? 0.18 : 0;
  slide.addText(`// ${label.toUpperCase()}`, { x: box.x + pad, y: box.y + (band ? 0.1 : 0), w: box.w - 2 * pad, h: 0.3, fontFace: BODY_FONT, bold: true, fontSize: 11, color: C.ink, margin: 0 });
  const runs: Run[] = items.length
    ? items.map((t) => (band
        ? { text: `→  ${t}`, options: { breakLine: true, paraSpaceAfter: 6 } }
        : { text: t, options: { bullet: { characterCode: "25CF" }, breakLine: true, paraSpaceAfter: 6 } }))
    : [{ text: TODO, options: { highlight: C.yellow, color: C.ink } }];
  slide.addText(runs, { x: box.x + pad, y: box.y + (band ? 0.42 : 0.34), w: box.w - 2 * pad, h: Math.max(0.4, box.h - (band ? 0.52 : 0.34)), fontFace: BODY_FONT, fontSize: 12, color: C.body, valign: "top", margin: 0, fit: "shrink" });
}

/** KPI tiles in a row: label, value, change coloured by what it means for the business. */
function kpiRow(slide: Slide, kpis: MonthlyKpi[], y: number, h = 1.15) {
  const list = kpis.slice(0, 6);
  if (!list.length) return;
  const gap = 0.18; const w = (W - 2 * MX - gap * (list.length - 1)) / list.length;
  list.forEach((k, i) => {
    const x = MX + i * (w + gap);
    slide.addShape("roundRect", { x, y, w, h, fill: { color: C.soft }, line: { color: C.soft, width: 0 }, rectRadius: 0.08 });
    slide.addText(k.label.toUpperCase(), { x: x + 0.14, y: y + 0.1, w: w - 0.28, h: 0.26, fontFace: BODY_FONT, bold: true, fontSize: 9, color: C.muted, margin: 0, fit: "shrink" });
    slide.addText(k.value, { x: x + 0.14, y: y + 0.36, w: w - 0.28, h: 0.44, fontFace: TITLE_FONT, bold: true, fontSize: 20, color: C.ink, margin: 0, fit: "shrink" });
    if (k.delta) slide.addText(k.delta, { x: x + 0.14, y: y + 0.82, w: w - 0.28, h: 0.24, fontFace: BODY_FONT, bold: true, fontSize: 10, color: toneColor(k), margin: 0 });
  });
}

/** A native table: dark header in capitals, thin horizontal lines, figures on the right, first column on the left. */
function table(slide: Slide, t: MonthlyTable, box: { x: number; y: number; w: number; h: number }) {
  // Each column as wide as what it holds (its longest cell or its title), so a figure and its change stay on one line.
  const longest = t.columns.map((c, j) => Math.max(c.length * 1.05, ...t.rows.map((r) => (r[j] ?? "").length)));
  const weights = longest.map((n, j) => Math.min(j === 0 ? 30 : 22, Math.max(j === 0 ? 14 : 9, n * 1.1)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const colW = weights.map((n) => (box.w * n) / sum);
  // Characters that fit in the narrowest column decide the size of the text.
  const tight = Math.min(...colW.map((w, j) => w / Math.max(1, longest[j])));
  const size = tight < 0.075 ? 8 : tight < 0.09 ? 9 : t.rows.length > 9 ? 9 : t.rows.length > 6 ? 10 : 11;
  const border = { type: "solid" as const, color: C.line, pt: 0.75 }; const none = { type: "none" as const };
  const head = t.columns.map((c, j) => ({ text: c.toUpperCase(), options: { bold: true, color: C.white, fill: { color: C.ink }, fontSize: size <= 8 ? 7 : size <= 9 ? 8 : 9, align: j === 0 ? "left" as const : "right" as const, border: [none, none, none, none] as [typeof none, typeof none, typeof none, typeof none] } }));
  const body = t.rows.map((row) => {
    const total = /^total\b/i.test(row[0] ?? "");
    return row.map((cell, j) => ({ text: cell || "—", options: { fontSize: size, bold: total || undefined, color: j === 0 ? C.ink : C.body, align: j === 0 ? "left" as const : "right" as const, ...(total ? { fill: { color: C.total } } : {}), border: [none, none, border, none] as [typeof none, typeof none, typeof border, typeof none] } }));
  });
  const rowH = Math.min(0.42, Math.max(0.26, (box.h - 0.36) / Math.max(1, t.rows.length)));
  slide.addTable([head, ...body], { x: box.x, y: box.y, w: box.w, colW, rowH: [0.36, ...t.rows.map(() => rowH)], fontFace: BODY_FONT, valign: "middle", margin: [0.03, 0.08, 0.03, 0.08] });
}

/** One creative card: badge, visual in its ratio (or the « visuel à ajouter » frame), short name, 3-4 figures. */
function creativeCard(slide: Slide, c: MonthlyCreative, img: { data: string; w: number; h: number } | null, box: { x: number; y: number; w: number; h: number }) {
  slide.addShape("roundRect", { x: box.x, y: box.y, w: box.w, h: box.h, fill: { color: C.white }, line: { color: C.line, width: 1 }, rectRadius: 0.06 });
  const badge = c.badge ? MONTHLY_BADGES[c.badge] : null;
  slide.addText(badge ? badge.label : "VERDICT À DONNER", { x: box.x + 0.12, y: box.y + 0.12, w: Math.min(box.w - 0.24, badge ? 1.7 : 1.9), h: 0.28, fontFace: BODY_FONT, bold: true, fontSize: 9, color: badge ? C.white : C.ink, align: "center", valign: "middle", fill: { color: badge ? badge.hex : C.yellow }, shape: "roundRect", rectRadius: 0.14, margin: 0 });
  const metrics = Object.entries(c.metrics).slice(0, 4);
  const tableH = 0.3 * metrics.length; const nameH = 0.36;
  const area = { x: box.x + 0.12, y: box.y + 0.5, w: box.w - 0.24, h: box.h - 0.5 - nameH - tableH - 0.2 };
  if (img) {
    const k = Math.min(area.w / img.w, area.h / img.h); const w = img.w * k; const h = img.h * k;
    slide.addImage({ data: img.data, x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h });
  } else {
    slide.addText("[VISUEL À AJOUTER]", { x: area.x, y: area.y, w: area.w, h: area.h, fontFace: BODY_FONT, bold: true, fontSize: 10, color: C.ink, align: "center", valign: "middle", fill: { color: C.yellow }, margin: 0 });
  }
  slide.addText(c.name, { x: box.x + 0.12, y: area.y + area.h + 0.04, w: box.w - 0.24, h: nameH, fontFace: BODY_FONT, bold: true, fontSize: 10, color: C.ink, valign: "middle", margin: 0, fit: "shrink" });
  if (metrics.length) {
    const border = { type: "solid" as const, color: C.line, pt: 0.75 }; const none = { type: "none" as const };
    slide.addTable(metrics.map(([k, v]) => [
      { text: k, options: { color: C.muted, fontSize: 9, align: "left" as const, border: [border, none, none, none] as [typeof border, typeof none, typeof none, typeof none] } },
      { text: v, options: { color: C.ink, bold: true, fontSize: 10, align: "right" as const, border: [border, none, none, none] as [typeof border, typeof none, typeof none, typeof none] } },
    ]), { x: box.x + 0.12, y: box.y + box.h - tableH - 0.1, w: box.w - 0.24, colW: [(box.w - 0.24) * 0.5, (box.w - 0.24) * 0.5], rowH: metrics.map(() => 0.3), fontFace: BODY_FONT, valign: "middle", margin: [0.02, 0.04, 0.02, 0.04] });
  }
}

const listOf = (s: MonthlySection, key: MonthlyListKey) => s.lists[key] ?? [];
const chunk = <T,>(list: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

/** The deck of a monthly document → .pptx bytes. `loadImage` gives the bytes of a creative's visual (null = the yellow frame). */
export async function buildMonthlyDeck(doc: MonthlyDoc, loadImage: DeckImageLoader): Promise<{ pptx: Buffer; slides: number; missingVisuals: number }> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Impulse Analytics"; pptx.company = "Impulse Analytics";
  pptx.title = `${doc.clientName} - Monthly ${capitalize(monthLabel(doc.month))}`;
  const channels = [...new Set(doc.sections.map((s) => s.platform).filter((p): p is string => !!p))];
  const sources = channels.map((p) => PLATFORM_LABELS[p] ?? p).join(", ") || "plateformes publicitaires";
  let page = 0; let missingVisuals = 0;
  const next = () => { page++; return pptx.addSlide(); };

  // 1. Cover
  { const s = next(); s.background = { color: C.ink };
    s.addShape("rect", { x: 0, y: 0, w: 0.28, h: H, fill: { color: C.blue }, line: { color: C.blue, width: 0 } });
    s.addText("MONTHLY REPORT", { x: 1, y: 2.3, w: W - 2, h: 1, fontFace: TITLE_FONT, bold: true, fontSize: 44, color: C.white, margin: 0 });
    s.addText(doc.clientName, { x: 1, y: 3.35, w: W - 2, h: 0.7, fontFace: TITLE_FONT, bold: true, fontSize: 28, color: C.blue, margin: 0 });
    s.addText(capitalize(monthLabel(doc.month)), { x: 1, y: 4.05, w: W - 2, h: 0.5, fontFace: BODY_FONT, fontSize: 16, color: C.white, margin: 0 });
    s.addText("Impulse Analytics", { x: 1, y: H - 1, w: W - 2, h: 0.35, fontFace: BODY_FONT, fontSize: 11, color: C.muted, margin: 0 }); }

  // 2. Agenda: one pill per part, in the order of the deck
  { const s = next(); header(s, "Agenda of the day");
    const parts: string[] = [];
    for (const sec of doc.sections) { const label = sec.kind === "channel" || sec.kind === "creatives" ? (PLATFORM_LABELS[sec.platform ?? ""] ?? MONTHLY_KIND_LABELS[sec.kind]) : MONTHLY_KIND_LABELS[sec.kind]; if (!parts.includes(label)) parts.push(label); }
    parts.slice(0, 8).forEach((label, i) => {
      const y = 1.6 + i * 0.66;
      s.addText(String(i + 1), { x: MX, y, w: 0.5, h: 0.5, fontFace: TITLE_FONT, bold: true, fontSize: 14, color: C.white, align: "center", valign: "middle", fill: { color: C.blue }, shape: "ellipse", margin: 0 });
      s.addText(label, { x: MX + 0.7, y, w: W - 2 * MX - 0.7, h: 0.5, fontFace: BODY_FONT, bold: true, fontSize: 14, color: C.ink, valign: "middle", fill: { color: C.soft }, shape: "roundRect", rectRadius: 0.25, margin: [0, 0.2, 0, 0.2] });
    }); }

  for (const sec of doc.sections) {
    const channel = sec.platform ? PLATFORM_LABELS[sec.platform] ?? sec.platform : undefined;
    if (sec.kind === "context") {
      const s = next(); header(s, sec.title);
      const keys: MonthlyListKey[] = ["previous", "done", "todo"]; const gap = 0.25; const w = (W - 2 * MX - 2 * gap) / 3;
      keys.forEach((key, i) => {
        const x = MX + i * (w + gap);
        s.addShape("roundRect", { x, y: 1.5, w, h: 5.2, fill: { color: C.soft }, line: { color: C.soft, width: 0 }, rectRadius: 0.08 });
        listBlock(s, CONTEXT_LABELS[key] ?? MONTHLY_LIST_LABELS[key], listOf(sec, key), { x: x + 0.2, y: 1.68, w: w - 0.4, h: 4.85 }, "bullets");
      });
      footer(s, doc, sources, page);
    } else if (sec.kind === "overview" || sec.kind === "ytd" || sec.kind === "channel") {
      const s = next(); header(s, sec.title, channel);
      const hasKpis = !!sec.kpis?.length;
      if (hasKpis) kpiRow(s, sec.kpis!, 1.45);
      const top = hasKpis ? 2.85 : 1.5; const bottom = H - 0.6;
      const steps = sec.kind === "channel";
      const rightW = sec.table ? (sec.table.columns.length >= 6 ? 3.9 : 4.6) : W - 2 * MX; const rightX = sec.table ? W - MX - rightW : MX;
      if (sec.table) table(s, sec.table, { x: MX, y: top, w: W - 2 * MX - rightW - 0.35, h: bottom - top });
      const learnH = steps ? (bottom - top) * 0.52 : bottom - top;
      listBlock(s, "Learnings", listOf(sec, "learnings").slice(0, MONTHLY_RULES.learnings + 1), { x: rightX, y: top, w: rightW, h: learnH - 0.1 }, "bullets");
      if (steps) listBlock(s, "Next steps", listOf(sec, "nextSteps").slice(0, MONTHLY_RULES.nextSteps + 1), { x: rightX, y: top + learnH, w: rightW, h: bottom - top - learnH }, "arrows");
      footer(s, doc, sec.kind === "channel" && channel ? channel : sources, page);
    } else if (sec.kind === "creatives") {
      const groups = chunk(sec.creatives ?? [], MONTHLY_RULES.creativesPerSlide);
      const pages = groups.length ? groups : [[]];
      for (let g = 0; g < pages.length; g++) {
        const s = next(); header(s, pages.length > 1 ? `${sec.title} (${g + 1}/${pages.length})` : sec.title, channel);
        // The messages go with the last page of cards; a page of cards alone gives them the height.
        const withText = g === pages.length - 1;
        const list = pages[g]; const gap = 0.22; const cardW = (W - 2 * MX - gap * 3) / 4; const cardY = 1.45; const cardH = withText ? 3.75 : 5.3;
        const offset = (W - 2 * MX - (list.length * cardW + Math.max(0, list.length - 1) * gap)) / 2;
        const images = await Promise.all(list.map((c) => loadImage(c).catch(() => null).then(prepare)));
        list.forEach((c, i) => { if (!images[i]) missingVisuals++; creativeCard(s, c, images[i], { x: MX + offset + i * (cardW + gap), y: cardY, w: cardW, h: cardH }); });
        if (!list.length) s.addText("[CRÉAS À AJOUTER]", { x: MX, y: cardY, w: W - 2 * MX, h: cardH, fontFace: BODY_FONT, bold: true, fontSize: 14, color: C.ink, align: "center", valign: "middle", fill: { color: C.yellow }, margin: 0 });
        const y = cardY + cardH + 0.2; const h = H - 0.6 - y; const half = (W - 2 * MX - 0.3) / 2;
        if (withText) {
          listBlock(s, "Learnings", listOf(sec, "learnings").slice(0, MONTHLY_RULES.learnings + 1), { x: MX, y, w: half, h }, "bullets");
          listBlock(s, "Next steps", listOf(sec, "nextSteps").slice(0, MONTHLY_RULES.nextSteps + 1), { x: MX + half + 0.3, y, w: half, h }, "arrows");
        }
        footer(s, doc, channel ?? sources, page);
      }
    } else if (sec.kind === "next") {
      const s = next(); header(s, sec.title);
      const half = (W - 2 * MX - 0.4) / 2;
      listBlock(s, MONTHLY_LIST_LABELS.budget, listOf(sec, "budget"), { x: MX, y: 1.55, w: half, h: 4.4 }, "bullets");
      listBlock(s, "Next steps", listOf(sec, "nextSteps"), { x: MX + half + 0.4, y: 1.55, w: half, h: 4.4 }, "arrows");
      s.addText([{ text: "Prochain monthly : ", options: { bold: true, color: C.ink } }, doc.nextDate ? { text: doc.nextDate, options: { color: C.blue, bold: true } } : { text: TODO, options: { highlight: C.yellow, color: C.ink } }], { x: MX, y: 6.15, w: W - 2 * MX, h: 0.45, fontFace: BODY_FONT, fontSize: 13, valign: "middle", fill: { color: C.soft }, shape: "roundRect", rectRadius: 0.2, margin: [0, 0.25, 0, 0.25] });
      footer(s, doc, sources, page);
    }
  }
  const out = await pptx.write({ outputType: "nodebuffer" });
  return { pptx: Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer), slides: page, missingVisuals };
}

/** « Naturalia - Monthly Octobre 2026 » — the convention of the HQ skill monthly-reproduction. */
export const monthlyDeckName = (doc: MonthlyDoc): string => `${doc.clientName} - Monthly ${capitalize(monthLabel(doc.month))}`;
