/**
 * « Tests du labo » of a client dashboard (widget ab_tests): the creative tests
 * an agency runs as one ad set per test inside a test campaign (« … LABO »).
 * Pure: the rows come from the ad-level insights already read for the
 * dashboard; this file groups them, judges each test against the account and
 * writes the facts that follow. Client-safe (types + rules, no server import).
 *
 * Verdict of a test, against the cost per conversion of all the tests together
 * on the period (the tests are judged against each other; with fewer than 5
 * conversions in the tests, against the account's converting campaigns):
 *   - « trop tôt »   : fewer than 3 conversions and less than one and a half times that cost spent;
 *   - « marche » (winner) : 3 conversions or more, at the account's cost or under;
 *   - « ne marche pas » (loser) : enough spent, and a cost 30 % above the account's (or no conversion);
 *   - « dans la moyenne » : the rest.
 */

import { parseNamingTags } from "@/lib/ads-warehouse/naming";

export type TestVerdict = "winner" | "loser" | "average" | "early";

export const VERDICT_LABEL: Record<TestVerdict, string> = {
  winner: "Marche",
  loser: "Ne marche pas",
  average: "Dans la moyenne",
  early: "Trop tôt pour conclure",
};

export const AB_TESTS_DEFAULT_MATCH = "labo";
export const AB_TESTS_MIN_CONVERSIONS = 3;
/** Creatives shown per test (the most spending ones). */
export const AB_TESTS_ADS_SHOWN = 4;
const LOSER_FACTOR = 1.3;
/** Conversions the tests need together before they are judged against each other. */
const LABO_MIN_CONVERSIONS = 5;
const ENOUGH_SPEND_FACTOR = 1.5;

/** Share of the impressions (%) still watching at each quarter of the video. */
export interface VideoRetention { p25: number; p50: number; p75: number; p100: number }
/** Impressions a video needs before its hook is named in the facts. */
const RETENTION_MIN_IMPRESSIONS = 1000;

/**
 * What an ad name says about the creative, when the ads follow the agency's
 * naming convention (« …_sp-trek_th-hiver_pc-all_m-paysages_f-taglin_ho-… »).
 * Only these keys are read, in this order; the first two name a creative on a card.
 */
export const TAG_DIMENSIONS: Array<{ key: string; label: string }> = [
  { key: "m", label: "Angle" },
  { key: "f", label: "Mécanique" },
  { key: "ho", label: "Accroche" },
  { key: "sp", label: "Sport" },
  { key: "de", label: "Destination" },
  { key: "th", label: "Thème" },
  { key: "pc", label: "Cible" },
  { key: "co", label: "Concept" },
];
/** Abbreviations of the convention, spelled out for a client. Anything else is shown as written. */
const TAG_VALUES: Record<string, string> = {
  taglin: "Tagline", ben: "Bénéfice", testi: "Témoignage", probsol: "Problème / solution", list: "Liste", fomo: "Urgence (FOMO)",
  offer: "Offre", proof: "Preuve", disc: "Découverte", lastmin: "Dernière minute", lastminute: "Dernière minute", nouvelan: "Nouvel an",
  vscomp: "Comparaison", ditl: "Journée type", pov: "POV", facecam: "Face caméra", demo: "Démo", ugc: "UGC", earlybird: "Réservation anticipée", reveillon: "Réveillon",
  montblanc: "Mont-Blanc", capvert: "Cap-Vert", afriquedusud: "Afrique du Sud",
  experience: "Expérience", defi: "Défi", usp: "USP", voyageentrain: "Voyage en train", generique: "Générique",
  alpi: "Alpinisme", rando: "Randonnée", kite: "Kitesurf", multihiver: "Multi-activités hiver", debutant: "Débutant", ete: "Été", all: "Tous publics",
};
export interface AdTag { key: string; label: string; value: string }
const tagValue = (raw: string) => {
  const v = raw.split(" | ")[0].trim();
  const known = TAG_VALUES[v.toLowerCase()];
  return known ?? v.charAt(0).toUpperCase() + v.slice(1);
};
export function adTags(adName: string): AdTag[] {
  const tags = parseNamingTags(adName);
  return TAG_DIMENSIONS.flatMap((d) => (tags[d.key] ? [{ key: d.key, label: d.label, value: tagValue(tags[d.key]) }] : []));
}

