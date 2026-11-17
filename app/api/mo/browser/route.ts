/**
 * POST /api/mo/browser → opens (or finds) the caller's piloted browser on the
 * relay (server/browser.mjs) and returns what the « Navigateur » card frames:
 *   { url, token, expiresAt } — url = the relay's view page, token = a short view token (30 min) for this consultant only.
 * Staff only, behind MO_BROWSER=1. One browser at a time on the host: 409 with the colleague's name when it is taken.
 */

import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { RELAY_URLS } from "@/lib/relay-server";
import { moBrowserOpen } from "@/lib/mo/turn";

export const maxDuration = 60;

export async function POST() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const noStore = { "Cache-Control": "no-store" };
  if (!moBrowserOpen()) return NextResponse.json({ error: "Le navigateur piloté n'est pas activé." }, { status: 503, headers: noStore });
  // The card frames the relay's public address (never localhost).
  const relay = RELAY_URLS.find((u) => /^https:\/\//.test(u));
  const secret = process.env.RELAY_SHARED_SECRET || "";
  if (!relay || !secret) return NextResponse.json({ error: "Relay non configuré." }, { status: 503, headers: noStore });
  try {
    const res = await fetch(`${relay}/api/browser/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ userId: guard.session.userId, name: guard.session.user?.name ?? "" }),
      signal: AbortSignal.timeout(45_000),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; token?: string; expiresAt?: number; view?: string; error?: string } | null;
    if (!res.ok || !json?.ok || !json.token) return NextResponse.json({ error: json?.error || "Le navigateur n'a pas démarré." }, { status: res.status === 409 ? 409 : 502, headers: noStore });
    return NextResponse.json({ url: `${relay}${json.view ?? "/browser/view"}`, token: json.token, expiresAt: json.expiresAt }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "Le navigateur est injoignable pour l'instant." }, { status: 502, headers: noStore });
  }
}
