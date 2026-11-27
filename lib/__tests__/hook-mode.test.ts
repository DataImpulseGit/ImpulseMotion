import { describe, expect, it } from "vitest";
import { computeHookRate, type MetaCreativeInsight } from "@/lib/meta-api";
import { parseHookMode } from "@/lib/hook-mode";

const insight = {
  impressions: "1000",
  actions: [{ action_type: "video_view", value: "250" }],
  video_play_actions: [{ action_type: "video_view", value: "860" }],
} as unknown as MetaCreativeInsight;

describe("mesure du Hook", () => {
  it("compte les vues de 3 secondes par défaut, les démarrages sur demande", () => {
    expect(computeHookRate(insight)).toBe(25);
    expect(computeHookRate(insight, "views3s")).toBe(25);
    expect(computeHookRate(insight, "starts")).toBe(86);
  });
  it("retombe sur 3 secondes pour un réglage inconnu", () => {
    expect([parseHookMode("starts"), parseHookMode("views3s"), parseHookMode(undefined), parseHookMode("x")]).toEqual(["starts", "views3s", "views3s", "views3s"]);
  });
});
