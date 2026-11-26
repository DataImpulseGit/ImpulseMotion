/**
 * POST /api/bot/[botId]/chat → starts a detached turn of the assistant.
 *   body { conversationId, message }   →   202 { jobId, conversationId }
 *
 * The answer is produced by the relay whatever the browser does next (the
 * client may switch conversation, open a dashboard, close the tab). The
 * browser follows it through GET /api/ai/jobs/[jobId]/events and reloads the
 * conversation when it is over; the answer is stored by lib/ai-jobs.ts.
 *
 * The route owns persistence so the browser never writes messages itself;
 * the turn is built and started by lib/bot-turn.ts (shared with the pages of
 * the bot and their morning pass).
 */

import { after, NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";
import { MAX_MESSAGE_CHARS, startBotTurn } from "@/lib/bot-turn";

export async function POST(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { botId } = await params;
  const loaded = await loadBotFor(guard.session, botId);
  if (loaded.status !== 200) {
    return NextResponse.json({ error: loaded.status === 403 ? "forbidden" : "not found" }, { status: loaded.status });
  }
  const { bot } = loaded;

  const body = (await req.json().catch(() => ({}))) as { conversationId?: unknown; message?: unknown };
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE_CHARS) : "";
  if (!conversationId || !message) return NextResponse.json({ error: "conversationId et message requis" }, { status: 400 });

  const turn = await startBotTurn({
    bot,
    user: { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role },
    conversationId,
    message,
    defer: (work) => after(work),
  });
  if (!turn.ok) return NextResponse.json({ error: turn.error, ...(turn.jobId ? { jobId: turn.jobId } : {}) }, { status: turn.status });
  return NextResponse.json({ jobId: turn.jobId, conversationId: turn.conversationId }, { status: 202 });
}
