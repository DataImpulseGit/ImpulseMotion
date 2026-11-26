/**
 * GET /api/cron/bot-routines — morning pass of the scheduled pages of the client bots.
 *
 * Every page whose frequency is due today (lib/bot-routines.ts) is refreshed
 * for its owner, as if they had pressed « Actualiser »: same access check
 * (the person must still be allowed on the bot), same quotas and budget, same
 * detached turn. The answer waits for them in the page.
 *
 * Several passes each morning (vercel.json): a page that could not start
 * (three turns already running for the person, relay busy) is taken by the
 * next pass; a page that did start is not due any more. BOT_ROUTINES_CRON=off
 * stops everything.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkCronAuth } from "@/lib/cron-auth";
import { loadBotFor } from "@/lib/bot-access";
import { isRoutineDue } from "@/lib/bot-routines";
import { startBotTurn } from "@/lib/bot-turn";

export const maxDuration = 300;

/** Turns started per pass: each one is a model call of up to ten minutes on the relay. */
const MAX_STARTS_PER_PASS = 12;

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.BOT_ROUTINES_CRON === "off") return NextResponse.json({ off: true });
  const deadline = Date.now() + 240_000;
  const now = new Date();
  const rows = await prisma.botRoutine.findMany({
    where: { schedule: { not: "manual" }, bot: { enabled: true } },
    select: {
      id: true, botId: true, conversationId: true, prompt: true, schedule: true, lastRunAt: true,
      user: { select: { id: true, email: true, role: true } },
    },
    orderBy: { lastRunAt: { sort: "asc", nulls: "first" } },
  });
  const due = rows.filter((r) => isRoutineDue(r.schedule, r.lastRunAt, now));
  let started = 0;
  const skipped: string[] = [];
  for (const r of due) {
    if (started >= MAX_STARTS_PER_PASS || Date.now() > deadline) break;
    try {
      // The right to the bot is read again at every run: a withdrawn access stops the page.
      const loaded = await loadBotFor({ userId: r.user.id, role: r.user.role }, r.botId);
      if (loaded.status !== 200) { skipped.push(`${r.id} : accès retiré`); continue; }
      const turn = await startBotTurn({ bot: loaded.bot, user: r.user, conversationId: r.conversationId, message: r.prompt, fresh: true });
      if (!turn.ok) { skipped.push(`${r.id} : ${turn.error}`.slice(0, 160)); continue; }
      await prisma.botRoutine.update({ where: { id: r.id }, data: { lastRunAt: new Date() } });
      started++;
    } catch (e) {
      skipped.push(`${r.id} : ${e instanceof Error ? e.message : String(e)}`.slice(0, 160));
    }
  }
  return NextResponse.json({ scheduled: rows.length, due: due.length, started, skipped });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