/** One version of an ad's video: the same film cut for another placement. */
export interface VideoFormat { id: string; label: string; poster: string | null }
/** « Vertical 9:16 », « Carré 1:1 »… from the size of a frame. */
export function ratioLabel(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return "Vidéo";
  const r = height / width;
  if (r > 1.6) return "Vertical 9:16";
  if (r > 1.1) return "Portrait 4:5";
  if (r > 0.9) return "Carré 1:1";
  return "Paysage 16:9";
}

/** One ad over the period, already reduced to what the tests need. */
export interface TestAdRow {
  adId: string;
  adName: string;
  adsetId: string;
  adsetName: string;
  campaignName: string;
  spend: number;
  conversions: number;
  revenue: number;
  /** % */
  ctr: number;
  /** % of impressions that watched 3 s — 0 for an image */
  hookRate: number;
  video: boolean;
  imageUrl: string | null;
  impressions?: number;
  /** Videos only. */
  retention?: VideoRetention | null;
}

export interface TestAd {
  adId: string; name: string; imageUrl: string | null; video: boolean;
  spend: number; conversions: number; cpa: number; roas: number; ctr: number; hookRate: number;
  /** What its name says (angle, mechanic, hook…), [] off convention. */
  tags: AdTag[];
  /** Versions of its video, the tallest first — filled by the resolver for the videos shown. */
  formats: VideoFormat[];
  /** The creative alone against the same reference as its test. */
  verdict: TestVerdict;
  /** Videos with impressions only: the curve after the 3 s hook. */
  retention: VideoRetention | null;
  /** Best ad of its test (lowest cost per conversion, else most conversions). */
  best: boolean;
}

export interface AbTest {
  adsetId: string;
  name: string;
  campaign: string;
  spend: number;
  conversions: number;
  cpa: number;
  roas: number;
  verdict: TestVerdict;
  ads: TestAd[];
}

/** A line of the tables: a test, or a value of a naming dimension over the ads of the tests. */
export interface TestLine { id: string; name: string; ads: number; video: boolean; spend: number; conversions: number; cpa: number; roas: number; verdict: TestVerdict }
export interface TestBreakdown { key: string; label: string; lines: TestLine[] }
/** Values listed per dimension (the most spending). */
const BREAKDOWN_LINES = 12;

export interface AbTestsSummary {
  tests: AbTest[];
  /** Every test of the period, figures only (the table). */
  lines: TestLine[];
  /** The ads of the tests grouped by what their names say — only the dimensions that split them in 2 or more. */
  breakdowns: TestBreakdown[];
  /** Tests found before `limit`. */
  total: number;
  /** The account's converting campaigns over the period. */
  benchmark: { spend: number; conversions: number; cpa: number; roas: number };
  /** All the tests together, and the cost a test is judged against. */
  labo: { spend: number; conversions: number; cpa: number; reference: number; referenceIs: "labo" | "account" };
  counts: Record<TestVerdict, number>;
  /** Facts read from the figures, in French, ready to show. */
  facts: string[];
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const round2 = (n: number) => Math.round(n * 100) / 100;

/** « [Broad 22+ Labo Trek Pérou] - PUR - 7j clic 1j interactions » → « Trek Pérou ». */
export function testName(adsetName: string, match: string): string {
  const bracket = /\[([^\]]+)\]/.exec(adsetName)?.[1] ?? adsetName.split(/\s+-\s+/)[0];
  const m = norm(match);
  const at = m ? norm(bracket).lastIndexOf(m) : -1;
  const after = at >= 0 ? bracket.slice(at + match.length).trim() : "";
  return (after || bracket).replace(/\s+/g, " ").trim() || adsetName;
}

