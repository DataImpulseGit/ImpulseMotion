import { describe, expect, it } from "vitest";
import { cleanName, isRoutineDue, parseSchedule, scheduleLabel } from "@/lib/bot-routines";

const at = (iso: string) => new Date(iso);

describe("pages du bot : planification", () => {
  it("ne lit que les fréquences connues", () => {
    expect(parseSchedule("weekly:1")).toBe("weekly:1");
    expect(parseSchedule("weekly:8")).toBeNull();
    expect(parseSchedule("hourly")).toBeNull();
    expect(scheduleLabel("weekly:1")).toBe("Chaque lundi matin");
    expect(scheduleLabel("n'importe quoi")).toBe("À la demande");
  });
  it("à la demande : jamais dû", () => {
    expect(isRoutineDue("manual", null, at("2026-11-26T06:00:00Z"))).toBe(false);
  });
  it("chaque matin : une fois par jour de Paris", () => {
    const now = at("2026-11-26T05:50:00Z"); // jeudi 06:50 à Paris
    expect(isRoutineDue("daily", null, now)).toBe(true);
    expect(isRoutineDue("daily", at("2026-11-25T15:00:00Z"), now)).toBe(true);
    expect(isRoutineDue("daily", at("2026-11-26T05:10:00Z"), now)).toBe(false);
    // 23:30 UTC la veille = déjà le 26 à Paris
    expect(isRoutineDue("daily", at("2026-11-25T23:30:00Z"), now)).toBe(false);
  });
  it("chaque lundi : dû le lundi, rattrapé dans la semaine, pas rejoué", () => {
    const monday = at("2026-11-23T05:50:00Z");
    const thursday = at("2026-11-26T05:50:00Z");
    expect(isRoutineDue("weekly:1", at("2026-11-20T10:00:00Z"), monday)).toBe(true);
    expect(isRoutineDue("weekly:1", at("2026-11-20T10:00:00Z"), thursday)).toBe(true);
    expect(isRoutineDue("weekly:1", at("2026-11-23T05:55:00Z"), thursday)).toBe(false);
    // créée et lancée un mercredi : attend le lundi suivant
    expect(isRoutineDue("weekly:1", at("2026-11-25T10:00:00Z"), thursday)).toBe(false);
  });
  it("le 1er du mois", () => {
    expect(isRoutineDue("monthly", at("2026-10-15T10:00:00Z"), at("2026-11-01T05:50:00Z"))).toBe(true);
    expect(isRoutineDue("monthly", at("2026-11-01T06:00:00Z"), at("2026-11-26T05:50:00Z"))).toBe(false);
    expect(isRoutineDue("monthly", at("2026-10-31T10:00:00Z"), at("2026-11-26T05:50:00Z"))).toBe(true);
  });
  it("nettoie le nom de l'onglet", () => {
    expect(cleanName("  Bilan   de la\nsemaine ")).toBe("Bilan de la semaine");
    expect(cleanName("x".repeat(80))).toHaveLength(40);
    expect(cleanName(12)).toBe("");
  });
});
