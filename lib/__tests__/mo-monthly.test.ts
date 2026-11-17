import { describe, expect, it, vi } from "vitest";
import { applyMonthlyEdit, describeMonthly, lastCompleteMonth, monthLabel, monthRange, monthlyChecks, parseMonth, previousMonth, sanitizeMonthlyDoc, type MonthlyDoc } from "@/lib/mo/monthly";
import { monthlyTopCreatives } from "@/lib/mo/tools";
import { parseActRequest, runMoAct, type ActDeps } from "@/lib/mo/act";
import type { MoCard } from "@/lib/mo/model";

const raw = {
  clientId: "dash_nat", clientName: "Naturalia", month: "2026-10", compareLabel: "vs les 31 jours précédents", context: "", nextDate: "",
  sections: [
    { id: "contexte", kind: "context", title: "Remise en contexte", lists: {} },
    { id: "global", kind: "overview", title: "Vue globale", kpis: [{ label: "Dépense totale", value: "7 188 €", delta: "+9 %", tone: "neutral" }, { label: "", value: "x" }], table: { columns: ["Plateforme", "Dépense"], rows: [["Meta", "3 418 €"], ["Google", "3 130 €"]] }, lists: { learnings: ["a", "b"], budget: ["ignoré ici"] } },
    { id: "meta", kind: "channel", platform: "meta", title: "Détail Meta Ads", lists: {} },
    { id: "creas-meta", kind: "creatives", platform: "meta", title: "Créas Meta Ads", creatives: [{ name: "UGC Lisa", adId: "111", image: "/api/mo/ad-image/meta/111", metrics: { "Dépense": "812 €", CTR: "1,9 %" } }, { name: "", metrics: {} }, { name: "Piège", image: "javascript:alert(1)", metrics: {} }], lists: {} },
    { id: "suite", kind: "next", title: "Budget & next steps", lists: {} },
    { id: "x", kind: "inconnu", title: "?" },
  ],
};
const doc = (): MonthlyDoc => sanitizeMonthlyDoc(raw)!;

