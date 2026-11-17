import { describe, expect, it } from "vitest";
import { applySheetEdit, cellMatches, columnLetter, columnValues, describeSheetView, sanitizeSheetView, styleResolver, visibleRows, type MoSheetView } from "@/lib/mo/sheet";
import { sheetExportOf } from "@/lib/mo/act";
import { worksheetXml } from "@/lib/xlsx";
import type { MoCard } from "@/lib/mo/model";

const columns = ["Campagne", "Plateforme", "Dépense", "ROAS", "CPA"];
const rows = [
  ["Prospection", "Meta", "1 245,30 €", "3,4", "18,20 €"],
  ["Retargeting", "Meta", "412 €", "5,1", "9,70 €"],
  ["Search marque", "Google", "2 030 €", "8,2", "4,10 €"],
  ["PMax", "Google", "980 €", "—", ""],
];

describe("Mo — tableau façon tableur", () => {
  it("compare les nombres comme des nombres, quel que soit leur affichage", () => {
    expect(cellMatches("1 245,30 €", "gt", "1000")).toBe(true);
    expect(cellMatches("412 €", "gt", "1000")).toBe(false);
    expect(cellMatches("3,4", "gte", "3.4")).toBe(true);
    expect(cellMatches("Méta Ads", "contains", "meta")).toBe(true);
    expect(cellMatches("—", "empty")).toBe(true);
    expect(cellMatches("texte", "gt", "3")).toBe(false);
  });

  it("filtre puis trie, les cellules vides en dernier", () => {
    expect(visibleRows(rows, { sort: { col: 2, dir: "desc" } })).toEqual([2, 0, 3, 1]);
    expect(visibleRows(rows, { sort: { col: 3, dir: "asc" } })).toEqual([0, 1, 2, 3]);
    expect(visibleRows(rows, { filters: [{ col: 1, op: "in", values: ["Meta"] }], sort: { col: 2, dir: "asc" } })).toEqual([1, 0]);
    expect(visibleRows(rows, { filters: [{ col: 2, op: "gt", value: "500" }, { col: 1, op: "eq", value: "google" }] })).toEqual([2, 3]);
    expect(columnValues(rows, 1)).toEqual(["Google", "Meta"]);
  });

  it("résout les couleurs : règles dans l'ordre, puis ce qui est posé à la main", () => {
    const view: MoSheetView = { rules: [{ col: 3, op: "gt", value: "5", color: "green", scope: "row" }, { col: 4, op: "scale", high: "bad" }], cells: { "0:0": { fill: "yellow", bold: true }, "h:2": { color: "blue" } } };
    const st = styleResolver(rows, view);
    expect(st(1, 0).fill).toBe("green"); // toute la ligne Retargeting (ROAS 5,1)
    expect(st(0, 3).fill).toBeUndefined();
    expect(st(0, 0)).toEqual({ fill: "yellow", bold: true });
    expect(st("h", 2)).toEqual({ color: "blue" });
    // CPA : le plus haut est le plus rouge, le plus bas le plus vert ; la cellule vide n'a rien.
    expect(st(0, 4).scale).toEqual({ color: "red", strength: 1 });
    expect(st(2, 4).scale).toEqual({ color: "green", strength: 1 });
    expect(st(3, 4).scale).toBeUndefined();
  });

  it("ne garde d'une vue que ce qui est valide", () => {
    const v = sanitizeSheetView({ sort: { col: 9, dir: "desc" }, filters: [{ col: 1, op: "in", values: ["Meta", 3] }, { col: 2, op: "gt" }, { col: 2, op: "boom", value: "1" }], rules: [{ col: 3, op: "gt", value: "3", color: "fuchsia" }, { col: 3, op: "lt", value: "3", color: "red" }, { col: 4, op: "scale" }], cells: { "0:0": { fill: "green", evil: "x" }, "99:0": { fill: "red" }, "0:9": { bold: true }, "x": { bold: true } }, widths: [10, 9999, "a"] }, 5, 4);
    expect(v).toEqual({ filters: [{ col: 1, op: "in", values: ["Meta", "3"] }], rules: [{ col: 3, op: "lt", value: "3", color: "red" }, { col: 4, op: "scale", high: "good" }], cells: { "0:0": { fill: "green" } }, widths: [48, 600, null] });
    expect(sanitizeSheetView({}, 5, 4)).toBeUndefined();
    expect(sanitizeSheetView(null, 5, 4)).toBeUndefined();
  });

  it("modifie des cellules, ajoute et supprime lignes et colonnes en gardant les styles à leur place", () => {
    const table = { columns, rows, sheet: { sort: { col: 4, dir: "asc" as const }, cells: { "2:4": { fill: "green" as const }, "3:0": { bold: true } }, rules: [{ col: 3, op: "gt" as const, value: "5", color: "green" as const }] } };
    const a = applySheetEdit(table, { set: [{ row: 0, col: 0, value: "  Prospection FR " }, { row: "h", col: 3, value: "ROAS 7j" }, { row: 99, col: 0, value: "x" }] });
    expect(a.rows[0][0]).toBe("Prospection FR"); expect(a.columns[3]).toBe("ROAS 7j"); expect(table.rows[0][0]).toBe("Prospection");
    const b = applySheetEdit(table, { deleteRows: [0, 1] });
    expect(b.rows.map((r) => r[0])).toEqual(["Search marque", "PMax"]);
    expect(b.sheet?.cells).toEqual({ "0:4": { fill: "green" }, "1:0": { bold: true } });
    const c = applySheetEdit(table, { deleteColumn: 3 });
    expect(c.columns).toEqual(["Campagne", "Plateforme", "Dépense", "CPA"]);
    expect(c.sheet?.rules).toBeUndefined(); expect(c.sheet?.sort).toEqual({ col: 3, dir: "asc" }); expect(c.sheet?.cells).toEqual({ "2:3": { fill: "green" }, "3:0": { bold: true } });
    const d = applySheetEdit(table, { addRow: true, addColumn: "Note" });
    expect(d.rows).toHaveLength(5); expect(d.columns[5]).toBe("Note"); expect(d.rows[4]).toEqual(["", "", "", "", "", ""]);
    expect(applySheetEdit(table, { view: null }).sheet).toBeUndefined();
  });

  it("nomme les colonnes comme un tableur et décrit ce qui est appliqué", () => {
    expect([0, 25, 26, 27].map(columnLetter)).toEqual(["A", "Z", "AA", "AB"]);
    expect(describeSheetView(columns, { sort: { col: 2, dir: "desc" }, filters: [{ col: 1, op: "eq", value: "Meta" }], rules: [{ col: 4, op: "scale", high: "bad" }] })).toBe("trié par Dépense ↓ · 1 filtre · 1 règle de couleur");
  });

  it("exporte vers Google Sheets ce que la personne voit, avec les couleurs et les boutons de filtre", () => {
    const card = { id: "c1", type: "table", title: "T", x: 0, y: 0, w: 400, turn: 0, at: "", columns, rows, sheet: { filters: [{ col: 1, op: "in", values: ["Meta"] }], sort: { col: 2, dir: "asc" }, rules: [{ col: 3, op: "gt", value: "5", color: "green", scope: "row" }], cells: { "0:0": { bold: true, color: "red" } } } } as unknown as MoCard;
    const out = sheetExportOf(card)!;
    expect(out.rows.map((r) => r[0])).toEqual(["Retargeting", "Prospection"]);
    expect(out.rows[0][2]).toBe(412); // typé en nombre, unité dans l'en-tête
    expect(out.autoFilter).toBe(true);
    expect(out.styles?.[0]?.[1]).toEqual({ fill: "D9EAD3" });
    expect(out.styles?.[1]?.[0]).toEqual({ color: "A50E0E", bold: true });
    const xml = worksheetXml(out.columns, out.rows, { styles: out.styles, autoFilter: true });
    expect(xml.sheet).toContain('<autoFilter ref="A1:E3"/>');
    expect(xml.styles).toContain('<fgColor rgb="FFD9EAD3"/>'); expect(xml.styles).toContain('<color rgb="FFA50E0E"/>');
    expect(xml.sheet).toMatch(/<c r="A2" s="\d+" t="s">/);
    // Sans vue, l'export reste celui d'avant.
    const plain = sheetExportOf({ ...card, sheet: undefined } as MoCard)!;
    expect(plain.rows).toHaveLength(4); expect(plain.styles).toBeUndefined();
    expect(worksheetXml(plain.columns, plain.rows).sheet).not.toContain("autoFilter");
  });
});
