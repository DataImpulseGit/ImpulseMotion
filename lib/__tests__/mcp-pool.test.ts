/**
 * server/mcp-pool.mjs with a stand-in for mcporter's library: no network.
 * What must hold: same answers as the CLI, a lost connection is reopened, and
 * the caller is never left waiting — it gets a result, a timeout, or the hand
 * back (PoolUnavailable → the relay spawns mcporter as before).
 */
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain .mjs module of the relay
import { createMcpPool, PoolTimeout, PoolUnavailable } from "../../server/mcp-pool.mjs";

type Handler = (tool: string, args: unknown) => Promise<unknown>;

function fakeLibrary(handler: Handler, opts: { connect?: () => Promise<void>; close?: () => Promise<void> } = {}) {
  const counters = { connects: 0, closes: 0, pings: 0 };
  let ctx: { client: { ping: () => Promise<void>; onclose?: () => void }; transport: object } | null = null;
  let pingOk = true;
  const runtime = {
    async connect() {
      if (ctx) return ctx;
      await opts.connect?.();
      counters.connects++;
      ctx = { client: { ping: async () => { counters.pings++; if (!pingOk) await new Promise(() => {}); } }, transport: {} };
      return ctx;
    },
    async callTool(_server: string, tool: string, o: { args?: unknown }) { await runtime.connect(); return handler(tool, o.args); },
    async close() { counters.closes++; await opts.close?.(); ctx = null; },
  };
  const lib = {
    createRuntime: async () => runtime,
    wrapCallResult: (raw: unknown) => ({ callResult: { json: () => { const text = (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text; try { return text === undefined ? null : JSON.parse(text); } catch { return null; } } } }),
  };
  return { lib, counters, hangUp: () => ctx?.client.onclose?.(), setPing: (ok: boolean) => { pingOk = ok; } };
}
const json = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const pool = (f: ReturnType<typeof fakeLibrary>, extra: Record<string, unknown> = {}) => createMcpPool({ configPath: "x", loadLibrary: async () => f.lib, heartbeatMs: 0, ...extra });

describe("mcp pool", () => {
  it("rend le JSON de l'outil, sur une seule connexion pour plusieurs appels", async () => {
    const f = fakeLibrary(async (tool) => json({ tool }));
    const p = pool(f);
    expect(await p.call("s", "a", {}, 5000)).toEqual({ ok: true, value: { tool: "a" } });
    await Promise.all([p.call("s", "b", {}, 5000), p.call("s", "c", {}, 5000)]);
    expect(f.counters.connects).toBe(1);
    expect(p.stats().servers.s).toMatchObject({ connected: true, calls: 3, reconnects: 0, fallbacks: 0 });
  });

  it("une erreur de l'outil (réponse non JSON) revient comme texte, sans reconnexion", async () => {
    const f = fakeLibrary(async () => ({ content: [{ type: "text", text: "Error: PERMISSION_DENIED" }], isError: true }));
    const out = await pool(f).call("s", "a", {}, 5000);
    expect(out.ok).toBe(false);
    expect(out.toolError).toContain("PERMISSION_DENIED");
    expect(f.counters.connects).toBe(1);
  });

  it("connexion coupée par le serveur → rouverte au prochain appel", async () => {
    const f = fakeLibrary(async () => json(1));
    const p = pool(f);
    await p.call("s", "a", {}, 5000);
    f.hangUp();
    expect(p.stats().servers.s.connected).toBe(false);
    expect(await p.call("s", "a", {}, 5000)).toEqual({ ok: true, value: 1 });
    expect(f.counters.connects).toBe(2);
    expect(p.stats().servers.s.reconnects).toBe(1);
  });

  it("échec sur la connexion pendant l'appel → un nouvel essai sur une connexion neuve", async () => {
    let n = 0;
    const f = fakeLibrary(async () => { if (++n === 1) throw new Error("SSE error: socket hang up"); return json("ok"); });
    expect(await pool(f).call("s", "a", {}, 5000)).toEqual({ ok: true, value: "ok" });
    expect(f.counters.connects).toBe(2);
  });

  it("serveur injoignable → PoolUnavailable (repli), puis pause après 3 échecs", async () => {
    const f = fakeLibrary(async () => json(1), { connect: async () => { throw new Error("fetch failed"); } });
    const p = pool(f);
    for (let i = 0; i < 3; i++) await expect(p.call("s", "a", {}, 5000)).rejects.toBeInstanceOf(PoolUnavailable);
    const before = f.counters.closes;
    await expect(p.call("s", "a", {}, 5000)).rejects.toThrow(/en pause/);
    expect(f.counters.closes).toBe(before); // paused: the server is not even tried
    expect(p.stats().servers.s.pausedUntil).toBeTruthy();
  });

  it("délai de l'outil dépassé → PoolTimeout, jamais rejoué", async () => {
    let n = 0;
    const f = fakeLibrary(async () => { n++; throw new Error("MCP error -32001: Request timed out"); });
    await expect(pool(f).call("s", "a", {}, 5000)).rejects.toBeInstanceOf(PoolTimeout);
    expect(n).toBe(1);
  });

  it("rien ne répond jamais (appel ET fermeture bloqués) → le délai dur rend la main", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeLibrary(() => new Promise(() => {}), { close: () => new Promise(() => {}) });
      f.setPing(true);
      const p = pool(f);
      const got = p.call("s", "a", {}, 2000).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2000 + 3000 + 50);
      expect(await got).toBeInstanceOf(PoolTimeout);
    } finally { vi.useRealTimers(); }
  });

  it("ligne morte sans signal : le ping pendant l'appel la détecte, l'appel repart sur une connexion neuve", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const f = fakeLibrary(() => (++n === 1 ? new Promise(() => {}) : Promise.resolve(json("après reconnexion"))));
      const p = pool(f);
      f.setPing(false);
      const got = p.call("s", "a", {}, 20000);
      await vi.advanceTimersByTimeAsync(4000 + 3000 + 50); // watchdog, then the ping's own timeout
      f.setPing(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(await got).toEqual({ ok: true, value: "après reconnexion" });
      expect(f.counters.connects).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it("éteint (MCP_POOL=0) ou bibliothèque absente → PoolUnavailable tout de suite", async () => {
    const f = fakeLibrary(async () => json(1));
    await expect(pool(f, { enabled: false }).call("s", "a", {}, 5000)).rejects.toBeInstanceOf(PoolUnavailable);
    const broken = createMcpPool({ configPath: "x", loadLibrary: async () => { throw new Error("absente"); }, heartbeatMs: 0 });
    await expect(broken.call("s", "a", {}, 5000)).rejects.toBeInstanceOf(PoolUnavailable);
    expect(broken.stats().enabled).toBe(false);
  });
});
