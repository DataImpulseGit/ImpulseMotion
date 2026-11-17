import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/ads-warehouse/query", async (orig) => ({ ...(await orig<typeof import("@/lib/ads-warehouse/query")>()), queryAds: vi.fn() }));
// The platforms are not called in tests: by default they do not answer (fallback on the warehouse).
const live = vi.fn();
vi.mock("@/lib/account-days", async (orig) => ({ ...(await orig<typeof import("@/lib/account-days")>()), liveAccountDays: (...a: unknown[]) => live(...a) }));
vi.mock("@/lib/kpi-cache", () => ({ cached: (_k: string, f: () => unknown) => f() }));
vi.mock("@/lib/meta-api", () => ({}));
vi.mock("@/lib/account-settings", () => ({}));
vi.mock("@/lib/ads-warehouse/meta", () => ({}));
vi.mock("@/lib/ads-warehouse/google", () => ({}));
vi.mock("@/lib/relay-tool", () => ({}));
const states = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { adSyncState: { findMany: (...a: unknown[]) => states(...a) } } }));
import { queryAds } from "@/lib/ads-warehouse/query";
import { buildBotAdsPack, imageUrl, window } from "@/lib/bot-ads-pack";
import { buildBotSystemPrompt } from "@/lib/bot-prompt";
import { calendarPeriods, sumDays, ZERO_SUMS } from "@/lib/account-days";
import { deriveMetrics } from "@/lib/ads-warehouse/query";

describe("bot ads pack", () => {
  it("window: last N complete days and the N before", () => {
    const w = window(7, new Date("2026-11-03T10:00:00Z"));
    expect(w.range).toEqual({ since: "2026-10-27", until: "2026-11-02" });
    expect(w.compare).toEqual({ since: "2026-10-20", until: "2026-10-26" });
  });
  it("image url is same-origin and scoped to the bot", () => {
    expect(imageUrl("bot1", "meta", "123")).toBe("/api/bot/bot1/image?ad=meta%3A123");
  });
  it("the pack sits after the sources and before the date", () => {
    const p = buildBotSystemPrompt({ bot: { name: "B", businessContext: "", sources: { meta: true } }, dashboard: { name: "D" }, adsPack: "CRÉAS ET PERFORMANCES PUBLICITAIRES test" });
    const i = p.indexOf("CRÉAS ET PERFORMANCES PUBLICITAIRES test");
    expect(i).toBeGreaterThan(0);
    expect(p.indexOf("CRÉAS ET PERFORMANCES", 0)).toBeGreaterThan(p.indexOf("MÉTHODE DE TRAVAIL"));
  });
});

const metrics = (spend: number, impressions: number) => ({ spend, impressions, ctr: 0.01, cpm: 5, hookRate: 0, conversions: 0, cpa: 0, roas: 0, roasUnavailable: true, conversionValue: 0, videoPlays: 0, estimated: false });
const result = (spend: number, impressions: number) => ({ currency: "EUR", rows: [], benchmark: metrics(spend, impressions), benchmarkPrevious: null });
const NOW = new Date("2026-11-05T10:00:00Z");
import { beforeEach } from "vitest";
beforeEach(() => { live.mockReset(); live.mockRejectedValue(new Error("pas de réponse")); });

describe("bot ads pack — données manquantes → recherche en direct", () => {
  it("compte absent de l'entrepôt → note ⚠ qui envoie vers l'outil Meta en direct", async () => {
    vi.mocked(queryAds).mockResolvedValue(result(0, 0) as never);
    states.mockResolvedValue([]);
    const t = await buildBotAdsPack("b-empty", { meta: "act_1" }, NOW);
    expect(t).toContain("### Meta Ads");
    expect(t).toContain("⚠ Meta Ads");
    expect(t).toContain("mcp__meta-ads-impulse__*");
  });
  it("entrepôt en retard → chiffres gardés + note ⚠ avec la date", async () => {
    vi.mocked(queryAds).mockResolvedValue(result(100, 5000) as never);
    states.mockResolvedValue([{ syncedTo: new Date("2026-11-01T00:00:00Z") }]);
    const t = await buildBotAdsPack("b-late", { meta: "1" }, NOW);
    expect(t).toContain("impressions 5");
    expect(t).toContain("à jour que jusqu'au 01/11");
  });
  it("impressions à zéro malgré la dépense → note ⚠", async () => {
    vi.mocked(queryAds).mockResolvedValue(result(100, 0) as never);
    states.mockResolvedValue([{ syncedTo: new Date("2026-11-04T00:00:00Z") }]);
    const t = await buildBotAdsPack("b-noimp", { meta: "1" }, NOW);
    expect(t).toContain("impressions absentes");
  });
  it("entrepôt à jour et complet → aucune note", async () => {
    vi.mocked(queryAds).mockResolvedValue(result(100, 5000) as never);
    states.mockResolvedValue([{ syncedTo: new Date("2026-11-04T00:00:00Z") }]);
    live.mockResolvedValue([{ ...ZERO_SUMS, date: "2026-11-04", spend: 100, impressions: 5000, clicks: 50, linkClicks: 50 }]);
    const t = await buildBotAdsPack("b-ok", { meta: "1" }, NOW);
    expect(t).not.toContain("⚠ Meta");
    expect(t).toContain("lus en direct sur Meta Ads");
  });
});

