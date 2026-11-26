"use client";

/**
 * Widget « Tests créa (labo) + learnings » of a client dashboard.
 *   - the tally of the tests and the facts read from the figures;
 *   - the learnings written for the client (drafted by the AI on a consultant's
 *     request, or typed by them) — the client only reads them;
 *   - one card per test: verdict, figures, its creatives with their own cost.
 * Data and rules: lib/ab-tests.ts, resolved in lib/dashboard-widgets.ts.
 */

import { useContext, useState } from "react";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, Pencil, Play, Sparkles, Trophy } from "lucide-react";
import type { ResolvedWidget } from "@/lib/dashboard-types";
import { AB_TESTS_ADS_SHOWN, AB_TESTS_LEARNINGS_CHARS, VERDICT_LABEL, type AbTest, type AbTestsSummary, type TestVerdict } from "@/lib/ab-tests";
import { fmtMoney, fmtNumber, fmtRoas } from "@/components/portfolio/format";
import { SAFE_MD_COMPONENTS } from "@/components/ai/safe-image";
import { PilotLinksContext } from "@/components/dashboard/renderers";

export interface AbTestsData extends AbTestsSummary {
  match: string;
  learnings: string;
  learningsAt: string | null;
  conversionEvent?: string;
  currency?: string;
  estimated?: boolean;
  unavailable?: boolean;
  truncated?: boolean;
  fetchedAt?: string;
}

const VERDICT_CLS: Record<TestVerdict, string> = {
  winner: "bg-ui-pos/15 text-ui-pos",
  loser: "bg-ui-neg/15 text-ui-neg",
  average: "bg-ui-raised text-ui-fg2",
  early: "bg-ui-raised text-ui-muted",
};
const VERDICT_ORDER: TestVerdict[] = ["winner", "average", "loser", "early"];
const TALLY_LABEL: Record<TestVerdict, [string, string]> = {
  winner: ["gagnant", "gagnants"], average: ["dans la moyenne", "dans la moyenne"], loser: ["perdant", "perdants"], early: ["trop tôt", "trop tôt"],
};

const img = (url: string) => `/api/media/proxy-image?url=${encodeURIComponent(url)}&upgrade=1`;

