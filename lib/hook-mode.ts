/**
 * What « Hook » counts across the app (reports, dashboards, client page):
 *   - "views3s" (default): 3-second views over impressions — Motion's and
 *     Meta's hook rate, the one that tells the videos apart (13–33 % on a
 *     typical account);
 *   - "starts": video starts over impressions (autoplay included), around
 *     85 % on any video — the figure shown before 2026-11-27, kept as a choice.
 * One setting for everybody (AppSetting « hook_mode »), chosen by an admin in
 * Réglages. The « Tests du labo » widget always reads 3 seconds: it says so.
 */

import { prisma } from "@/lib/prisma";
import type { HookMode } from "@/lib/meta-api";

const KEY = "hook_mode";
const TTL_MS = 30_000;
let memo: { at: number; mode: HookMode } | null = null;

export const parseHookMode = (v: unknown): HookMode => (v === "starts" ? "starts" : "views3s");

export async function readHookMode(): Promise<HookMode> {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.mode;
  // A setting that cannot be read never breaks a dashboard or a report: 3 seconds, and it is read again next time.
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    const mode = parseHookMode((JSON.parse(row?.valueJson ?? "{}") as { mode?: unknown }).mode);
    memo = { at: Date.now(), mode };
    return mode;
  } catch {
    return "views3s";
  }
}

export async function writeHookMode(mode: HookMode, updatedBy: string | null): Promise<HookMode> {
  const valueJson = JSON.stringify({ mode });
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, valueJson, updatedBy }, update: { valueJson, updatedBy } });
  memo = { at: Date.now(), mode };
  return mode;
}