describe("Atelier monthly — le document", () => {
  it("ne garde que ce qui est valide et borne chaque section à ses listes", () => {
    const d = doc();
    expect(d.period).toEqual({ since: "2026-10-01", until: "2026-10-31" });
    expect(d.sections.map((s) => s.id)).toEqual(["contexte", "global", "meta", "creas-meta", "suite"]);
    expect(d.sections[1].kpis).toEqual([{ label: "Dépense totale", value: "7 188 €", delta: "+9 %", tone: "neutral" }]);
    expect(d.sections[1].lists).toEqual({ learnings: ["a", "b"] });
    expect(d.sections[3].creatives?.map((c) => [c.name, c.image])).toEqual([["UGC Lisa", "/api/mo/ad-image/meta/111"], ["Piège", undefined]]);
    expect(sanitizeMonthlyDoc({ ...raw, month: "octobre" })).toBeNull();
    expect(sanitizeMonthlyDoc({ ...raw, sections: [] })).toBeNull();
  });

  it("lit les mois comme on les dit", () => {
    expect(monthRange("2026-02")).toEqual({ since: "2026-02-01", until: "2026-02-28" });
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(monthLabel("2026-08")).toBe("août 2026");
    expect(lastCompleteMonth("2026-11-17")).toBe("2026-10");
    expect(parseMonth("octobre", "2026-11-17")).toBe("2026-10");
    expect(parseMonth("décembre", "2026-11-17")).toBe("2025-12");
    expect(parseMonth("oct 2025", "2026-11-17")).toBe("2025-10");
    expect(parseMonth("2026-9", "2026-11-17")).toBe("2026-09");
    expect(parseMonth("le mois dernier", "2026-11-17")).toBe("2026-10");
    expect(parseMonth("fevrier", "2026-11-17")).toBe("2026-02");
    expect(parseMonth("bientôt", "2026-11-17")).toBeNull();
  });

  it("applique les modifications : textes, listes, créas, verdicts", () => {
    let d = applyMonthlyEdit(doc(), { context: "  Budget Google +20 %  ", nextDate: "mardi 9 décembre", title: { section: "meta", value: "Meta : le coût par achat recule de 7 %" } });
    expect([d.context, d.nextDate, d.sections[2].title]).toEqual(["Budget Google +20 %", "mardi 9 décembre", "Meta : le coût par achat recule de 7 %"]);
    d = applyMonthlyEdit(d, { list: { section: "meta", key: "nextSteps", items: ["  Déplacer 15 % du budget  ", "", "Renouveler 2 visuels\navant le 15"] } });
    expect(d.sections[2].lists.nextSteps).toEqual(["Déplacer 15 % du budget", "Renouveler 2 visuels avant le 15"]);
    // Une liste qui n'est pas de cette section est ignorée.
    expect(applyMonthlyEdit(d, { list: { section: "meta", key: "budget", items: ["x"] } }).sections[2].lists.budget).toBeUndefined();
    // Une créa déposée ; la même déposée de nouveau se déplace au lieu de doubler et garde son verdict.
    d = applyMonthlyEdit(d, { addCreative: { section: "creas-meta", creative: { name: "Statique promo", adId: "222", metrics: { "Dépense": "640 €" } } } });
    d = applyMonthlyEdit(d, { badge: { section: "creas-meta", index: 0, badge: "winner" } });
    d = applyMonthlyEdit(d, { addCreative: { section: "creas-meta", creative: { name: "UGC Lisa", adId: "111", metrics: { "Dépense": "812 €" } }, at: 9 } });
    expect(d.sections[3].creatives?.map((c) => [c.name, c.badge])).toEqual([["Piège", undefined], ["Statique promo", undefined], ["UGC Lisa", "winner"]]);
    d = applyMonthlyEdit(d, { badge: { section: "creas-meta", index: 2, badge: null } });
    expect(d.sections[3].creatives?.[2].badge).toBeUndefined();
    d = applyMonthlyEdit(d, { removeCreative: { section: "creas-meta", index: 0 } });
    d = applyMonthlyEdit(d, { moveCreative: { section: "creas-meta", from: 1, to: 0 } });
    expect(d.sections[3].creatives?.map((c) => c.name)).toEqual(["UGC Lisa", "Statique promo"]);
    // Une créa ne se dépose que dans une section créas ; une section inconnue est ignorée.
    expect(applyMonthlyEdit(d, { addCreative: { section: "meta", creative: { name: "x", metrics: {} } } }).sections[2].creatives).toBeUndefined();
    expect(applyMonthlyEdit(d, { title: { section: "nope", value: "x" } })).toEqual(d);
    expect(applyMonthlyEdit(d, { removeSection: "meta" }).sections.map((s) => s.id)).not.toContain("meta");
  });

  it("relit comme la skill monthly-qa : titres-thèmes, limites par slide, textes à compléter", () => {
    const messages = (d: MonthlyDoc) => monthlyChecks(d).map((c) => `${c.level}:${c.message}`);
    const first = messages(doc());
    expect(first.some((m) => /Contexte du mois vide/.test(m))).toBe(true);
    expect(first.some((m) => /« Vue globale » : un titre = un message/.test(m))).toBe(true);
    expect(first.some((m) => /« Détail Meta Ads » : un titre = un message/.test(m))).toBe(true);
    expect(first.some((m) => /créas? sans verdict/.test(m))).toBe(true);
    expect(first.some((m) => /Date du prochain monthly absente/.test(m))).toBe(true);
    expect(first.some((m) => /début de l'année/.test(m))).toBe(true);
    let d = applyMonthlyEdit(doc(), { list: { section: "meta", key: "learnings", items: ["a", "b", "c", "d"] } });
    expect(messages(d).some((m) => /4 learnings, 3 au plus/.test(m))).toBe(true);
    d = applyMonthlyEdit(d, { list: { section: "suite", key: "nextSteps", items: ["[À COMPLÉTER] budget"] } });
    expect(monthlyChecks(d).filter((c) => c.level === "block").map((c) => c.section)).toEqual(["suite"]);
    // Un titre qui porte un chiffre n'est plus un thème.
    d = applyMonthlyEdit(d, { title: { section: "global", value: "En octobre, 18 % de ventes en plus" } });
    expect(messages(d).some((m) => /18 % de ventes en plus.*un titre = un message/.test(m))).toBe(false);
  });

  it("se décrit à Mo avec les identifiants de ses sections", () => {
    const text = describeMonthly(doc());
    expect(text).toContain("monthly Naturalia octobre 2026");
    expect(text).toContain("section creas-meta [creatives meta]");
    expect(text).toContain("Dépense totale 7 188 € (+9 %)");
  });

  it("propose les créas qui portent la dépense, quatre au plus, sans verdict", () => {
    const items = [["A", "1 000 €"], ["B", "600 €"], ["C", "300 €"], ["D", "80 €"], ["E", "20 €"], ["F", "5 €"]].map(([name, spend], i) => ({ name, adId: `ad${i}`, image: `/api/mo/ad-image/meta/ad${i}`, metrics: { "Dépense": spend, CTR: "1 %", CPM: "9 €", Impressions: "1 000", ROAS: "3×", "Hook rate": "30 %" } }));
    const top = monthlyTopCreatives(items, "meta");
    // D vaut 4 % de la dépense : sous le seuil de 5 %.
    expect(top.map((c) => c.name)).toEqual(["A", "B", "C"]);
    expect(top[0]).toMatchObject({ platform: "meta", adId: "ad0" });
    expect(Object.keys(top[0].metrics)).toEqual(["Dépense", "ROAS", "CTR", "Hook rate"]);
    expect(top.every((c) => c.badge === undefined)).toBe(true);
    expect(monthlyTopCreatives([], "meta")).toEqual([]);
  });
});

describe("Atelier monthly — actions de la carte", () => {
  const card = (): MoCard => ({ id: "mon1", type: "monthly", title: "Monthly Naturalia", x: 0, y: 0, w: 900, turn: 0, at: "", clientId: "dash_nat", clientName: "Naturalia", doc: doc() }) as MoCard;
  const creas = (): MoCard => ({ id: "cre1", type: "creatives", title: "Créas", x: 0, y: 0, w: 400, turn: 0, at: "", items: [
    { name: "Reel recette", adId: "999", image: "/api/mo/ad-image/meta/999", verdict: "keep", metrics: { Impressions: "12 000", "Dépense": "300 €", CTR: "1,6 %", "Coût par achat": "13 €", CPM: "8 €", ROAS: "4×" } },
    { name: "Pub concurrente", adId: "adlib:777", metrics: {} },
  ] }) as MoCard;
  function fake(cards: MoCard[]) {
    const store = { cards };
    const deps = {
      loadCards: async () => store.cards,
      rewriteCard: async (id: string, fn: (c: MoCard) => MoCard | null) => { let out: MoCard | null = null; store.cards = store.cards.map((c) => { if (c.id !== id) return c; out = fn(c); return out ?? c; }); return out; },
      journal: vi.fn(async () => undefined),
      clients: async () => [{ id: "dash_nat", clientId: "cli_nat", name: "Naturalia", dashboardId: "dash_nat" }],
      publishMonthly: vi.fn(async () => ({ link: "https://docs.google.com/presentation/d/deck1/edit", slides: 9, missingVisuals: 1 })),
    } as unknown as ActDeps;
    return { store, deps };
  }
  const run = (deps: ActDeps, body: unknown) => { const req = parseActRequest(body); if ("error" in req) throw new Error(req.error); return runMoAct(req, deps, "Camille"); };
  const monthlyOf = (cards: MoCard[]) => cards.find((c): c is Extract<MoCard, { type: "monthly" }> => c.type === "monthly")!;

  it("dépose une créa lue sur sa carte côté serveur, avec quatre chiffres et son verdict", async () => {
    const { store, deps } = fake([card(), creas()]);
    // Ce que le navigateur prétend de la créa (edit.addCreative) est ignoré : seule la carte source fait foi.
    await run(deps, { action: "monthly", cardId: "mon1", from: { cardId: "cre1", item: 0, section: "creas-meta" }, edit: { addCreative: { section: "creas-meta", creative: { name: "Faux", metrics: { "Dépense": "1 €" } } } } });
    const list = monthlyOf(store.cards).doc.sections[3].creatives!;
    expect(list.map((c) => c.name)).toEqual(["UGC Lisa", "Piège", "Reel recette"]);
    expect(list[2]).toMatchObject({ adId: "999", platform: "meta", badge: "winner", metrics: { "Dépense": "300 €", "Coût par achat": "13 €", ROAS: "4×", CTR: "1,6 %" } });
    expect(deps.journal).toHaveBeenCalledTimes(1);
    await expect(run(deps, { action: "monthly", cardId: "mon1", from: { cardId: "cre1", item: 0, section: "meta" } })).rejects.toThrow(/section « Créas »/);
    await expect(run(deps, { action: "monthly", cardId: "mon1", from: { cardId: "cre1", item: 7, section: "creas-meta" } })).rejects.toThrow(/plus sur le tableau/);
  });

  it("enregistre un texte sans laisser passer un lien de deck forgé", async () => {
    const { store, deps } = fake([card()]);
    await run(deps, { action: "monthly", cardId: "mon1", edit: { context: "Lancement du catalogue", deck: { link: "https://evil.example/x", at: "" } } });
    const d = monthlyOf(store.cards).doc;
    expect(d.context).toBe("Lancement du catalogue");
    expect(d.deck).toBeUndefined();
  });

  it("publie le deck, pose le lien sur la carte, et refuse tant qu'un texte est à compléter", async () => {
    const { store, deps } = fake([card()]);
    const r = await run(deps, { action: "monthly_publish", cardId: "mon1" });
    expect(deps.publishMonthly).toHaveBeenCalledWith(expect.objectContaining({ clientName: "Naturalia", month: "2026-10" }), "dash_nat");
    const c = monthlyOf(store.cards);
    expect(c.doc.deck?.link).toBe("https://docs.google.com/presentation/d/deck1/edit");
    expect(c.link).toBe(c.doc.deck?.link); expect(c.linkLabel).toBe("Google Slides");
    expect(r.say).toMatch(/9 slides, 1 visuel à ajouter/);
    await run(deps, { action: "monthly", cardId: "mon1", edit: { title: { section: "suite", value: "[À COMPLÉTER]" } } });
    await expect(run(deps, { action: "monthly_publish", cardId: "mon1" })).rejects.toThrow(/Avant de publier/);
    expect(deps.publishMonthly).toHaveBeenCalledTimes(1);
  });
});
