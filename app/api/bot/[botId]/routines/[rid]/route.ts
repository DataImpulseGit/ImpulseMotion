/**
 * /api/bot/[botId]/routines/[rid] — one of the caller's pages.
 *   PATCH { name?, prompt?, schedule? } → { routine }   (rename the tab, change the question or the frequency)
 *   DELETE → { ok: true }                               (the page and its runs)
 * A page owned by someone else is a 404.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";
import { ROUTINE_SELECT, cleanName, cleanPrompt, parseSchedule, publicRoutine } from "@/lib/bot-routines";
import { runningJobOf } from "@/lib/ai-jobs";

type Params = { params: Promise<{ botId: string; rid: string }> };

async function guardRoutine(botId: string, rid: string) {
  const guard = await requireSession();
  if ("error" in guard) return { error: guard.error } as const;
  const loaded = await loadBotFor(guard.session, botId);
  if (loaded.status !== 200) {
    return { error: NextResponse.json({ error: loaded.status === 403 ? "forbidden" : "not found" }, { status: loaded.status }) } as const;
  }
  const routine = await prisma.botRoutine.findFirst({ where: { id: rid, botId, userId: guard.session.userId }, select: ROUTINE_SELECT });
  if (!routine) return { error: NextResponse.json({ error: "not found" }, { status: 404 }) } as const;
  return { session: guard.session, routine } as const;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { botId, rid } = await params;
  const g = await guardRoutine(botId, rid);
  if ("error" in g) return g.error;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; prompt?: unknown; schedule?: unknown };
  const data: { name?: string; prompt?: string; schedule?: string } = {};
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return NextResponse.json({ error: "Le nom ne peut pas être vide." }, { status: 400 });
    data.name = name;
  }
  if (body.prompt !== undefined) {
    const prompt = cleanPrompt(body.prompt);
    if (!prompt) return NextResponse.json({ error: "La question ne peut pas être vide." }, { status: 400 });
    data.prompt = prompt;
  }
  if (body.schedule !== undefined) {
    const schedule = parseSchedule(body.schedule);
    if (!schedule) return NextResponse.json({ error: "Fréquence inconnue." }, { status: 400 });
    data.schedule = schedule;
  }
  if (!Object.keys(data).length) return NextResponse.json({ routine: publicRoutine(g.routine) });
  const routine = await prisma.botRoutine.update({ where: { id: g.routine.id }, data, select: ROUTINE_SELECT });
  // The tab's name is also the title of its conversation (Google Sheets exports, notices).
  if (data.name) await prisma.botConversation.update({ where: { id: routine.conversationId }, data: { title: data.name } });
  return NextResponse.json({ routine: publicRoutine(routine) });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { botId, rid } = await params;
  const g = await guardRoutine(botId, rid);
  if ("error" in g) return g.error;
  if (await runningJobOf(g.routine.conversationId, g.session.userId)) {
    return NextResponse.json({ error: "Une réponse est en cours sur cette page. Attendez qu'elle soit terminée." }, { status: 409 });
  }
  // The conversation carries the page (cascade).
  await prisma.botConversation.delete({ where: { id: g.routine.conversationId } });
  return NextResponse.json({ ok: true });
}
