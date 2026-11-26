import { describe, expect, it } from "vitest";
import { buildTableView, metricDirection, parseCell, sortOrder } from "@/lib/bot-table-view";

describe("parseCell", () => {
  it("lit les nombres à la française", () => {
    expect(parseCell("1 234,5 €")).toEqual({ value: 1234.5, delta: false });
    expect(parseCell("12,3 %")).toEqual({ value: 12.3, delta: false });
    expect(parseCell("×3,2")).toEqual({ value: 3.2, delta: false });
    expect(parseCell("1.234,50")).toEqual({ value: 1234.5, delta: false });
    expect(parseCell("12k")).toEqual({ value: 12000, delta: false });
  });
  it("reconnaît une évolution à son signe", () => {
    expect(parseCell("+12 %")).toEqual({ value: 12, delta: true });
    expect(parseCell("−8 %")).toEqual({ value: -8, delta: true });
    expect(parseCell("-2,5 pts")).toEqual({ value: -2.5, delta: true });
  });
  it("laisse le texte tranquille", () => {
    expect(parseCell("Campagne 2026")).toBeNull();
    expect(parseCell("—")).toBeNull();
    expect(parseCell("")).toBeNull();
    expect(parseCell("12 au 18 nov.")).toBeNull();
  });
});

describe("metricDirection", () => {
  it("coûts : plus bas = mieux", () => {
    expect(metricDirection("CPA")).toEqual({ dir: "down", rank: true });
    expect(metricDirection("Coût par achat")).toEqual({ dir: "down", rank: true });
  });
  it("taux et ROAS : plus haut = mieux", () => {
    expect(metricDirection("ROAS")).toEqual({ dir: "up", rank: true });
    expect(metricDirection("Taux de conversion")).toEqual({ dir: "up", rank: true });
  });
  it("volumes : un sens, mais pas de classement ; dépense : neutre", () => {
    expect(metricDirection("Achats")).toEqual({ dir: "up", rank: false });
    expect(metricDirection("Dépense")).toEqual({ dir: null, rank: false });
    expect(metricDirection("Coût")).toEqual({ dir: null, rank: false });
    expect(metricDirection("Campagne")).toEqual({ dir: null, rank: false });
  });
});

describe("buildTableView", () => {
  const headers = ["Campagne", "Dépense", "Achats", "CPA", "ROAS"];
  const rows = [
    ["Promos", "1 000 €", "50", "20 €", "5,0"],
    ["Générique", "800 €", "20", "40 €", "2,5"],
    ["Labo", "500 €", "5", "100 €", "1,0"],
    ["Sans vente", "50 €", "0", "0 €", "0"],
    ["Total", "2 350 €", "75", "31 €", "3,4"],
  ];
  const v = buildTableView(headers, rows);

  it("colonnes de chiffres alignées, la première reste du texte", () => {
    expect(v.numeric).toEqual([false, true, true, true, true]);
  });
  it("classe les colonnes d'efficacité contre la médiane, pas les volumes", () => {
    expect(v.tones[0]).toEqual([null, null, null, "pos", "pos"]);
    expect(v.tones[2]).toEqual([null, null, null, "neg", "neg"]);
    expect(v.tones[1][3]).toBeNull();
    expect(v.ranked).toBe(true);
  });
  it("un coût à 0 n'est pas un bon coût ; un ROAS à 0 est mauvais", () => {
    expect(v.tones[3][3]).toBeNull();
    expect(v.tones[3][4]).toBe("neg");
  });
  it("la ligne Total n'est jamais classée", () => {
    expect(v.totals).toEqual([false, false, false, false, true]);
    expect(v.tones[4]).toEqual([null, null, null, null, null]);
  });

  it("évolutions : le sens dépend de l'indicateur de la colonne voisine", () => {
    const t = buildTableView(
      ["Campagne", "Dépense", "Évol.", "CPA", "Évol.", "ROAS", "vs S-1"],
      [["A", "100 €", "+20 %", "30 €", "+12 %", "3,1", "−10 %"], ["B", "90 €", "−5 %", "22 €", "−9 %", "4,0", "+2 %"]],
    );
    expect(t.tones[0]).toEqual([null, null, null, null, "neg", null, "neg"]);
    expect(t.tones[1]).toEqual([null, null, null, null, "pos", null, null]);
    expect(t.ranked).toBe(false);
  });

  it("indicateurs en lignes : le sens vient du libellé de la ligne", () => {
    const t = buildTableView(
      ["Indicateur", "Cette semaine", "Semaine précédente", "Évolution"],
      [["Dépense", "1 200 €", "1 000 €", "+20 %"], ["CPA", "25 €", "20 €", "+25 %"], ["ROAS", "4,2", "3,5", "+20 %"], ["Achats", "48", "50", "−4 %"]],
    );
    expect(t.tones.map((r) => r[3])).toEqual([null, "neg", "pos", "neg"]);
  });

  it("moins de trois lignes : pas de classement", () => {
    const t = buildTableView(["Plateforme", "ROAS"], [["Meta", "4"], ["Google", "2"]]);
    expect(t.tones.flat().every((x) => x === null)).toBe(true);
  });
});

describe("sortOrder", () => {
  const headers = ["Campagne", "ROAS"];
  const rows = [["B", "2,5"], ["Total", "3"], ["A", "5"], ["C", "—"]];
  const v = buildTableView(headers, rows);
  it("trie en nombres, total en bas, vides après", () => {
    expect(sortOrder(v, rows, { col: 1, dir: "desc" })).toEqual([2, 0, 3, 1]);
    expect(sortOrder(v, rows, { col: 1, dir: "asc" })).toEqual([0, 2, 3, 1]);
  });
  it("trie le texte, et rend l'ordre d'origine sans tri", () => {
    expect(sortOrder(v, rows, { col: 0, dir: "asc" })).toEqual([2, 0, 3, 1]);
    expect(sortOrder(v, rows, null)).toEqual([0, 1, 2, 3]);
  });
});
