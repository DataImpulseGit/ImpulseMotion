"use client";

/**
 * Widget « Tests créa (labo) + learnings » of a client dashboard.
 *   - the tally of the tests and the facts read from the figures;
 *   - the learnings written for the client (drafted by the AI on a consultant's
 *     request, or typed by them) — the client only reads them;
 *   - one card per test: verdict, figures, its creatives with their own cost.
 * Data and rules: lib/ab-tests.ts, resolved in lib/dashboard-widgets.ts.
 */

import { useContext, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, ArrowUp, Loader2, Pencil, Play, Sparkles, Trophy, X } from "lucide-react";
import type { ResolvedWidget } from "@/lib/dashboard-types";
import { AB_TESTS_ADS_SHOWN, AB_TESTS_LEARNINGS_CHARS, VERDICT_LABEL, type AbTest, type AbTestsSummary, type TestAd, type TestBreakdown, type TestLine, type TestVerdict } from "@/lib/ab-tests";
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
  winner: ["marche", "marchent"], average: ["dans la moyenne", "dans la moyenne"], loser: ["ne marche pas", "ne marchent pas"], early: ["trop tôt", "trop tôt"],
};

const img = (url: string) => `/api/media/proxy-image?url=${encodeURIComponent(url)}&upgrade=1`;

const pct = (n: number) => `${fmtNumber(n, n < 10 ? 1 : 0)} %`;
const SHORT_VERDICT: Record<TestVerdict, string> = { winner: "Marche", loser: "Ne marche pas", average: "Moyen", early: "Trop tôt" };

/** A creative in words: its angle and mechanic when its name follows the convention, else its name. */
const creativeLabel = (a: TestAd) => a.tags.filter((t) => t.key === "m" || t.key === "f").map((t) => t.value).join(" · ") || a.name;
/** Concept and hook are written as one glued word in the names: left to the name itself. */
const shownTags = (a: TestAd) => a.tags.filter((t) => t.key !== "co" && t.key !== "ho");

/** Retention of a video: the 3 s hook, then the share still watching at each quarter. */
function Retention({ a, labels }: { a: TestAd; labels?: boolean }) {
  if (!a.retention) return null;
  const steps: Array<[string, number]> = [["3 s", a.hookRate], ["25 %", a.retention.p25], ["50 %", a.retention.p50], ["75 %", a.retention.p75], ["fin", a.retention.p100]];
  const max = Math.max(...steps.map(([, v]) => v), 0.01);
  return (
    <div className="mt-1" title={`Part des impressions encore devant la vidéo — ${steps.map(([l, v]) => `${l} : ${pct(v)}`).join(" · ")}`}>
      <div className={`flex items-end gap-0.5 ${labels ? "h-14" : "h-5"}`}>
        {steps.map(([l, v], i) => (
          <span key={l} className={`flex-1 rounded-sm ${i === 0 ? "bg-ui-accent" : "bg-ui-accent/45"}`} style={{ height: `${Math.max(6, (v / max) * 100)}%` }} />
        ))}
      </div>
      {labels ? (
        <div className="mt-1 flex gap-0.5 text-center text-[10px] leading-4 text-ui-muted tabular-nums">
          {steps.map(([l, v]) => <span key={l} className="flex-1"><span className="block text-ui-fg2">{pct(v)}</span>{l}</span>)}
        </div>
      ) : (
        <div className="mt-0.5 truncate text-[10px] text-ui-muted tabular-nums">3 s {pct(a.hookRate)} · fin {pct(a.retention.p100)}</div>
      )}
    </div>
  );
}

/** A visual shown whole (never cropped) over a blurred copy of itself. */
function Visual({ a }: { a: TestAd }) {
  if (!a.imageUrl) return <div className="flex h-full w-full items-center justify-center text-[10px] text-ui-muted">sans visuel</div>;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img(a.imageUrl)} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-150 object-cover opacity-60 blur-xl" loading="lazy" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img(a.imageUrl)} alt={a.name} className="absolute inset-0 h-full w-full object-contain" loading="lazy" />
    </>
  );
}

