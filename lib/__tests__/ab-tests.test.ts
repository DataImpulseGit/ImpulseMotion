import { describe, expect, it } from "vitest";
import { adTags, ratioLabel, summarizeTests, testName, verdictOf, type TestAdRow } from "@/lib/ab-tests";

const money = (n: number) => `${Math.round(n)} €`;
const row = (adId: string, adset: string, spend: number, conversions: number, extra: Partial<TestAdRow> = {}): TestAdRow => ({
  adId, adName: `ad ${adId}`, adsetId: adset, adsetName: `[Broad 22+ Labo ${adset}] - PUR - 7j clic`, campaignName: "IA - [PUR - ACQ] - ABO - LABO",
  spend, conversions, revenue: conversions * 500, ctr: 1, hookRate: 0, video: false, imageUrl: null, ...extra,
});

describe("tests du labo", () => {
  it("nomme le test d'après son ensemble", () => {
    expect(testName("[Broad 22+ Labo Trek Pérou] - PUR - 7j clic 1j interactions", "labo")).toBe("Trek Pérou");
    expect(testName("[Broad 22+ Static Alpinisme ] - PUR", "labo")).toBe("Broad 22+ Static Alpinisme");
    expect(testName("Test hooks UGC - PUR", "labo")).toBe("Test hooks UGC");
  });

  it("juge un test contre le coût par conversion du compte", () => {
    expect(verdictOf(140, 1, 100)).toBe("early"); // peu dépensé, peu converti
    expect(verdictOf(240, 3, 100)).toBe("winner");
    expect(verdictOf(360, 3, 100)).toBe("average"); // 120, entre 100 et 130
    expect(verdictOf(450, 3, 100)).toBe("loser");
    expect(verdictOf(160, 0, 100)).toBe("loser"); // une fois et demie le repère dépensée, rien
    expect(verdictOf(250, 2, 100)).toBe("average"); // 125 : pas encore 3 conversions, mais dans la zone
    expect(verdictOf(500, 5, 0)).toBe("early"); // pas de repère
  });

  it("regroupe par ensemble, juge les tests entre eux, désigne la meilleure créa", () => {
    const rows = [
      row("1", "Trek", 300, 4, { video: true }), row("2", "Trek", 100, 1),
      row("3", "Yoga", 400, 0),
      row("4", "Neuf", 50, 0),
      row("5", "Ski", 420, 2),
      // hors labo : compte pour le repère du compte seulement
      { ...row("9", "Promos", 730, 3), campaignName: "IA - Promos", adsetName: "Broad" },
    ];
    const s = summarizeTests(rows, { match: "LABO", limit: 10, money });
    expect(s.benchmark).toMatchObject({ spend: 2000, conversions: 10, cpa: 200 });
    // 1270 € pour 7 conversions dans les tests
    expect(s.labo).toMatchObject({ spend: 1270, conversions: 7, cpa: 181.43, referenceIs: "labo" });
    expect(s.tests.map((t) => [t.name, t.verdict])).toEqual([["Trek", "winner"], ["Ski", "average"], ["Yoga", "loser"], ["Neuf", "early"]]);
    expect(s.tests[0]).toMatchObject({ spend: 400, conversions: 5, cpa: 80 });
    expect(s.tests[0].ads.map((a) => [a.adId, a.best])).toEqual([["1", true], ["2", false]]);
    expect(s.counts).toEqual({ winner: 1, loser: 1, average: 1, early: 1 });
    expect(s.facts[0]).toContain("4 tests ont dépensé 1270 €");
    expect(s.facts[1]).toBe("Repère : l'ensemble des tests est à 181 € par conversion, les campagnes du compte qui convertissent à 200 €.");
    expect(s.facts.join(" ")).toContain("« Trek », 80 € par conversion sur 5 conversions, soit 56 % sous le repère");
    expect(s.facts.join(" ")).toContain("« Yoga », 400 € dépensés pour aucune conversion");
  });

  it("trop peu de conversions dans les tests : jugés contre le compte", () => {
    const rows = [row("1", "Trek", 300, 3), { ...row("9", "Promos", 1000, 10), campaignName: "IA - Promos", adsetName: "Broad" }];
    const s = summarizeTests(rows, { match: "labo", limit: 10, money });
    expect(s.labo).toMatchObject({ referenceIs: "account", reference: 100 });
    expect(s.tests[0].verdict).toBe("winner"); // 100 € par conversion, au niveau du compte
    expect(s.facts[1]).toContain("trop peu de conversions dans les tests");
  });

  it("le repère ignore les campagnes qui ne visent pas cette conversion", () => {
    const rows = [
      row("1", "Trek", 400, 4),
      { ...row("8", "x", 1000, 0), campaignName: "IA - [ATC - ACQ] - Générique", adsetName: "Broad" },
      { ...row("9", "y", 600, 6), campaignName: "IA - Promos", adsetName: "Broad" },
    ];
    // 1000 / 10 = 100, pas 2000 / 10
    expect(summarizeTests(rows, { match: "labo", limit: 10, money }).benchmark).toMatchObject({ spend: 1000, conversions: 10, cpa: 100 });
  });

  it("compare vidéo et image seulement avec assez de conversions des deux côtés", () => {
    const s = summarizeTests([row("1", "A", 300, 6, { video: true }), row("2", "B", 600, 4)], { match: "labo", limit: 10, money });
    expect(s.facts.at(-1)).toBe("Format : dans les tests, la vidéo convertit moins cher (50 € contre 150 € par conversion).");
    const few = summarizeTests([row("1", "A", 300, 6, { video: true }), row("2", "B", 600, 1)], { match: "labo", limit: 10, money });
    expect(few.facts.some((f) => f.startsWith("Format"))).toBe(false);
  });

  it("sans test trouvé : rien, sans erreur", () => {
    const s = summarizeTests([{ ...row("9", "x", 100, 1), campaignName: "Promos", adsetName: "Broad" }], { match: "labo", limit: 10, money });
    expect(s.tests).toEqual([]);
    expect(s.facts).toEqual([]);
  });
  it("garde la rétention des vidéos et en tire un constat", () => {
    const r = (p25: number, p50: number, p75: number, p100: number) => ({ p25, p50, p75, p100 });
    const s = summarizeTests([
      row("1", "A", 300, 3, { video: true, adName: "Hook sommet", hookRate: 40, impressions: 3000, retention: r(20, 10, 6, 4) }),
      row("2", "A", 100, 1, { video: true, hookRate: 20, impressions: 1000, retention: r(10, 6, 3, 2) }),
      row("3", "A", 100, 1, { retention: r(0, 0, 0, 0), impressions: 5000 }), // image : pas de courbe
    ], { match: "labo", limit: 10, money });
    expect(s.tests[0].ads.map((a) => a.retention?.p100 ?? null)).toEqual([4, 2, null]);
    expect(s.facts.at(-1)).toBe("Vidéos des tests : 35 % des impressions passent les 3 premières secondes, 9 % arrivent à la moitié et 3,5 % vont au bout ; meilleure accroche : le test « A » (40 %).");
  });
  it("lit l'angle, la mécanique et l'accroche dans le nom d'une créa", () => {
    const name = "W47Y26_SGL_VID_b-brand_g-sport_sp-rando_th-hiver_pc-all_co-top3hiver_m-paysages_f-taglin_ho-vuereveil3h_lp-sport-neige_it-v1";
    expect(adTags(name).map((t) => `${t.label}=${t.value}`)).toEqual(["Angle=Paysages", "Mécanique=Tagline", "Accroche=Vuereveil3h", "Sport=Randonnée", "Thème=Hiver", "Cible=Tous publics", "Concept=Top3hiver"]);
    expect(adTags("Vidéo de Noël")).toEqual([]);
  });

  it("liste tous les tests et regroupe les créas par angle", () => {
    const n = (m: string, f: string) => `W1_SGL_IMG_b-brand_g-sport_m-${m}_f-${f}_it-v1`;
    const s = summarizeTests([
      row("1", "A", 200, 4, { adName: n("paysages", "taglin") }), row("2", "A", 100, 0, { adName: n("offre", "taglin") }),
      row("3", "B", 300, 1, { adName: n("offre", "ben") }), row("4", "C", 100, 1, { adName: n("paysages", "ben") }),
    ], { match: "labo", limit: 2, money });
    expect(s.tests).toHaveLength(2);
    expect(s.lines.map((l) => [l.name, l.ads, l.spend])).toEqual([["A", 2, 300], ["B", 1, 300], ["C", 1, 100]]);
    const angle = s.breakdowns.find((b) => b.key === "m")!;
    // 700 € pour 6 conversions : repère 116,67 €
    expect(angle.lines.map((l) => [l.name, l.ads, l.spend, l.conversions, l.verdict])).toEqual([["Offre", 2, 400, 1, "loser"], ["Paysages", 2, 300, 5, "winner"]]);
    expect(s.breakdowns.map((b) => b.label)).toEqual(["Angle", "Mécanique"]);
  });

  it("nomme le format d'une vidéo d'après sa taille", () => {
    expect([ratioLabel(1080, 1920), ratioLabel(1080, 1350), ratioLabel(2160, 2160), ratioLabel(3840, 2160), ratioLabel(0, 0)]).toEqual(["Vertical 9:16", "Portrait 4:5", "Carré 1:1", "Paysage 16:9", "Vidéo"]);
  });
});
