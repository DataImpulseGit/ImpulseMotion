"use client";

/**
 * Body of a « Navigateur » card: the live view of the consultant's piloted
 * browser (a page of the relay, framed). The session is opened when the card
 * shows; the view token travels in the fragment, never in a request line.
 * The frame takes the mouse only while the card is selected, so the card
 * still drags and the board still pans over it.
 */

import { useEffect, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";

type State = { phase: "loading" } | { phase: "ready"; src: string } | { phase: "error"; message: string };

/** Opens (or finds) the caller's browser on the relay → what the card shows. */
async function openSession(): Promise<State> {
  try {
    const res = await fetch("/api/mo/browser", { method: "POST" });
    const json = (await res.json().catch(() => null)) as { url?: string; token?: string; error?: string } | null;
    if (!res.ok || !json?.url || !json.token) return { phase: "error", message: json?.error || "Le navigateur n'a pas démarré." };
    return { phase: "ready", src: `${json.url}#t=${encodeURIComponent(json.token)}` };
  } catch {
    return { phase: "error", message: "Le navigateur est injoignable pour l'instant." };
  }
}

export function MoBrowserBody({ selected }: { selected: boolean }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  /** Bumped to open again: « Réessayer », and the renewal of the view token. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    void openSession().then((next) => { if (alive) setState(next); });
    return () => { alive = false; };
  }, [attempt]);
  // While a pointer is held down on the board (the card is being moved or resized), the frame lets the mouse
  // through: the gesture is not swallowed by the frame, and nothing gets selected. Presses inside the frame
  // never reach this window, so using the browser is not affected.
  const [gesture, setGesture] = useState(false);
  useEffect(() => {
    const down = () => setGesture(true);
    const up = () => setGesture(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up);
    return () => { window.removeEventListener("pointerdown", down, true); window.removeEventListener("pointerup", up, true); window.removeEventListener("pointercancel", up, true); window.removeEventListener("blur", up); };
  }, []);
  // The view token lasts 30 minutes: the frame is renewed a little before.
  useEffect(() => {
    if (state.phase !== "ready") return;
    const t = window.setTimeout(() => setAttempt((n) => n + 1), 25 * 60_000);
    return () => window.clearTimeout(t);
  }, [state]);

  if (state.phase === "loading") return <div className="h-full min-h-[240px] flex items-center justify-center gap-2 text-[12px] text-ui-muted"><Loader2 className="w-4 h-4 animate-spin" /> Démarrage du navigateur…</div>;
  if (state.phase === "error") return (
    <div className="h-full min-h-[240px] flex flex-col items-center justify-center gap-3 text-center px-6">
      <p className="text-[12px] text-ui-fg2">{state.message}</p>
      <button type="button" onClick={(e) => { e.stopPropagation(); setState({ phase: "loading" }); setAttempt((n) => n + 1); }} className="inline-flex items-center gap-1.5 rounded-full border border-ui-line bg-ui-raised px-3 py-1 text-[12px] hover:bg-ui-hover"><RotateCw className="w-3.5 h-3.5" /> Réessayer</button>
    </div>
  );
  return (
    <div className="relative h-full min-h-[240px] rounded-lg overflow-hidden border border-ui-line bg-black select-none" onDragStart={(e) => e.preventDefault()}>
      <iframe src={state.src} title="Navigateur piloté" className="absolute inset-0 w-full h-full border-0" style={{ pointerEvents: selected && !gesture ? "auto" : "none", userSelect: "none" }} referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write" />
      {!selected && <div className="absolute inset-x-0 bottom-0 px-3 py-1.5 text-[11px] text-white/80 bg-black/60">Cliquez la carte pour utiliser le navigateur</div>}
    </div>
  );
}
