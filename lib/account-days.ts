/**
 * Daily totals of a WHOLE ad account, read live on the platform.
 *
 * The creative warehouse (AdCatalog / AdDaily) is for creatives: it is
 * ad-level, so a total summed from it leaves out whatever has no ad
 * (Performance Max on Google — Decathlon Travel, 16/11/2026: 9 376 € shown for
 * 14 688 € spent). An account total or a period-over-period change is read
 * here instead: one light call per account (a row per day), cached 30 min in
 * the shared cache so every instance — bot, Mo — answers at once.
 */

import { cached } from "@/lib/kpi-cache";
import { prisma } from "@/lib/prisma";
import { relayDirectTool } from "@/lib/relay-tool";
import { TIKTOK_SERVER } from "@/lib/mcp-whitelist";
import { chunkRange, tiktokEnvelope } from "@/lib/tiktok-data";
import { getAccountDailyInsightsRich, getMetaSystemToken } from "@/lib/meta-api";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { dailyFromInsight } from "@/lib/ads-warehouse/meta";
import { googleAccountDaily } from "@/lib/ads-warehouse/google";
import type { Sums } from "@/lib/ads-warehouse/query";
import type { WarehousePlatform } from "@/lib/ads-warehouse/types";

export type DaySums = Sums & { date: string };
export interface DayRange { since: string; until: string }

const TTL_MS = 30 * 60_000;
export const ZERO_SUMS: Sums = { spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, conversions: 0, conversionValue: 0, purchases: 0, purchaseValue: 0, leads: 0, videoPlays: 0, video3s: 0, thruPlays: 0, p25: 0, p50: 0, p75: 0, p100: 0 };
const num = (v: unknown): number => { const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0; return Number.isFinite(n) ? n : 0; };
const int = (v: unknown) => Math.round(num(v));

async function metaDays(accountId: string, range: DayRange): Promise<DaySums[]> {
  const id = accountId.replace(/^act_/, "");
  // Same conversion policy as the warehouse (lib/ads-warehouse/meta.ts): the account's
  // event, and by default leads when the account's history converts in leads.
  const [settings, hist, rows] = await Promise.all([
    getAccountProfileSettings("meta", id),
    prisma.adDaily.aggregate({ where: { platform: "meta", accountId: id }, _sum: { purchases: true, leads: true } }).catch(() => null),
    getAccountDailyInsightsRich(getMetaSystemToken(), id, range),
  ]);
  const useLeads = settings.conversionEvent === "purchase" && (hist?._sum.leads ?? 0) > (hist?._sum.purchases ?? 0);
  const out: DaySums[] = [];
  for (const r of rows) {
    const d = dailyFromInsight(id, r, settings.conversionEvent);
    if (!d) continue;
    out.push({
      date: d.date, spend: d.spend, impressions: d.impressions, reach: d.reach, clicks: d.clicks, linkClicks: d.linkClicks,
      conversions: useLeads ? d.leads : d.conversions, conversionValue: useLeads ? 0 : d.conversionValue, purchases: d.purchases, purchaseValue: d.purchaseValue, leads: d.leads,
      videoPlays: d.videoPlays, video3s: d.video3s, thruPlays: d.thruPlays, p25: d.videoP25, p50: d.videoP50, p75: d.videoP75, p100: d.videoP100,
    });
  }
  return out;
}

async function googleDays(accountId: string, range: DayRange): Promise<DaySums[]> {
  const rows = await googleAccountDaily(accountId.replace(/-/g, ""), range.since, range.until);
  return rows.map((r) => ({ ...ZERO_SUMS, date: r.date, spend: r.spend, impressions: r.impressions, clicks: r.clicks, linkClicks: r.clicks, conversions: r.conversions, conversionValue: r.conversionValue, purchases: r.conversions, purchaseValue: r.conversionValue }));
}

const TIKTOK_METRICS = ["spend", "impressions", "clicks", "reach", "conversion", "total_purchase_value", "video_play_actions", "video_watched_2s", "video_watched_6s", "video_views_p25", "video_views_p50", "video_views_p75", "video_views_p100"];