describe("bot ads pack — visuels", () => {
  it("demande toujours les visuels et donne le modèle d'adresse pour une créa trouvée en direct", async () => {
    vi.mocked(queryAds).mockResolvedValue(result(100, 5000) as never);
    states.mockResolvedValue([{ syncedTo: new Date("2026-11-04T00:00:00Z") }]);
    const t = await buildBotAdsPack("bot9", { meta: "1" }, NOW);
    expect(t).toContain("LES CLIENTS VEULENT VOIR LEURS CRÉAS");
    expect(t).toContain("/api/bot/bot9/image?ad=PLATEFORME%3AID");
  });
});

describe("bot ads pack — classement des meilleures créas", () => {
  const row = (id: string, spend: number, roas: number, conv: number) => ({
    key: id, label: `Créa ${id}`, adCount: 1, launch: "2026-10-01", trend: null, ads: [], previous: null,
    sample: { adId: id, platform: "meta", format: "Image", tags: {}, title: null, body: null, imageUrl: "https://x/y.jpg", thumbnailUrl: null, dynamic: false, videoId: null },
    metrics: { ...metrics(spend, 1000), roas, roasUnavailable: false, conversionValue: spend * roas, conversions: conv, cpa: conv ? spend / conv : 0, convertScore: 0 },
  });
  it("classe au ROAS et au CPA, écarte les petites dépenses, sans répéter une créa déjà détaillée", async () => {
    const rows = [row("a", 1000, 2, 10), row("b", 800, 5, 40), row("c", 600, 3, 30), row("d", 500, 1, 5), row("e", 400, 4, 8), row("f", 300, 2.5, 6), row("g", 200, 6, 20), row("tiny", 5, 50, 3)];
    vi.mocked(queryAds).mockResolvedValue({ currency: "EUR", rows, benchmark: metrics(3805, 9000), benchmarkPrevious: null } as never);
    states.mockResolvedValue([{ syncedTo: new Date("2026-11-04T00:00:00Z") }]);
    const t = await buildBotAdsPack("b-rank", { meta: "1" }, NOW);
    const roas = t.slice(t.indexOf("Meilleures créas sur 30 jours au ROAS"), t.indexOf("Meilleures créas sur 30 jours au coût"));
    expect(roas.split("\n")[1]).toContain("« Créa g »");
    expect(roas).not.toContain("Créa tiny");
    expect(roas).toContain("déjà détaillée plus haut");
    expect(t).toContain("au coût par conversion");
    expect(t).toContain("utilise DIRECTEMENT les classements");
  });
});

