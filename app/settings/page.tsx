"use client";

/**
 * Réglages — real account info (from the session), password change, and the
 * live status of the data integrations (Meta System User token, Google Ads via
 * the MCP relay). No mock data, no OAuth buttons for providers that don't exist.
 */

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Check, Loader2, AlertCircle, KeyRound, Plug } from "lucide-react";
import { Card, PageHeader, Pill, Section } from "@/components/ui/surface";

type IntegrationStatus = { state: "loading" | "ok" | "error"; detail: string };

function useIntegration(url: string, count: (json: unknown) => number, label: (n: number) => string): IntegrationStatus {
  const [status, setStatus] = useState<IntegrationStatus>({ state: "loading", detail: "Vérification…" });
  useEffect(() => {
    fetch(url)
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((json as { error?: string }).error ?? `Erreur ${r.status}`);
        const n = count(json);
        setStatus(n > 0 ? { state: "ok", detail: label(n) } : { state: "error", detail: "Aucun compte accessible" });
      })
      .catch((e) => setStatus({ state: "error", detail: e instanceof Error ? e.message : "Indisponible" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return status;
}

function IntegrationRow({ name, description, status, initial, color }: { name: string; description: string; status: IntegrationStatus; initial: string; color: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-ui-fg font-medium text-sm shrink-0 ${color}`}>{initial}</div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-ui-fg">{name}</div>
          <div className="text-xs text-ui-muted truncate">{description}</div>
        </div>
      </div>
      <div className="shrink-0 inline-flex items-center gap-2 text-xs">
        {status.state === "loading" && <Loader2 className="w-3.5 h-3.5 animate-spin text-ui-muted" />}
        {status.state === "ok" && <Check className="w-3.5 h-3.5 text-ui-pos" />}
        {status.state === "error" && <AlertCircle className="w-3.5 h-3.5 text-ui-warn" />}
        <span className={status.state === "ok" ? "text-ui-pos" : status.state === "error" ? "text-ui-warn" : "text-ui-muted"}>{status.detail}</span>
      </div>
    </div>
  );
}

type HookMode = "views3s" | "starts";
const HOOK_CHOICES: Array<{ mode: HookMode; label: string; help: string }> = [
  { mode: "views3s", label: "Vues de 3 secondes", help: "Part des impressions restées 3 secondes devant la vidéo. C'est le hook rate de Meta et de Motion : il départage les vidéos." },
  { mode: "starts", label: "Démarrages de vidéo", help: "Part des impressions où la vidéo a démarré, lecture automatique comprise : autour de 85 % sur toute vidéo." },
];

/** What « Hook » counts in the reports, the dashboards and the client pages — one choice for the whole app. */
function HookModeCard({ canEdit }: { canEdit: boolean }) {
  const [mode, setMode] = useState<HookMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/admin/hook-mode").then((r) => (r.ok ? r.json() : null)).then((j: { mode?: HookMode } | null) => setMode(j?.mode ?? null)).catch(() => setMode(null));
  }, []);
  async function choose(next: HookMode) {
    if (!canEdit || busy || next === mode) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/hook-mode", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: next }) });
      const j = (await res.json().catch(() => ({}))) as { mode?: HookMode; error?: string };
      if (!res.ok || !j.mode) throw new Error(j.error ?? `Erreur ${res.status}`);
      setMode(j.mode);
      setMsg({ text: "Enregistré. Les dashboards suivent dans la minute ; les rapports déjà rédigés gardent leurs chiffres.", ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Erreur", ok: false });
    } finally {
      setBusy(false);
    }
  }
  const current = HOOK_CHOICES.find((c) => c.mode === mode);
  return (
    <Card padded>
      <h2 className="text-sm font-medium text-ui-fg">Mesure du Hook (accroche vidéo)</h2>
      <p className="mt-1 text-xs leading-5 text-ui-muted">Ce que compte « Hook » dans les rapports, les dashboards et les fiches client. Un seul choix pour toute l&apos;application.</p>
      <div className="mt-3 inline-flex rounded-lg border border-ui-line p-0.5" role="group" aria-label="Mesure du Hook">
        {HOOK_CHOICES.map((c) => (
          <button
            key={c.mode} type="button" aria-pressed={mode === c.mode} disabled={!canEdit || busy || mode === null} onClick={() => void choose(c.mode)}
            className={`h-8 rounded-md px-3 text-xs ${mode === c.mode ? "bg-ui-raised font-medium text-ui-fg" : "text-ui-fg2 hover:bg-ui-raised"} disabled:cursor-default ${mode === c.mode ? "" : "disabled:opacity-60"}`}
          >
            {c.label}{c.mode === "views3s" && " (conseillé)"}
          </button>
        ))}
      </div>
      {current && <p className="mt-2 text-xs leading-5 text-ui-fg2">{current.help}</p>}
      {mode === null && <p className="mt-2 text-xs text-ui-muted">Lecture du réglage…</p>}
      {!canEdit && <p className="mt-2 text-xs text-ui-muted">Seul un administrateur peut changer ce réglage.</p>}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? "text-ui-pos" : "text-ui-neg"}`}>{msg.text}</p>}
      <p className="mt-2 text-[11px] leading-4 text-ui-muted">L&apos;onglet « Tests créa » des dashboards et l&apos;Analyse Ads comptent toujours les vues de 3 secondes.</p>
    </Card>
  );
}

export default function SettingsPage() {
  const { data: session } = useSession();
  const isStaff = session?.role === "admin" || session?.role === "consultant";

  const meta = useIntegration(
    "/api/meta/accounts",
    (j) => (Array.isArray(j) ? j.length : Array.isArray((j as { accounts?: unknown[] }).accounts) ? (j as { accounts: unknown[] }).accounts.length : 0),
    (n) => `Token System User actif · ${n} compte${n > 1 ? "s" : ""}`,
  );
  const google = useIntegration(
    isStaff ? "/api/admin/google-ads/accounts" : "/api/me/accounts",
    (j) => (Array.isArray((j as { accounts?: unknown[] }).accounts) ? (j as { accounts: Array<{ platform?: string }> }).accounts.filter((a) => !a.platform || a.platform === "google").length : 0),
    (n) => `Relay MCP joignable · ${n} compte${n > 1 ? "s" : ""}`,
  );

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwState, setPwState] = useState<{ busy: boolean; msg: string | null; ok: boolean }>({ busy: false, msg: null, ok: false });

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) { setPwState({ busy: false, msg: "Les deux nouveaux mots de passe diffèrent.", ok: false }); return; }
    setPwState({ busy: true, msg: null, ok: false });
    const res = await fetch("/api/me/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current, next }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok) { setPwState({ busy: false, msg: "Mot de passe mis à jour.", ok: true }); setCurrent(""); setNext(""); setConfirm(""); }
    else setPwState({ busy: false, msg: j.error ?? `Erreur ${res.status}`, ok: false });
  }

  const inputCls = "w-full bg-ui-bg border border-ui-line rounded-lg px-3 py-2 text-sm text-ui-fg focus:outline-none focus:border-ui-accent";

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <PageHeader title="Réglages" subtitle={isStaff ? "Votre compte et l'état des connexions aux plateformes publicitaires." : "Votre compte et votre mot de passe."} />

      {/* Internal plumbing (tokens, relay): staff only — a client only needs their account. */}
      {isStaff && (
      <Section title={<span className="flex items-center gap-2"><Plug className="w-4 h-4 text-ui-accent-ink" /> Intégrations</span>}>
        <div className="divide-y divide-ui-line">
          <IntegrationRow name="Meta Ads" description="Token System User partagé (Business Manager Impulse) — accès par compte géré dans Utilisateurs & accès." status={meta} initial="f" color="bg-blue-600" />
          <IntegrationRow name="Google Ads" description="Accès via le relay MCP (mcp-google-ads) — aucune OAuth côté utilisateur." status={google} initial="G" color="bg-emerald-600" />
        </div>
        <div className="px-4 py-3 text-xs text-ui-muted border-t border-ui-line">
          L&apos;IA (rapports, chat, analyse créas) passe par le relay Impulse (Claude). Aucune clé API n&apos;est stockée dans l&apos;application.
        </div>
      </Section>
      )}

      {isStaff && <HookModeCard canEdit={session?.role === "admin"} />}

      <Card padded>
        <h2 className="text-sm font-medium text-ui-fg mb-3">Compte</h2>
        <dl className="grid grid-cols-3 gap-y-2 text-sm">
          <dt className="text-ui-muted">Nom</dt><dd className="col-span-2 text-ui-fg">{session?.user?.name ?? "—"}</dd>
          <dt className="text-ui-muted">Email</dt><dd className="col-span-2 text-ui-fg">{session?.user?.email ?? "—"}</dd>
          <dt className="text-ui-muted">Rôle</dt><dd className="col-span-2"><Pill tone="violet">{session?.role ?? "client"}</Pill></dd>
        </dl>
      </Card>

      <Card padded>
        <h2 className="text-sm font-medium text-ui-fg mb-3 flex items-center gap-2"><KeyRound className="w-4 h-4 text-ui-accent-ink" /> Changer le mot de passe</h2>
        <form onSubmit={changePassword} className="space-y-3 max-w-sm">
          <input type="password" autoComplete="current-password" placeholder="Mot de passe actuel" value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} required />
          <input type="password" autoComplete="new-password" placeholder="Nouveau mot de passe (12 caractères min.)" value={next} onChange={(e) => setNext(e.target.value)} className={inputCls} required minLength={12} />
          <input type="password" autoComplete="new-password" placeholder="Confirmer le nouveau mot de passe" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputCls} required />
          {pwState.msg && <div className={`text-xs ${pwState.ok ? "text-ui-pos" : "text-ui-neg"}`}>{pwState.msg}</div>}
          <button type="submit" disabled={pwState.busy} className="px-4 py-2 rounded-lg bg-ui-accent hover:brightness-110 disabled:opacity-50 text-ui-fg text-sm font-medium">
            {pwState.busy ? "Mise à jour…" : "Mettre à jour"}
          </button>
        </form>
      </Card>
    </div>
  );
}