/** The creative in full: the video played (or the image at full size), its result beside. */
function Viewer({ a, test, currency, videoSrc, onClose }: { a: TestAd; test: AbTest; currency?: string; videoSrc: string; onClose: () => void }) {
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(a.formats[0]?.id ?? "");
  const current = a.formats.find((f) => f.id === version);
  const poster = current?.poster ?? a.imageUrl;
  const src = version ? `${videoSrc}&v=${version}` : videoSrc;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={a.name}>
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-ui-line bg-ui-card md:flex-row" onClick={(e) => e.stopPropagation()}>
        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
          {a.video && !failed ? (
            <video key={src} src={src} poster={poster ? img(poster) : undefined} controls autoPlay playsInline onError={() => setFailed(true)} className="max-h-[86vh] w-full object-contain" />
          ) : a.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={img(a.imageUrl)} alt={a.name} className="max-h-[86vh] w-full object-contain" />
          ) : (
            <div className="p-10 text-sm text-ui-muted">sans visuel</div>
          )}
          {a.video && failed && <div className="absolute inset-x-0 bottom-0 bg-black/70 px-3 py-2 text-center text-xs text-white">La vidéo n&apos;est pas lisible ici pour le moment.</div>}
        </div>
        <div className="w-full shrink-0 overflow-y-auto p-4 md:w-72">
          <div className="flex items-start justify-between gap-2">
            <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${VERDICT_CLS[a.verdict]}`}>{VERDICT_LABEL[a.verdict]}</span>
            <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-ui-fg2 hover:bg-ui-raised" aria-label="Fermer"><X className="h-4 w-4" strokeWidth={1.5} /></button>
          </div>
          <div className="mt-3 text-xs text-ui-muted">Test « {test.name} »</div>
          <div className="mt-1 break-words text-sm font-medium leading-5 text-ui-fg">{creativeLabel(a)}</div>
          {a.tags.length > 0 && <div className="mt-1 break-all text-[10px] leading-4 text-ui-muted">{a.name}</div>}
          {a.video && a.formats.length > 1 && (
            <div className="mt-3">
              <div className="text-[11px] text-ui-muted">Versions de la vidéo</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {a.formats.map((f) => (
                  <button key={f.id} type="button" aria-pressed={f.id === version} onClick={() => { setFailed(false); setVersion(f.id); }} className={`h-7 rounded-md px-2 text-[11px] ${f.id === version ? "bg-ui-raised font-medium text-ui-fg" : "text-ui-fg2 hover:bg-ui-raised"}`}>{f.label}</button>
                ))}
              </div>
              <div className="mt-1 text-[10px] leading-4 text-ui-muted">Les chiffres couvrent toutes les versions ensemble.</div>
            </div>
          )}
          <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 text-sm tabular-nums">
            <div><dt className="text-[11px] text-ui-muted">Dépense</dt><dd className="text-ui-fg">{fmtMoney(a.spend, currency, { digits: 0 })}</dd></div>
            <div><dt className="text-[11px] text-ui-muted">Conversions</dt><dd className="text-ui-fg">{fmtNumber(a.conversions, 1)}</dd></div>
            <div><dt className="text-[11px] text-ui-muted">Coût / conversion</dt><dd className="text-ui-fg">{a.cpa > 0 ? fmtMoney(a.cpa, currency) : "—"}</dd></div>
            <div><dt className="text-[11px] text-ui-muted">ROAS</dt><dd className="text-ui-fg">{a.roas > 0 ? fmtRoas(a.roas) : "—"}</dd></div>
            <div><dt className="text-[11px] text-ui-muted">Taux de clic</dt><dd className="text-ui-fg">{pct(a.ctr)}</dd></div>
          </dl>
          {a.tags.length > 0 && (
            <dl className="mt-5 space-y-1.5 border-t border-ui-line pt-4 text-xs">
              {shownTags(a).map((t) => <div key={t.key} className="flex gap-2"><dt className="w-20 shrink-0 text-ui-muted">{t.label}</dt><dd className="min-w-0 break-words text-ui-fg">{t.value}</dd></div>)}
            </dl>
          )}
          {a.retention && (
            <div className="mt-5">
              <div className="text-[11px] text-ui-muted">Part des impressions encore devant la vidéo</div>
              <Retention a={a} labels />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TestCard({ t, ads, currency, onOpen }: { t: AbTest; ads: TestAd[]; currency?: string; onOpen: (a: TestAd) => void }) {
  const shown = ads.slice(0, AB_TESTS_ADS_SHOWN);
  const more = ads.length - shown.length;
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
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {shown.map((a) => (
          <div key={a.adId} className="min-w-0" title={a.name}>
            <button
              type="button" onClick={() => onOpen(a)} aria-label={a.video ? `Regarder la vidéo ${a.name}` : `Agrandir ${a.name}`}
              className={`group relative block aspect-[4/5] w-full overflow-hidden rounded-lg bg-ui-card ${a.best ? "ring-2 ring-ui-pos" : "border border-ui-line"}`}
            >
              <Visual a={a} />
              {a.video && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white transition group-hover:scale-110 group-hover:bg-black/70"><Play className="ml-0.5 h-4 w-4" fill="currentColor" strokeWidth={0} /></span>
                </span>
              )}
              {a.best && <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-ui-pos text-white" title="Meilleure créa du test"><Trophy className="h-3 w-3" strokeWidth={2} /></span>}
            </button>
            <div className="mt-1.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${VERDICT_CLS[a.verdict]}`}>{SHORT_VERDICT[a.verdict]}</span></div>
            <div className="mt-1 truncate text-[11px] text-ui-fg2">{creativeLabel(a)}</div>
            <div className="text-[11px] text-ui-muted tabular-nums">
              {a.conversions > 0 ? `${fmtMoney(a.cpa, currency)} / conv.` : `${fmtMoney(a.spend, currency, { digits: 0 })}, 0 conv.`}
            </div>
            <Retention a={a} />
          </div>
        ))}
      </div>
      {more > 0 && <div className="mt-2 text-[11px] text-ui-muted">+ {more} autre{more > 1 ? "s" : ""} créa{more > 1 ? "s" : ""} dans ce test</div>}
    </div>
  );
}

