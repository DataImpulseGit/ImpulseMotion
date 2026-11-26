/**
 * POST /api/bot/[botId]/routines/[rid]/run → refreshes a page now.
 *   202 { jobId, conversationId }  — a detached turn, followed like any reply of the bot.
 * Same limits as a message typed in the chat (quota of the day, budget, turns at once).
 */

import { after, NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";
import { startBotTurn } from "@/lib/bot-turn";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ botId: string; rid: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { botId, rid } = await params;
  const loaded = await loadBotFor(guard.session, botId);
  if (loaded.status !== 200) {
    return NextResponse.json({ error: loaded.status === 403 ? "forbidden" : "not found" }, { status: loaded.status });
  }
  const routine = await prisma.botRoutine.findFirst({ where: { id: rid, botId, userId: guard.session.userId }, select: { id: true, conversationId: true, prompt: true } });
  if (!routine) return NextResponse.json({ error: "not found" }, { status: 404 });

  const turn = await startBotTurn({
    bot: loaded.bot,
    user: { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role },
    conversationId: routine.conversationId,
    message: routine.prompt,
    fresh: true,
    defer: (work) => after(work),
  });
  if (!turn.ok) return NextResponse.json({ error: turn.error, ...(turn.jobId ? { jobId: turn.jobId } : {}) }, { status: turn.status });
  await prisma.botRoutine.update({ where: { id: routine.id }, data: { lastRunAt: new Date() } });
  return NextResponse.json({ jobId: turn.jobId, conversationId: turn.conversationId }, { status: 202 });
}
