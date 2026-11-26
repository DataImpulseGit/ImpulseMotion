/**
 * /api/bot/[botId]/routines — the caller's own pages on one bot (saved questions shown as tabs).
 *   GET  → { routines: [{ id, conversationId, name, prompt, schedule, lastRunAt }] }
 *   POST { name, prompt, schedule? } → 201 { routine, jobId | null, error? }
 *        creates the page with its conversation and starts its first run.
 */

import { after, NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";
import { MAX_ROUTINES_PER_USER, ROUTINE_SELECT, cleanName, cleanPrompt, parseSchedule, publicRoutine } from "@/lib/bot-routines";
import { startBotTurn } from "@/lib/bot-turn";

type Params = { params: Promise<{ botId: string }> };

async function guardBot(botId: string) {
  const guard = await requireSession();
  if ("error" in guard) return { error: guard.error } as const;
  const loaded = await loadBotFor(guard.session, botId);
  if (loaded.status !== 200) {
    return { error: NextResponse.json({ error: loaded.status === 403 ? "forbidden" : "not found" }, { status: loaded.status }) } as const;
  }
  return { session: guard.session, bot: loaded.bot } as const;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const g = await guardBot(botId);
  if ("error" in g) return g.error;
  const rows = await prisma.botRoutine.findMany({
    where: { botId, userId: g.session.userId },
    select: ROUTINE_SELECT,
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json({ routines: rows.map(publicRoutine) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: Params) {
  const { botId } = await params;
  const g = await guardBot(botId);
  if ("error" in g) return g.error;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; prompt?: unknown; schedule?: unknown };
  const name = cleanName(body.name);
  const prompt = cleanPrompt(body.prompt);
  const schedule = body.schedule === undefined ? "manual" : parseSchedule(body.schedule);
  if (!name || !prompt) return NextResponse.json({ error: "Un nom et une question sont nécessaires." }, { status: 400 });
  if (!schedule) return NextResponse.json({ error: "Fréquence inconnue." }, { status: 400 });

  const userId = g.session.userId;
  const count = await prisma.botRoutine.count({ where: { botId, userId } });
  if (count >= MAX_ROUTINES_PER_USER) {
    return NextResponse.json({ error: `Limite de ${MAX_ROUTINES_PER_USER} pages atteinte : supprimez-en une pour en créer une autre.` }, { status: 429 });
  }
  const routine = await prisma.$transaction(async (tx) => {
    const conversation = await tx.botConversation.create({ data: { botId, userId, title: name, messagesJson: "[]" }, select: { id: true } });
    return tx.botRoutine.create({ data: { botId, userId, conversationId: conversation.id, name, prompt, schedule, position: count }, select: ROUTINE_SELECT });
  });

  // First run at once: the page opens on its answer being written.
  const turn = await startBotTurn({
    bot: g.bot,
    user: { id: userId, email: g.session.user?.email, role: g.session.role },
    conversationId: routine.conversationId,
    message: prompt,
    fresh: true,
    defer: (work) => after(work),
  });
  let lastRunAt: Date | null = null;
  if (turn.ok) {
    lastRunAt = new Date();
    await prisma.botRoutine.update({ where: { id: routine.id }, data: { lastRunAt } });
  }
  return NextResponse.json(
    { routine: publicRoutine({ ...routine, lastRunAt }), jobId: turn.ok ? turn.jobId : null, ...(turn.ok ? {} : { error: turn.error }) },
    { status: 201 },
  );
}
