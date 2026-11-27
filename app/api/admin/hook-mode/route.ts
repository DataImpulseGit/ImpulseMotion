/**
 * What « Hook » counts across the app (lib/hook-mode.ts).
 *   GET                              → { mode }   (staff)
 *   PUT { mode: "views3s" | "starts" } → { mode }   (admin)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireStaff } from "@/lib/auth-helpers";
import { readHookMode, writeHookMode } from "@/lib/hook-mode";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  return NextResponse.json({ mode: await readHookMode() }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as { mode?: unknown };
  if (body.mode !== "views3s" && body.mode !== "starts") return NextResponse.json({ error: "Choix inconnu." }, { status: 400 });
  return NextResponse.json({ mode: await writeHookMode(body.mode, guard.session.user?.email ?? guard.session.userId) });
}