/** Is this ad part of a test: its campaign or its ad set carries the test marker. */
export function isTestRow(r: Pick<TestAdRow, "campaignName" | "adsetName">, match: string): boolean {
  const m = norm(match.trim() || AB_TESTS_DEFAULT_MATCH);
  return norm(r.campaignName).includes(m) || norm(r.adsetName).includes(m);
}

export function verdictOf(spend: number, conversions: number, benchmarkCpa: number): TestVerdict {
  if (!(benchmarkCpa > 0)) return "early";
  const enoughSpend = spend >= benchmarkCpa * ENOUGH_SPEND_FACTOR;
  if (conversions < AB_TESTS_MIN_CONVERSIONS && !enoughSpend) return "early";
  const cpa = conversions > 0 ? spend / conversions : Infinity;
  if (conversions >= AB_TESTS_MIN_CONVERSIONS && cpa <= benchmarkCpa) return "winner";
  if (cpa > benchmarkCpa * LOSER_FACTOR) return "loser";
  return "average";
}

const ORDER: Record<TestVerdict, number> = { winner: 0, average: 1, loser: 2, early: 3 };

export function summarizeTests(rows: TestAdRow[], opts: { match: string; limit: number; money: (n: number) => string }): AbTestsSummary {
  const all = rows.filter((r) => r.spend > 0);
  // Benchmark: the campaigns that do convert. A campaign bought for another goal
  // (traffic, leads, add to cart) spends without this conversion and would
  // inflate the account's cost until every test looks like a winner.
  const convByCampaign = new Map<string, number>();
  for (const r of all) convByCampaign.set(r.campaignName, (convByCampaign.get(r.campaignName) ?? 0) + r.conversions);
  const converting = all.filter((r) => (convByCampaign.get(r.campaignName) ?? 0) > 0);
  const bSpend = converting.reduce((s, r) => s + r.spend, 0);
  const bConv = converting.reduce((s, r) => s + r.conversions, 0);
  const bRev = converting.reduce((s, r) => s + r.revenue, 0);
  const benchmark = { spend: Math.round(bSpend), conversions: Math.round(bConv), cpa: bConv > 0 ? round2(bSpend / bConv) : 0, roas: bSpend > 0 ? round2(bRev / bSpend) : 0 };

  const byAdset = new Map<string, TestAdRow[]>();
  for (const r of all) {
    if (!isTestRow(r, opts.match)) continue;
    const list = byAdset.get(r.adsetId);
    if (list) list.push(r); else byAdset.set(r.adsetId, [r]);
  }

  const testRows = [...byAdset.values()].flat();
  const lSpend = testRows.reduce((s, r) => s + r.spend, 0);
  const lConv = testRows.reduce((s, r) => s + r.conversions, 0);
  const laboCpa = lConv > 0 ? round2(lSpend / lConv) : 0;
  const referenceIs = lConv >= LABO_MIN_CONVERSIONS ? "labo" as const : "account" as const;
  const reference = referenceIs === "labo" ? laboCpa : benchmark.cpa;
  const labo = { spend: Math.round(lSpend), conversions: Math.round(lConv), cpa: laboCpa, reference, referenceIs };

  const tests: AbTest[] = [...byAdset.entries()].map(([adsetId, list]) => {
    const spend = list.reduce((s, r) => s + r.spend, 0);
    const conversions = list.reduce((s, r) => s + r.conversions, 0);
    const revenue = list.reduce((s, r) => s + r.revenue, 0);
    const ads = list
      .map((r) => ({
        adId: r.adId, name: r.adName, imageUrl: r.imageUrl, video: r.video,
        spend: Math.round(r.spend), conversions: Math.round(r.conversions * 10) / 10,
        cpa: r.conversions > 0 ? round2(r.spend / r.conversions) : 0,
        roas: r.spend > 0 ? round2(r.revenue / r.spend) : 0,
        ctr: round2(r.ctr), hookRate: round2(r.hookRate),
        tags: adTags(r.adName), formats: [],
        verdict: verdictOf(r.spend, r.conversions, reference),
        retention: r.video && r.retention && r.hookRate > 0 ? r.retention : null, best: false,
      }))
      .sort((a, b) => b.spend - a.spend);
    // Best ad: a cost per conversion needs conversions; else nothing stands out.
    const withConv = ads.filter((a) => a.conversions > 0);
    const best = withConv.sort((a, b) => a.cpa - b.cpa || b.conversions - a.conversions)[0];
    if (best && ads.length > 1) best.best = true;
    return {
      adsetId,
      name: testName(list[0].adsetName, opts.match),
      campaign: list[0].campaignName,
      spend: Math.round(spend),
      conversions: Math.round(conversions * 10) / 10,
      cpa: conversions > 0 ? round2(spend / conversions) : 0,
      roas: spend > 0 ? round2(revenue / spend) : 0,
      verdict: verdictOf(spend, conversions, reference),
      ads,
    };
  }).sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || (a.verdict === "winner" ? a.cpa - b.cpa : b.spend - a.spend));

  const counts: Record<TestVerdict, number> = { winner: 0, loser: 0, average: 0, early: 0 };
  for (const t of tests) counts[t.verdict]++;
  // The tests shown: the first `limit`, and the video tests beyond (the videos are what a client asks to watch).
  const shown = [...tests.slice(0, opts.limit), ...tests.slice(opts.limit).filter((t) => t.ads.some((a) => a.video)).slice(0, opts.limit)];
  const lines: TestLine[] = tests.map((t) => ({ id: t.adsetId, name: t.name, ads: t.ads.length, video: t.ads.some((a) => a.video), spend: t.spend, conversions: t.conversions, cpa: t.cpa, roas: t.roas, verdict: t.verdict }));
  const tagsOf = new Map(testRows.map((r) => [r.adId, adTags(r.adName)]));
  const breakdowns: TestBreakdown[] = TAG_DIMENSIONS.filter((d) => d.key !== "co" && d.key !== "ho").flatMap((d) => {
    const groups = new Map<string, TestAdRow[]>();
    for (const r of testRows) {
      const v = tagsOf.get(r.adId)?.find((t) => t.key === d.key)?.value;
      if (!v) continue;
      const list = groups.get(v);
      if (list) list.push(r); else groups.set(v, [r]);
    }
    if (groups.size < 2) return [];
    const out = [...groups.entries()].map(([value, list]): TestLine => {
      const spend = list.reduce((s, r) => s + r.spend, 0);
      const conversions = list.reduce((s, r) => s + r.conversions, 0);
      const revenue = list.reduce((s, r) => s + r.revenue, 0);
      return {
        id: `${d.key}:${value}`, name: value, ads: list.length, video: list.some((r) => r.video), spend: Math.round(spend),
        conversions: Math.round(conversions * 10) / 10, cpa: conversions > 0 ? round2(spend / conversions) : 0, roas: spend > 0 ? round2(revenue / spend) : 0,
        verdict: verdictOf(spend, conversions, reference),
      };
    }).sort((a, b) => b.spend - a.spend).slice(0, BREAKDOWN_LINES);
    return [{ key: d.key, label: d.label, lines: out }];
  });
  return { tests: shown, lines, breakdowns, total: tests.length, benchmark, labo, counts, facts: testFacts(tests, testRows, benchmark, labo, counts, opts.money) };
}

