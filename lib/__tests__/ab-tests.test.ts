import { describe, expect, it } from "vitest";
import { summarizeTests, testName, verdictOf, type TestAdRow } from "@/lib/ab-tests";

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
});