/** One video of the tests on its own: the frame at the video's ratio, what it is a test of, its result. */
function VideoCard({ a, t, currency, onOpen }: { a: TestAd; t: AbTest; currency?: string; onOpen: () => void }) {
  return (
    <div className="min-w-0 rounded-xl border border-ui-line bg-ui-bg p-2.5">
      <button type="button" onClick={onOpen} aria-label={`Regarder la vidéo ${a.name}`} className="group relative block aspect-[9/16] w-full overflow-hidden rounded-lg bg-ui-card">
        <Visual a={a} />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white transition group-hover:scale-110 group-hover:bg-black/70"><Play className="ml-0.5 h-5 w-5" fill="currentColor" strokeWidth={0} /></span>
        </span>
        <span className={`absolute left-2 top-2 rounded-md px-2 py-0.5 text-[11px] font-medium backdrop-blur ${VERDICT_SOLID[a.verdict]}`}>{SHORT_VERDICT[a.verdict]}</span>
      </button>
      <div className="mt-2 truncate text-sm font-medium text-ui-fg" title={`${t.name} — ${a.name}`}>{t.name}</div>
      {a.tags.length > 0 && <div className="truncate text-[11px] text-ui-fg2">{creativeLabel(a)}</div>}
      <div className="mt-0.5 text-[11px] text-ui-muted tabular-nums">
        {fmtMoney(a.spend, currency, { digits: 0 })} · {fmtNumber(a.conversions, 1)} conv.{a.cpa > 0 && <> · {fmtMoney(a.cpa, currency)} / conv.</>}
      </div>
      <Retention a={a} />
    </div>
  );
}

/** Verdict over a picture: opaque enough to read on any frame. */
const VERDICT_SOLID: Record<TestVerdict, string> = {
  winner: "bg-ui-pos text-white",
  loser: "bg-ui-neg text-white",
  average: "bg-black/65 text-white",
  early: "bg-black/65 text-white",
};

type SortKey = "name" | "ads" | "spend" | "conversions" | "cpa" | "roas";
const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "ads", label: "Créas" }, { key: "spend", label: "Dépense" }, { key: "conversions", label: "Conversions" }, { key: "cpa", label: "Coût / conv." }, { key: "roas", label: "ROAS" },
];
const VERDICT_TEXT: Record<TestVerdict, string> = { winner: "text-ui-pos", loser: "text-ui-neg", average: "text-ui-fg", early: "text-ui-muted" };

