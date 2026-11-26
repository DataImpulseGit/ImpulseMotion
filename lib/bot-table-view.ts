/**
 * Reading aid for the tables of the client bot (components/bot/bot-table.tsx):
 * which cells are numbers, which column is « better when higher / lower », and
 * the tone (good / bad) of each cell. Pure — the model writes plain Markdown,
 * the colours are decided here, the same way for every reply.
 *
 * Two kinds of colour:
 *  - a change (« +12 % », « −8 % ») is good or bad by its sign and the metric
 *    it is about (a CPA that goes down is good); under 3 % it is stable;
 *  - an efficiency column (ROAS, CTR, CPA…) of at least three lines is read
 *    against its median: 15 % better → good, 15 % worse → bad.
 * Volumes (spend, impressions, purchases) are never ranked: a small budget is
 * not a bad line.
 */

export type Tone = "pos" | "neg" | null;
export type Direction = "up" | "down" | null;

export type ParsedCell = { value: number; delta: boolean } | null;

export type TableView = {
  /** Column holds numbers (right-aligned, sortable as numbers). */
  numeric: boolean[];
  /** Per row, per column. */
  tones: Tone[][];
  /** Rows « Total », « Moyenne »… : bold, kept at the bottom, never coloured by rank. */
  totals: boolean[];
  /** At least one cell coloured by rank: the legend is shown. */
  ranked: boolean;
  values: Array<Array<number | null>>;
};

const STABLE_PCT = 3;
const RANK_MARGIN = 0.15;
const RANK_MIN_ROWS = 3;

export function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
}