function TestCard({ t, currency }: { t: AbTest; currency?: string }) {
  const shown = t.ads.slice(0, AB_TESTS_ADS_SHOWN);
  const more = t.ads.length - shown.length;
  return (
    <div className="rounded-xl border border-ui-line bg-ui-bg p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ui-fg truncate" title={`${t.name} — ${t.campaign}`}>{t.name}</div>
          <div className="mt-0.5 text-[11px] text-ui-muted tabular-nums">
            {fmtMoney(t.spend, currency, { digits: 0 })} · {fmtNumber(t.conversions, 1)} conv.
            {t.cpa > 0 && <> · {fmtMoney(t.cpa, currency)} / conv.</>}
            {t.roas > 0 && <> · ROAS {fmtRoas(t.roas)}</>}
          </div>
        </div>
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${VERDICT_CLS[t.verdict]}`}>{VERDICT_LABEL[t.verdict]}</span>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {shown.map((a) => (
          <div key={a.adId} className="min-w-0" title={a.name}>
            <div className={`relative aspect-[4/5] overflow-hidden rounded-lg bg-ui-card ${a.best ? "ring-2 ring-ui-pos" : "border border-ui-line"}`}>
              {a.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img(a.imageUrl)} alt={a.name} className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-[10px] text-ui-muted">sans visuel</div>
              )}
              {a.video && <span className="absolute bottom-1 left-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/50 text-white"><Play className="h-2.5 w-2.5" fill="currentColor" strokeWidth={0} /></span>}
              {a.best && <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-ui-pos text-white" title="Meilleure créa du test"><Trophy className="h-3 w-3" strokeWidth={2} /></span>}
            </div>
            <div className="mt-1 truncate text-[11px] text-ui-fg2">{a.name}</div>
            <div className="text-[11px] text-ui-muted tabular-nums">
              {a.conversions > 0 ? `${fmtMoney(a.cpa, currency)} / conv.` : `${fmtMoney(a.spend, currency, { digits: 0 })}, 0 conv.`}
            </div>
          </div>
        ))}
      </div>
      {more > 0 && <div className="mt-2 text-[11px] text-ui-muted">+ {more} autre{more > 1 ? "s" : ""} créa{more > 1 ? "s" : ""} dans ce test</div>}
    </div>
  );
}

export function AbTestsWidget({ widget, period }: { widget: ResolvedWidget; period?: string }) {
  const d = widget.data as AbTestsData;
  const staff = useContext(PilotLinksContext);
  const { id: dashboardId } = useParams<{ id: string }>();
  const [learnings, setLearnings] = useState(d.learnings ?? "");
  const [at, setAt] = useState<string | null>(d.learningsAt ?? null);
  const [busy, setBusy] = useState<"ai" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, kind: "ai" | "save") {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/widgets/${widget.id}/learnings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { learnings?: string; learningsAt?: string | null; error?: string };
      if (!res.ok || typeof j.learnings !== "string") throw new Error(j.error ?? `Erreur ${res.status}`);
      setLearnings(j.learnings);
      setAt(j.learningsAt ?? null);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(null);
    }
  }

  if (!d.tests?.length) {
    return (
      <div className="py-4 text-sm text-ui-muted">
        Aucun test trouvé sur la période : aucune campagne ni ensemble de publicités dont le nom contient « {d.match} » n&apos;a dépensé.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {VERDICT_ORDER.filter((v) => d.counts[v] > 0).map((v) => (
          <span key={v} className={`rounded-md px-2 py-1 text-xs font-medium tabular-nums ${VERDICT_CLS[v]}`}>{d.counts[v]} {TALLY_LABEL[v][d.counts[v] > 1 ? 1 : 0]}</span>
        ))}
        {d.labo.reference > 0 && <span className="text-xs text-ui-muted">repère : {fmtMoney(d.labo.reference, d.currency)} par conversion ({d.labo.referenceIs === "labo" ? "tous les tests ensemble" : "campagnes du compte qui convertissent"})</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="text-xs font-medium text-ui-fg2">Constats</div>
          <ul className="mt-2 space-y-1.5 text-sm leading-6 text-ui-fg">
            {d.facts.map((f, i) => <li key={i} className="flex gap-2"><span className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-ui-muted" />{f}</li>)}
          </ul>
        </div>
        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-ui-fg2">Learnings</div>
            {staff && draft === null && (
              <div className="flex items-center gap-1">
                <button
                  type="button" disabled={!!busy}
                  onClick={() => void post({ tests: d.tests, benchmark: d.benchmark, labo: d.labo, period: period ?? "", currency: d.currency ?? "" }, "ai")}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-ui-accent-ink hover:bg-ui-raised disabled:opacity-50"
                  title="Le client verra le texte dès qu'il est rédigé"
                >
                  {busy === "ai" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" strokeWidth={1.5} />}
                  {busy === "ai" ? "Rédaction…" : learnings ? "Refaire avec l'IA" : "Rédiger avec l'IA"}
                </button>
                <button type="button" disabled={!!busy} onClick={() => setDraft(learnings)} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-ui-fg2 hover:bg-ui-raised disabled:opacity-50">
                  <Pencil className="h-3 w-3" strokeWidth={1.5} />{learnings ? "Modifier" : "Écrire"}
                </button>
              </div>
            )}
          </div>
          {draft !== null ? (
            <div className="mt-2">
              <textarea
                value={draft} onChange={(e) => setDraft(e.target.value)} rows={9} maxLength={AB_TESTS_LEARNINGS_CHARS}
                placeholder="Ce qui marche, ce qui ne marche pas, les prochains tests (Markdown)"
                className="w-full rounded-lg border border-ui-line bg-ui-bg px-3 py-2 text-sm leading-6 text-ui-fg focus:border-ui-accent focus:outline-none"
              />
              <div className="mt-2 flex items-center gap-2">
                <button type="button" disabled={!!busy} onClick={() => void post({ text: draft }, "save")} className="h-8 rounded-lg bg-ui-accent px-3 text-xs font-medium text-ui-on-accent hover:brightness-110 disabled:opacity-50">{busy === "save" ? "Enregistrement…" : "Enregistrer"}</button>
                <button type="button" disabled={!!busy} onClick={() => setDraft(null)} className="h-8 rounded-lg px-3 text-xs text-ui-fg2 hover:bg-ui-raised">Annuler</button>
              </div>
            </div>
          ) : learnings ? (
            <>
              <div className="ui-prose prose prose-sm mt-2 max-w-none prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0.5 prose-strong:font-medium">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={SAFE_MD_COMPONENTS}>{learnings}</ReactMarkdown>
              </div>
              {at && <div className="mt-2 text-[11px] text-ui-muted">Rédigés le {new Date(at).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })} par votre équipe Impulse Analytics</div>}
            </>
          ) : (
            <p className="mt-2 text-sm text-ui-muted">{staff ? "Pas encore de learnings : le client ne voit que les constats." : "Votre équipe Impulse Analytics complètera cette partie."}</p>
          )}
          {error && <div className="mt-2 text-xs text-ui-neg">{error}</div>}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {d.tests.map((t) => <TestCard key={t.adsetId} t={t} currency={d.currency} />)}
      </div>
      <p className="text-[11px] leading-4 text-ui-muted">
        {d.total > d.tests.length && <>{d.tests.length} tests affichés sur {d.total}. </>}
        Un test est un ensemble de publicités dont la campagne ou le nom contient « {d.match} ». Gagnant : au moins 3 conversions, au coût du repère ou en dessous. Perdant : coût supérieur de 30 % au repère, ou aucune conversion après une fois et demie ce coût dépensé.
      </p>
    </div>
  );
}