function testFacts(tests: AbTest[], rows: TestAdRow[], benchmark: AbTestsSummary["benchmark"], labo: AbTestsSummary["labo"], counts: Record<TestVerdict, number>, money: (n: number) => string): string[] {
  if (!tests.length) return [];
  const out: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
  const spend = tests.reduce((s, t) => s + t.spend, 0);
  out.push(`${plural(tests.length, "test a dépensé", "tests ont dépensé")} ${money(spend)} sur la période : ${plural(counts.winner, "marche", "marchent")}, ${counts.average} dans la moyenne, ${plural(counts.loser, "ne marche pas", "ne marchent pas")}, ${counts.early} trop ${counts.early > 1 ? "récents" : "récent"} pour conclure.`);
  if (labo.referenceIs === "labo") out.push(`Repère : l'ensemble des tests est à ${money(labo.cpa)} par conversion${benchmark.cpa > 0 ? `, les campagnes du compte qui convertissent à ${money(benchmark.cpa)}` : ""}.`);
  else if (benchmark.cpa > 0) out.push(`Repère : les campagnes du compte qui convertissent sont à ${money(benchmark.cpa)} par conversion (trop peu de conversions dans les tests pour les comparer entre eux).`);
  const winners = tests.filter((t) => t.verdict === "winner");
  if (winners[0]) {
    const w = winners[0];
    const gap = labo.reference > 0 ? Math.round((1 - w.cpa / labo.reference) * 100) : 0;
    out.push(`Meilleur test : « ${w.name} », ${money(w.cpa)} par conversion sur ${w.conversions} conversions${gap > 0 ? `, soit ${gap} % sous le repère` : ""}.`);
  }
  const losers = tests.filter((t) => t.verdict === "loser").sort((a, b) => b.spend - a.spend);
  if (losers[0]) {
    const l = losers[0];
    out.push(`Test le plus coûteux sans résultat à la hauteur : « ${l.name} », ${money(l.spend)} dépensés pour ${l.conversions > 0 ? `${l.conversions} conversion${l.conversions > 1 ? "s" : ""} à ${money(l.cpa)}` : "aucune conversion"}.`);
  }
  // Video against image, when both formats carry enough conversions to compare.
  const fmt = (video: boolean) => {
    const list = rows.filter((r) => r.video === video);
    const s = list.reduce((a, r) => a + r.spend, 0);
    const c = list.reduce((a, r) => a + r.conversions, 0);
    return { conversions: c, cpa: c > 0 ? s / c : 0 };
  };
  const vid = fmt(true), img = fmt(false);
  if (vid.conversions >= AB_TESTS_MIN_CONVERSIONS && img.conversions >= AB_TESTS_MIN_CONVERSIONS) {
    const diff = Math.abs(vid.cpa - img.cpa) / Math.max(vid.cpa, img.cpa);
    if (diff >= 0.15) out.push(`Format : dans les tests, ${vid.cpa < img.cpa ? "la vidéo" : "l'image"} convertit moins cher (${money(Math.min(vid.cpa, img.cpa))} contre ${money(Math.max(vid.cpa, img.cpa))} par conversion).`);
    else out.push(`Format : vidéo et image font jeu égal dans les tests (${money(vid.cpa)} et ${money(img.cpa)} par conversion).`);
  }
  // Videos: how many impressions pass the 3 s hook, how many reach the end.
  const videos = rows.filter((r) => r.video && r.retention && (r.impressions ?? 0) > 0);
  const vImp = videos.reduce((a, r) => a + (r.impressions ?? 0), 0);
  if (vImp >= RETENTION_MIN_IMPRESSIONS) {
    const avg = (of: (r: TestAdRow) => number) => videos.reduce((a, r) => a + of(r) * (r.impressions ?? 0), 0) / vImp;
    const pct = (n: number) => `${(Math.round(n * 10) / 10).toLocaleString("fr-FR")} %`;
    const hook = avg((r) => r.hookRate);
    const top = videos.filter((r) => (r.impressions ?? 0) >= RETENTION_MIN_IMPRESSIONS).sort((a, b) => b.hookRate - a.hookRate)[0];
    out.push(`Vidéos des tests : ${pct(hook)} des impressions passent les 3 premières secondes, ${pct(avg((r) => r.retention!.p50))} arrivent à la moitié et ${pct(avg((r) => r.retention!.p100))} vont au bout${top && videos.length > 1 && top.hookRate > hook ? ` ; meilleure accroche : le test « ${tests.find((t) => t.adsetId === top.adsetId)?.name ?? top.adName} » (${pct(top.hookRate)})` : ""}.`);
  }
  return out;
}

/** Notes written for the client under the tests (widget config), bounded. */
export const AB_TESTS_LEARNINGS_CHARS = 4000;