describe("bot ads pack — libellés des totaux (avis Decathlon Travel, 16/11/2026)", () => {
  const base = { spend: 11989, impressions: 2469329, reach: 0, frequency: 0, clicks: 54878, linkClicks: 28819, ctr: 1.17, ctrAll: 2.22, cpc: 0, cpm: 4.86, conversions: 136, cpa: 88.16, cvr: 0, conversionValue: 38973, roas: 3.25, aov: 0, purchases: 24, leads: 136, videoPlays: 0, video3s: 0, thruPlays: 0, hookRate: 0, holdRate: 0, p25Rate: 0, p50Rate: 0, p75Rate: 0, p100Rate: 0, hookScore: 0, watchScore: 0, clickScore: 0, convertScore: 0, estimated: false, roasUnavailable: false };

  it("compte Meta qui convertit en leads : achats et leads nommés séparément, jamais « conversions » à côté de la valeur", async () => {
    const { totalsLine, conversionKind } = await import("@/lib/bot-ads-pack");
    expect(conversionKind(base)).toBe("leads");
    const line = totalsLine(base, null, "EUR");
    expect(line).toMatch(/achats 24 · coût par achat 500/);
    expect(line).toMatch(/leads \(formulaires, pas des achats\) 136 · coût par lead 88,16/);
    expect(line).toContain("valeur des achats");
    expect(line).not.toMatch(/· conversions /);
    expect(line).toMatch(/CTR lien 1,2 %.*CTR tous clics 2,2 %/);
  });

  it("compte e-commerce : libellé inchangé", async () => {
    const { totalsLine, conversionKind } = await import("@/lib/bot-ads-pack");
    const m = { ...base, conversions: 24, leads: 0, cpa: 499.5 };
    expect(conversionKind(m)).toBe("purchases");
    expect(totalsLine(m, null, "EUR")).toMatch(/conversions 24 · CPA 500/);
  });

  it("Google : total du compte entier lu en direct (Performance Max comprise), écarts sur la même base", async () => {
    const { totalsLine } = await import("@/lib/bot-ads-pack");
    const g = (date: string, spend: number, impressions: number, clicks: number, conversions: number, value: number) => ({ ...ZERO_SUMS, date, spend, impressions, clicks, linkClicks: clicks, conversions, purchases: conversions, conversionValue: value, purchaseValue: value });
    const days = [g("2026-11-02", 16562.22, 593726, 24203, 26.08, 27899.3), g("2026-11-09", 14688.11, 525174, 26787, 24.4, 22872.65)];
    const cur = deriveMetrics(sumDays(days, { since: "2026-11-09", until: "2026-11-15" }), null);
    const prev = deriveMetrics(sumDays(days, { since: "2026-11-02", until: "2026-11-08" }), null);
    expect(cur.spend).toBe(14688.11);
    expect(cur.roas).toBe(1.56);
    const line = totalsLine(cur, prev, "EUR");
    expect(line).toMatch(/dépense 14\s688\s€ \(-11 %\)/);
    expect(line).toMatch(/ROAS 1,56 \(-7 %\)/);
  });

  it("Google sans réponse de la plateforme : le bloc dit que le total est partiel", async () => {
    vi.mocked(queryAds).mockResolvedValue(result(100, 5000) as never);
    states.mockResolvedValue([{ syncedTo: new Date("2026-11-04T00:00:00Z") }]);
    const t = await buildBotAdsPack("b-g", { google: "123" }, NOW);
    expect(t).toContain("PAS Performance Max");
  });

  it("le bloc donne la dépense hors annonces et les semaines calendaires quand la plateforme répond", async () => {
    vi.mocked(queryAds).mockResolvedValue(result(100, 5000) as never);
    states.mockResolvedValue([{ syncedTo: new Date("2026-11-04T00:00:00Z") }]);
    live.mockResolvedValue([{ ...ZERO_SUMS, date: "2026-11-01", spend: 80, impressions: 900 }, { ...ZERO_SUMS, date: "2026-11-04", spend: 150, impressions: 7000 }]);
    const t = await buildBotAdsPack("b-g2", { google: "124" }, NOW);
    expect(t).toContain("Dont campagnes sans annonces (Performance Max)");
    expect(t).toContain("Semaine du lundi 26/10 au dimanche 01/11");
    expect(t).toContain("Mois en cours, novembre 2026 (du 01/11 au 04/11)");
  });

  it("périodes calendaires : semaines lundi → dimanche, mois en cours vs mêmes jours du mois d'avant", () => {
    const p = calendarPeriods("2026-11-16");
    expect(p[0].range).toEqual({ since: "2026-11-09", until: "2026-11-15" });
    expect(p[0].compare).toEqual({ since: "2026-11-02", until: "2026-11-08" });
    expect(p[4].range).toEqual({ since: "2026-11-01", until: "2026-11-16" });
    expect(p[4].compare).toEqual({ since: "2026-10-01", until: "2026-10-16" });
    expect(p[5].range).toEqual({ since: "2026-10-01", until: "2026-10-31" });
    expect(p[5].compare).toEqual({ since: "2026-09-01", until: "2026-09-30" });
    // A Sunday is itself the end of the last complete week.
    expect(calendarPeriods("2026-11-15")[0].range.until).toBe("2026-11-15");
  });
});
