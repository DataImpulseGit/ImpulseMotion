/**
 * GET /api/dashboards/[id]/widgets/[wid]/video?adId=… — the playable file of a
 * video shown in the « Tests du labo » widget, as a redirect to Meta's signed
 * CDN file (used directly as <video src>). Open to whoever may read the
 * dashboard (its client included); the ad must belong to the dashboard's Meta
 * account, and the video is one of the ad's own (`v` chooses between its
 * versions), never a free id from the request.
 * 404 when Meta does not expose the file (Page not assigned to the system user).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { loadDashboardFor } from "@/lib/dashboard-auth";
import { adVideoIds, getMetaSystemToken, metaGraphGet, type MetaAd } from "@/lib/meta-api";
import { getMetaVideoSource } from "@/lib/ads-warehouse/preview";

export const maxDuration = 30;

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; wid: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id, wid } = await params;
  const loaded = await loadDashboardFor(guard.session, id);
  if (loaded.status !== 200) return NextResponse.json({ error: loaded.status === 404 ? "not found" : "forbidden" }, { status: loaded.status });
  const { dashboard } = loaded;
  if (!dashboard.widgets.some((w) => w.id === wid && w.type === "ab_tests")) return NextResponse.json({ error: "not found" }, { status: 404 });
  const accountId = digits(dashboard.metaAccountId);
  const adId = req.nextUrl.searchParams.get("adId") ?? "";
  if (!accountId || !/^\d{5,30}$/.test(adId)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const ad = await metaGraphGet<Pick<MetaAd, "creative"> & { account_id?: string }>(`/${adId}`, getMetaSystemToken(), {
    fields: "account_id,creative{video_id,asset_feed_spec{videos},object_story_spec{video_data{video_id}}}",
  }).catch(() => null);
  if (!ad || digits(ad.account_id) !== accountId) return NextResponse.json({ error: "not found" }, { status: 404 });
  // `v` picks another version of the ad's video (square, landscape…): one of the ad's own, never a free id.
  const own = adVideoIds(ad);
  const asked = req.nextUrl.searchParams.get("v");
  const videoId = asked ? own.find((id) => id === asked) : own[0];
  if (!videoId) return NextResponse.json({ error: "pas de vidéo" }, { status: 404 });
  const src = await getMetaVideoSource(videoId, accountId, adId).catch(() => null);
  if (!src) return NextResponse.json({ error: "vidéo indisponible" }, { status: 404 });
  return NextResponse.redirect(src, { status: 302, headers: { "Cache-Control": "private, max-age=3600" } });
}