async function tiktokDays(accountId: string, range: DayRange): Promise<DaySums[]> {
  const slices = await Promise.all(chunkRange(range.since, range.until).map(async (slice) => {
    const res = await relayDirectTool(`${TIKTOK_SERVER}.get_report_integrated`, { advertiser_id: accountId, data_level: "AUCTION_ADVERTISER", dimensions: ["advertiser_id", "stat_time_day"], metrics: TIKTOK_METRICS, start_date: slice.since, end_date: slice.until, page: "1", page_size: "100" }, 20_000);
    return tiktokEnvelope(res).list;
  }));
  const out: DaySums[] = [];
  for (const r of slices.flat()) {
    const d = (r.dimensions && typeof r.dimensions === "object" ? r.dimensions : r) as Record<string, unknown>;
    const m = (r.metrics && typeof r.metrics === "object" ? r.metrics : r) as Record<string, unknown>;
    const date = String(d.stat_time_day ?? "").slice(0, 10);
    if (!date) continue;
    const conv = num(m.conversion), val = num(m.total_purchase_value);
    out.push({ ...ZERO_SUMS, date, spend: num(m.spend), impressions: int(m.impressions), reach: int(m.reach), clicks: int(m.clicks), linkClicks: int(m.clicks), conversions: conv, conversionValue: val, purchases: conv, purchaseValue: val, videoPlays: int(m.video_play_actions), video3s: int(m.video_watched_2s), thruPlays: int(m.video_watched_6s), p25: int(m.video_views_p25), p50: int(m.video_views_p50), p75: int(m.video_views_p75), p100: int(m.video_views_p100) });
  }
  return out;
}

/**
 * A row per day of the account over the range, live (shared cache 15 min).
 * Throws when the platform does not answer within `timeoutMs`: the caller
 * falls back and SAYS the total is not the platform's.
 */
export async function liveAccountDays(platform: WarehousePlatform, accountId: string, range: DayRange, timeoutMs = 9_000): Promise<DaySums[]> {
  const fetcher = platform === "meta" ? metaDays : platform === "google" ? googleDays : tiktokDays;
  const work = cached(`acctdays:${platform}:${accountId}:${range.since}:${range.until}`, () => fetcher(accountId, range), { ttlMs: TTL_MS });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${platform} : pas de réponse en ${timeoutMs} ms`)), timeoutMs); })]);
  } finally {
    clearTimeout(timer);
    work.catch(() => undefined);
  }
}

/** Sum of the days inside the range (inclusive). */
export function sumDays(days: DaySums[], range: DayRange): Sums {
  const s = { ...ZERO_SUMS };
  for (const d of days) {
    if (d.date < range.since || d.date > range.until) continue;
    for (const k of Object.keys(ZERO_SUMS) as Array<keyof Sums>) s[k] += d[k];
  }
  return s;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

export interface NamedPeriod { label: string; range: DayRange; compare: DayRange; compareLabel: string }

/**
 * The calendar periods clients ask for (« la semaine du 9 au 15 », « octobre »),
 * each against the one before: the last `weeks` complete Monday→Sunday weeks,
 * the month to date (vs the same days of the month before) and the last full
 * month. `yesterday` = last complete day.
 */
export function calendarPeriods(yesterday: string, weeks = 4): NamedPeriod[] {
  const fr = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
  const out: NamedPeriod[] = [];
  const y = new Date(`${yesterday}T00:00:00Z`);
  // Last Sunday on or before yesterday.
  const lastSunday = shift(yesterday, -(y.getUTCDay() % 7));
  for (let i = 0; i < weeks; i++) {
    const until = shift(lastSunday, -7 * i), since = shift(until, -6);
    out.push({ label: `Semaine du lundi ${fr(since)} au dimanche ${fr(until)}`, range: { since, until }, compare: { since: shift(since, -7), until: shift(until, -7) }, compareLabel: "la semaine d'avant" });
  }
  const monthStart = (d: Date, back: number) => iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1)));
  const monthEnd = (d: Date, back: number) => iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back + 1, 0)));
  const name = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
  const m0 = monthStart(y, 0);
  // Month to date vs the same days of the month before (capped to that month's length).
  const prevSame = shift(monthStart(y, 1), y.getUTCDate() - 1);
  const prevEnd = monthEnd(y, 1);
  out.push({ label: `Mois en cours, ${name(m0)} (du ${fr(m0)} au ${fr(yesterday)})`, range: { since: m0, until: yesterday }, compare: { since: monthStart(y, 1), until: prevSame < prevEnd ? prevSame : prevEnd }, compareLabel: `les mêmes jours du mois d'avant (${fr(monthStart(y, 1))} → ${fr(prevSame < prevEnd ? prevSame : prevEnd)})` });
  out.push({ label: `Mois complet, ${name(monthStart(y, 1))} (du ${fr(monthStart(y, 1))} au ${fr(prevEnd)})`, range: { since: monthStart(y, 1), until: prevEnd }, compare: { since: monthStart(y, 2), until: monthEnd(y, 2) }, compareLabel: `${name(monthStart(y, 2))}` });
  return out;
}

/** First day needed to cover the calendar periods and a 30-day window with its previous one. */
export function daysSince(yesterday: string, weeks = 4): string {
  const y = new Date(`${yesterday}T00:00:00Z`);
  const candidates = [shift(yesterday, -59), iso(new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth() - 2, 1))), shift(yesterday, -(7 * (weeks + 2)))];
  return candidates.sort()[0];
}