/** Figures per line, green / red against the reference, sortable by any column. */
function LinesTable({ lines, first, currency }: { lines: TestLine[]; first: string; currency?: string }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "spend", dir: -1 });
  // A line without conversion has no cost: last when the cheapest come first.
  const value = (l: TestLine) => (sort.key === "cpa" && l.cpa === 0 ? Infinity * sort.dir : l[sort.key]);
  const sorted = [...lines].sort((a, b) => {
    const x = value(a), y = value(b);
    return (typeof x === "string" && typeof y === "string" ? x.localeCompare(y, "fr") : (x as number) - (y as number)) * sort.dir;
  });
  const head = (key: SortKey, label: string, align: string) => (
    <th key={key} scope="col" className={`px-3 py-2 font-medium ${align}`} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" || key === "cpa" ? 1 : -1 }))} className="inline-flex items-center gap-1 hover:text-ui-fg">
        {label}{sort.key === key && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" strokeWidth={1.5} /> : <ArrowDown className="h-3 w-3" strokeWidth={1.5} />)}
      </button>
    </th>
  );
  return (
    <div className="overflow-x-auto rounded-xl border border-ui-line">
      <table className="w-full min-w-[640px] text-sm tabular-nums">
        <thead className="bg-ui-raised text-[11px] text-ui-fg2">
          <tr>{head("name", first, "text-left")}{COLUMNS.map((c) => head(c.key, c.label, "text-right"))}<th scope="col" className="px-3 py-2 text-right font-medium">Résultat</th></tr>
        </thead>
        <tbody>
          {sorted.map((l) => (
            <tr key={l.id} className="border-t border-ui-line">
              <td className="max-w-[280px] truncate px-3 py-2 text-ui-fg" title={l.name}>{l.name}{l.video && <span title="Avec vidéo"><Play className="ml-1.5 inline h-2.5 w-2.5 text-ui-muted" fill="currentColor" strokeWidth={0} aria-label="avec vidéo" /></span>}</td>
              <td className="px-3 py-2 text-right text-ui-fg2">{l.ads}</td>
              <td className="px-3 py-2 text-right text-ui-fg">{fmtMoney(l.spend, currency, { digits: 0 })}</td>
              <td className="px-3 py-2 text-right text-ui-fg">{fmtNumber(l.conversions, 1)}</td>
              <td className={`px-3 py-2 text-right font-medium ${VERDICT_TEXT[l.verdict]}`}>{l.cpa > 0 ? fmtMoney(l.cpa, currency) : "—"}</td>
              <td className={`px-3 py-2 text-right ${VERDICT_TEXT[l.verdict]}`}>{l.roas > 0 ? fmtRoas(l.roas) : "—"}</td>
              <td className="px-3 py-2 text-right"><span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${VERDICT_CLS[l.verdict]}`}>{SHORT_VERDICT[l.verdict]}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** « Ce qui marche par angle » : the ads of the tests grouped by what their names say. */
function Breakdowns({ list, currency }: { list: TestBreakdown[]; currency?: string }) {
  const [key, setKey] = useState(list[0]?.key ?? "");
  const current = list.find((b) => b.key === key) ?? list[0];
  if (!current) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-ui-muted">Regrouper les créas par</span>
        {list.map((b) => (
          <button key={b.key} type="button" aria-pressed={b.key === current.key} onClick={() => setKey(b.key)} className={`h-8 rounded-lg px-3 text-xs ${b.key === current.key ? "bg-ui-raised font-medium text-ui-fg" : "text-ui-fg2 hover:bg-ui-raised"}`}>{b.label}</button>
        ))}
      </div>
      <LinesTable key={current.key} lines={current.lines} first={current.label} currency={currency} />
    </div>
  );
}

type FormatFilter = "all" | "video" | "image" | "table" | "angles";
const FORMAT_LABEL: Record<FormatFilter, string> = { all: "Tous les tests", video: "Vidéos", image: "Images", table: "Tableau", angles: "Par angle" };

const videoCountOf = (tests: AbTest[] | undefined) => (tests ?? []).reduce((n, t) => n + t.ads.slice(0, AB_TESTS_ADS_SHOWN).filter((a) => a.video).length, 0);

export function AbTestsWidget({ widget, period }: { widget: ResolvedWidget; period?: string }) {
  const d = widget.data as AbTestsData;
  const staff = useContext(PilotLinksContext);
  const { id: dashboardId } = useParams<{ id: string }>();
  const [learnings, setLearnings] = useState(d.learnings ?? "");
  const [at, setAt] = useState<string | null>(d.learningsAt ?? null);
  const [busy, setBusy] = useState<"ai" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [format, setFormat] = useState<FormatFilter>("all");
  const [open, setOpen] = useState<{ a: TestAd; t: AbTest } | null>(null);
  // Tests of a format: those with a creative of that format, showing those creatives only.
  const keep = (a: TestAd) => format !== "video" && format !== "image" ? true : a.video === (format === "video");
  const views: FormatFilter[] = ["all", ...(videoCountOf(d.tests) > 0 ? (["video", "image"] as FormatFilter[]) : []), "table", ...((d.breakdowns?.length ?? 0) > 0 ? (["angles"] as FormatFilter[]) : [])];
  const visible = (d.tests ?? []).map((t) => ({ t, ads: t.ads.filter(keep) })).filter((x) => x.ads.length > 0);
  const videoCount = videoCountOf(d.tests);

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

      {(
        <div className="flex flex-wrap items-center gap-1">
          {views.map((f) => (
            <button
              key={f} type="button" onClick={() => setFormat(f)} aria-pressed={format === f}
              className={`h-8 rounded-lg px-3 text-xs ${format === f ? "bg-ui-raised font-medium text-ui-fg" : "text-ui-fg2 hover:bg-ui-raised"}`}
            >
              {FORMAT_LABEL[f]}{f === "video" && <span className="ml-1.5 tabular-nums text-ui-muted">{videoCount}</span>}
            </button>
          ))}
          {format !== "table" && format !== "angles" && <span className="ml-2 text-[11px] text-ui-muted">Cliquez sur une créa pour la voir en grand{videoCount > 0 ? " ou lancer la vidéo" : ""}.</span>}
        </div>
      )}
      {format === "table" ? (
        <LinesTable lines={d.lines ?? []} first="Test" currency={d.currency} />
      ) : format === "angles" ? (
        <Breakdowns list={d.breakdowns ?? []} currency={d.currency} />
      ) : format === "video" ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {visible.flatMap(({ t, ads }) => ads.slice(0, AB_TESTS_ADS_SHOWN).map((a) => <VideoCard key={a.adId} a={a} t={t} currency={d.currency} onOpen={() => setOpen({ a, t })} />))}
        </div>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {visible.map(({ t, ads }) => <TestCard key={t.adsetId} t={t} ads={ads} currency={d.currency} onOpen={(a) => setOpen({ a, t })} />)}
        </div>
      )}
      {open && (
        <Viewer
          a={open.a} test={open.t} currency={d.currency} onClose={() => setOpen(null)}
          videoSrc={`/api/dashboards/${dashboardId}/widgets/${widget.id}/video?adId=${open.a.adId}`}
        />
      )}
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
                  onClick={() => void post({ tests: d.tests, breakdowns: d.breakdowns, benchmark: d.benchmark, labo: d.labo, period: period ?? "", currency: d.currency ?? "" }, "ai")}
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

      <p className="text-[11px] leading-4 text-ui-muted">
        {d.total > d.tests.length && <>{d.tests.length} tests affichés sur {d.total}. </>}
        Un test est un ensemble de publicités dont la campagne ou le nom contient « {d.match} ». Marche : au moins 3 conversions, au coût du repère ou en dessous. Ne marche pas : coût supérieur de 30 % au repère, ou aucune conversion après une fois et demie ce coût dépensé. Sous chaque vidéo : la part des impressions encore devant la vidéo à 3 secondes, puis à 25, 50, 75 et 100 % de sa durée.
      </p>
    </div>
  );
}
