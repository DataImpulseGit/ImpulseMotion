/**
 * GET /api/cron/bot-packs — prepares the figures of the client bots in use.
 *
 * For every enabled bot that had a conversation in the last 14 days, the
 * account totals are read on the platforms and the bot's block is stored in
 * the shared cache (lib/bot-ads-pack.ts). The first question of the day then
 * finds it ready: the chat never waits for Meta, Google or TikTok. One bot at
 * a time (the relay runs platform calls one after the other anyway).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkCronAuth } from "@/lib/cron-auth";
import { parseSources } from "@/lib/bot-types";
import { warmBotAdsPack } from "@/lib/bot-ads-pack";
import { getDashboardTikTokIds } from "@/lib/tiktok-accounts";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const deadline = Date.now() + 270_000;
  const since = new Date(Date.now() - 14 * 86_400_000);
  const active = await prisma.botConversation.findMany({ where: { updatedAt: { gte: since } }, select: { botId: true }, distinct: ["botId"] });
  const bots = await prisma.clientBot.findMany({
    where: { enabled: true, id: { in: active.map((a) => a.botId) } },
    select: { id: true, name: true, sourcesJson: true, dashboard: { select: { id: true, metaAccountId: true, googleCustomerId: true } } },
  });
  const done: string[] = [], failed: string[] = [];
  for (const bot of bots) {
    if (Date.now() > deadline) break;
    try {
      const sources = parseSources(bot.sourcesJson);
      const tiktok = sources.tiktok ? await getDashboardTikTokIds(bot.dashboard.id) : [];
      await warmBotAdsPack(bot.id, { meta: sources.meta ? bot.dashboard.metaAccountId : null, google: sources.google ? bot.dashboard.googleCustomerId : null, tiktok });
      done.push(bot.name);
    } catch (e) {
      failed.push(`${bot.name} : ${e instanceof Error ? e.message : String(e)}`.slice(0, 160));
    }
  }
  return NextResponse.json({ bots: bots.length, prepared: done.length, failed });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
