/**
 * POST /api/dashboards/[id]/widgets/[wid]/learnings — staff: the learnings of a
 * « Tests créa (labo) » widget.
 *   { tests, benchmark, period }  → the AI drafts them from the tests shown, they are saved on the widget
 *   { text }                      → the consultant's own text is saved ("" clears them)
 * → { learnings, learningsAt }
 *
 * Staff only: the client reads what a consultant asked for or wrote, never a
 * text produced on their own click. The AI runs on the relay (staff
 * subscription), without any tool: it only sees the figures sent here.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { validateWidgetConfig } from "@/lib/dashboard-widgets";
import { relayComplete } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import { AB_TESTS_LEARNINGS_CHARS, VERDICT_LABEL, type AbTest, type TestBreakdown } from "@/lib/ab-tests";

export const maxDuration = 120;

const SYSTEM = `Tu es consultant média senior dans une agence d'acquisition. On te donne les tests créatifs d'un client sur Meta Ads (un test = un ensemble de publicités, avec ses créas), jugés entre eux contre un coût par conversion de référence sur la même période.

Rédige les learnings pour le client, en français, en Markdown, 120 à 220 mots :
- « **Ce qui marche** » : 2 ou 3 puces. Les angles, promesses, cibles ou formats qui ressortent des tests gagnants. Appuie chaque puce sur un chiffre fourni (coût par conversion, conversions, ROAS).
- « **Ce qui ne marche pas** » : 1 ou 2 puces, même règle.
- « **Prochains tests** » : 2 puces concrètes, déduites de ce qui précède.

Règles strictes :
- N'utilise que les chiffres fournis. N'invente ni chiffre, ni nom de test, ni cause que les données ne montrent pas.
- Lis les angles dans les noms des tests et des créas ; si un nom ne dit rien, n'en déduis rien.
- Un test « trop tôt pour conclure » n'est ni un succès ni un échec : ne le classe pas.
- S'il y a trop peu de tests concluants pour dégager une tendance, dis-le en une phrase plutôt que de forcer une conclusion.
- Pas de titre, pas d'introduction, pas de conclusion, pas d'emoji. Vouvoiement.`;

type Body = { text?: unknown; tests?: unknown; breakdowns?: unknown; benchmark?: unknown; labo?: unknown; period?: unknown; currency?: unknown };

function compactTests(raw: unknown): string {
  const tests = (Array.isArray(raw) ? raw : []).slice(0, 30) as AbTest[];
  return tests.map((t) => {
    const ads = (Array.isArray(t.ads) ? t.ads : []).slice(0, 6)
      .map((a) => `    - ${String(a.name).slice(0, 120)} (${a.video ? "vidéo" : "image"}) : dépense ${a.spend}, conversions ${a.conversions}, coût/conv ${a.cpa || "—"}, ROAS ${a.roas}, CTR ${a.ctr} %${a.video ? `, accroche 3 s ${a.hookRate} %${a.retention ? `, encore devant la vidéo à 25 / 50 / 75 / 100 % de sa durée : ${a.retention.p25} / ${a.retention.p50} / ${a.retention.p75} / ${a.retention.p100} % des impressions` : ""}` : ""}`)
      .join("\n");
    return `- Test « ${String(t.name).slice(0, 120)} » — ${VERDICT_LABEL[t.verdict] ?? t.verdict} : dépense ${t.spend}, conversions ${t.conversions}, coût/conv ${t.cpa || "—"}, ROAS ${t.roas}\n${ads}`;
  }).join("\n");
}

/** The same ads grouped by what their names say (angle, mechanic, sport…), as figures the AI may quote. */
function compactBreakdowns(raw: unknown): string {
  const list = (Array.isArray(raw) ? raw : []).slice(0, 8) as TestBreakdown[];
  const blocks = list.map((b) => {
    const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 12)
      .map((l) => `    - ${String(l.name).slice(0, 60)} : ${l.ads} créas, dépense ${l.spend}, conversions ${l.conversions}, coût/conv ${l.cpa || "—"}, ROAS ${l.roas} — ${VERDICT_LABEL[l.verdict] ?? l.verdict}`)
      .join("\n");
    return lines ? `- Par ${String(b.label).slice(0, 30).toLowerCase()} (lu dans les noms des créas) :\n${lines}` : "";
  }).filter(Boolean);
  return blocks.length ? `\n\nLes mêmes créas regroupées :\n${blocks.join("\n")}` : "";
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; wid: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id, wid } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;
  const widget = await prisma.dashboardWidget.findFirst({ where: { id: wid, dashboardId: id }, select: { id: true, type: true, config: true, dashboard: { select: { name: true } } } });
  if (!widget || widget.type !== "ab_tests") return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Body;
  let text: string;
  if (typeof body.text === "string") {
    text = body.text.trim();
  } else {
    const onlyTests = compactTests(body.tests);
    const tests = onlyTests && onlyTests + compactBreakdowns(body.breakdowns);
    if (!tests) return NextResponse.json({ error: "Aucun test à analyser sur cette période." }, { status: 400 });
    const b = (body.benchmark ?? {}) as { cpa?: number; roas?: number };
    const l = (body.labo ?? {}) as { cpa?: number; reference?: number };
    const prompt = `Client : ${widget.dashboard.name}\nPériode : ${String(body.period ?? "").slice(0, 60)}\nDevise : ${String(body.currency ?? "").slice(0, 8) || "non précisée"}\nRepères sur la période : tous les tests ensemble, coût par conversion ${l.cpa || "—"} ; campagnes du compte qui convertissent, coût par conversion ${b.cpa ?? "—"}, ROAS ${b.roas ?? "—"}. Les verdicts sont donnés contre ${l.reference || "—"} par conversion.\n\nTESTS :\n${tests}\n\nRédige les learnings.`;
    try {
      text = (await relayComplete(
        { messages: [{ role: "user", content: prompt }], systemPrompt: SYSTEM, allowedServers: [], accountScope: {}, model: "opus", effort: "low", maxTurns: 1 },
        {
          maxMs: 100_000,
          onUsage: (usage) => void recordAiUsage(usage, { feature: "copilot", dashboardId: id, clientName: widget.dashboard.name, user: { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role ?? "consultant" } }),
        },
      )).trim();
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "L'IA n'a pas répondu" }, { status: 502 });
    }
    if (!text) return NextResponse.json({ error: "L'IA n'a rien rédigé. Réessayez." }, { status: 502 });
  }
  text = text.slice(0, AB_TESTS_LEARNINGS_CHARS);

  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(widget.config || "{}"); } catch { /* keep {} */ }
  const learningsAt = text ? new Date().toISOString() : null;
  const config = validateWidgetConfig("ab_tests", { ...existing, learnings: text, learningsAt });
  await prisma.dashboardWidget.update({ where: { id: wid }, data: { config: JSON.stringify(config) } });
  return NextResponse.json({ learnings: text, learningsAt });
}