const DOWN = /\b(cpa|cpc|cpm|cpl|cpv|cac|cout (par|\/|du|d'un|de l')|cout\/|cost per|taux de rebond|rebond|bounce)/;
const NEUTRAL = /\b(depenses?|budget|spend|impressions?|frequence|portee|reach|couverture)\b/;
const UP_RATE = /\b(roas|mer|ctr|cvr|taux de (clics?|conv\w*|transfo\w*|retention|completion|engagement|lecture)|tx de conv\w*|hook|hold|retention|panier moyen|aov|marge)\b/;
const UP_VOLUME = /\b(ca|chiffre d'affaires|revenus?|ventes?|achats?|conversions?|conv\.?|leads?|commandes?|clics?|sessions?|valeur|reservations?|vues?|prospects?|inscriptions?|ajouts? au panier)\b/;
const DELTA_HEAD = /(evol|variation|\bvs\b|delta|Δ|ecart|progression|\bvar\b)/;

/** What a label is about: its good direction, and whether its values can be ranked against each other. */
export function metricDirection(label: string): { dir: Direction; rank: boolean } {
  const s = norm(label);
  if (!s) return { dir: null, rank: false };
  if (DOWN.test(s)) return { dir: "down", rank: true };
  if (UP_RATE.test(s)) return { dir: "up", rank: true };
  if (NEUTRAL.test(s)) return { dir: null, rank: false };
  if (UP_VOLUME.test(s)) return { dir: "up", rank: false };
  return { dir: null, rank: false };
}

const CELL = /^([+\-−–]?)\s*[x×]?\s*(\d[\d\s.,]*)\s*([kK]|M|Md)?\s*(€|\$|£|%|pts?|pp|x|×|eur|j|s|min|h)?$/i;

const LEADING_DELTA = /^([+\-−–]\s*\d[\d\s.,]*\s*(?:%|pts?|pp))(?=\s*[(:;,]|\s+(?:vs|par|sur)\b)/i;

/** « 1 234,5 € », « 12,3 % », « +12 % », « ×3,2 » → number ; anything else → null. */
export function parseCell(text: string): ParsedCell {
  const t = text.replace(/[  ]/g, " ").trim();
  if (!t) return null;
  let m = CELL.exec(t);
  if (!m) {
    // « +13 % (vs 459,45 €) » : a change followed by a remark is still a change.
    const lead = LEADING_DELTA.exec(t);
    if (!lead) return null;
    m = CELL.exec(lead[1]);
    if (!m) return null;
  }
  let digits = m[2].replace(/\s/g, "");
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Both: the last one is the decimal mark.
    digits = lastComma > lastDot ? digits.replace(/\./g, "").replace(",", ".") : digits.replace(/,/g, "");
  } else if (lastComma >= 0) {
    digits = digits.split(",").length > 2 ? digits.replace(/,/g, "") : digits.replace(",", ".");
  } else if (digits.split(".").length > 2) {
    digits = digits.replace(/\./g, "");
  }
  let value = Number(digits);
  if (!Number.isFinite(value)) return null;
  const mult = m[3];
  if (mult) value *= mult.toLowerCase() === "k" ? 1e3 : mult === "M" ? 1e6 : 1e9;
  const negative = m[1] !== "" && m[1] !== "+";
  if (negative) value = -value;
  const unit = (m[4] ?? "").toLowerCase();
  const delta = m[1] === "+" || (negative && (unit === "%" || unit.startsWith("pt") || unit === "pp"));
  return { value, delta };
}

const TOTAL_ROW = /^(total|totaux|ensemble|moyenne|global|tous|toutes|somme)\b/;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function buildTableView(headers: string[], rows: string[][]): TableView {
  const cols = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  const parsed = rows.map((r) => Array.from({ length: cols }, (_, c) => parseCell(r[c] ?? "")));
  const totals = rows.map((r) => TOTAL_ROW.test(norm(r[0] ?? "")));
  const tones: Tone[][] = rows.map(() => Array.from({ length: cols }, () => null));
  const numeric: boolean[] = [];
  const headDir = Array.from({ length: cols }, (_, c) => metricDirection(headers[c] ?? ""));
  const headIsDelta = Array.from({ length: cols }, (_, c) => DELTA_HEAD.test(norm(headers[c] ?? "")));
  let ranked = false;

  for (let c = 0; c < cols; c++) {
    const filled = rows.filter((r) => (r[c] ?? "").trim() !== "" && !/^[—–-]$/.test((r[c] ?? "").trim())).length;
    const nums = parsed.filter((p) => p[c]).length;
    numeric.push(c > 0 && nums > 0 && nums >= filled * 0.6);
  }

  // The metric a change is about: its own column, else the line's label, else the nearest value column on its left.
  const deltaDir = (r: number, c: number): Direction => {
    if (headDir[c].dir || NEUTRAL.test(norm(headers[c] ?? ""))) return headDir[c].dir;
    const row = metricDirection(rows[r][0] ?? "");
    if (row.dir || NEUTRAL.test(norm(rows[r][0] ?? ""))) return row.dir;
    for (let k = c - 1; k >= 1; k--) {
      if (headIsDelta[k]) continue;
      return headDir[k].dir;
    }
    return null;
  };

  for (let c = 1; c < cols; c++) {
    if (!numeric[c]) continue;
    const deltaCol = headIsDelta[c];
    // Changes: by sign.
    for (let r = 0; r < rows.length; r++) {
      const p = parsed[r][c];
      if (!p || !(p.delta || deltaCol)) continue;
      if (Math.abs(p.value) < STABLE_PCT) continue;
      const dir = deltaDir(r, c);
      if (!dir) continue;
      tones[r][c] = (p.value > 0) === (dir === "up") ? "pos" : "neg";
    }
    if (deltaCol || !headDir[c].rank) continue;
    // Efficiency column: against the median of the lines (totals aside).
    const dir = headDir[c].dir as "up" | "down";
    const pool: number[] = [];
    for (let r = 0; r < rows.length; r++) {
      const p = parsed[r][c];
      if (p && !p.delta && !totals[r] && !(dir === "down" && p.value === 0)) pool.push(p.value);
    }
    if (pool.length < RANK_MIN_ROWS) continue;
    const med = median(pool);
    if (!(med > 0)) continue;
    for (let r = 0; r < rows.length; r++) {
      const p = parsed[r][c];
      if (!p || p.delta || totals[r]) continue;
      // A cost of 0 is « no result », not a good cost.
      if (dir === "down" && p.value === 0) continue;
      const ratio = p.value / med;
      const better = dir === "up" ? ratio >= 1 + RANK_MARGIN : ratio <= 1 - RANK_MARGIN;
      const worse = dir === "up" ? ratio <= 1 - RANK_MARGIN : ratio >= 1 + RANK_MARGIN;
      if (better) { tones[r][c] = "pos"; ranked = true; }
      else if (worse) { tones[r][c] = "neg"; ranked = true; }
    }
  }

  return { numeric, tones, totals, ranked, values: parsed.map((r) => r.map((p) => (p ? p.value : null))) };
}

export type SortState = { col: number; dir: "asc" | "desc" } | null;

/** Row order for a sort: totals stay last, empty cells after the values. */
export function sortOrder(view: TableView, rows: string[][], sort: SortState): number[] {
  const idx = rows.map((_, i) => i);
  if (!sort) return idx;
  const { col, dir } = sort;
  const sign = dir === "asc" ? 1 : -1;
  const body = idx.filter((i) => !view.totals[i]);
  const tail = idx.filter((i) => view.totals[i]);
  body.sort((a, b) => {
    if (view.numeric[col]) {
      const va = view.values[a][col];
      const vb = view.values[b][col];
      if (va === null && vb === null) return a - b;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * sign || a - b;
    }
    return (rows[a][col] ?? "").localeCompare(rows[b][col] ?? "", "fr", { numeric: true, sensitivity: "base" }) * sign || a - b;
  });
  return [...body, ...tail];
}
