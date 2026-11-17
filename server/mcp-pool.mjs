/**
 * Persistent connections to the MCP servers behind /api/tool.
 *
 * Before: every direct tool call spawned `mcporter call …` — a new process, a
 * new connection and handshake to n8n, one question, exit: ~2 s of overhead a
 * call, and on this one-core server parallel calls queued behind each other.
 *
 * Here the relay keeps ONE connection per server open (mcporter's own runtime,
 * so transports and results are exactly the CLI's) and only asks the question.
 *
 * It must never be worse than the spawn it replaces:
 *  - a connection idle for more than PING_AFTER_MS is pinged before use; no
 *    answer in PING_TIMEOUT_MS → it is dropped and reopened first;
 *  - a heartbeat pings the open connections; a dead one is dropped at once and
 *    one unused for IDLE_CLOSE_MS is closed;
 *  - a call that fails on the connection (not a tool error, not a timeout) is
 *    retried once on a fresh connection (every tool here is read-only);
 *  - a call still waiting after WATCHDOG_MS has its line pinged: no answer →
 *    the line is dead (no close signal came), it is reopened and the call retried;
 *  - whatever still fails throws PoolUnavailable: the caller falls back on the
 *    `mcporter` process, as before;
 *  - three failures in a row on a server → that server skips the pool for
 *    BREAKER_MS (straight to the process), then tries again;
 *  - MCP_POOL=0 turns the whole thing off.
 */

import { inspect } from "node:util";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const PING_AFTER_MS = 20_000;
const PING_TIMEOUT_MS = 3_000;
const HEARTBEAT_MS = 45_000;
/** A call still waiting after this long has its line checked by a ping, so a silently dead connection is not waited on until the tool's timeout. */
const WATCHDOG_MS = 4_000;
const HARD_MARGIN_MS = 3_000;
const IDLE_CLOSE_MS = 30 * 60_000;
const CONNECT_TIMEOUT_MS = 10_000;
const BREAKER_AFTER = 3;
const BREAKER_MS = 2 * 60_000;

/** The pool cannot answer this call: use the fallback (the mcporter process). */
export class PoolUnavailable extends Error {
  constructor(message) { super(message); this.name = "PoolUnavailable"; }
}

/** A tool call that ran out of time: not a connection fault, never retried (the fallback would wait as long again). */
export class PoolTimeout extends Error {
  constructor(message) { super(message); this.name = "PoolTimeout"; }
}

const isTimeout = (err) => /timed? ?out|timeout|-32001/i.test(String(err?.message ?? err)) || err?.code === -32001;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The library of the very `mcporter` the relay would spawn: the one found on
 * PATH. No other location is tried — where the command is a stand-in (tests)
 * or absent, there is no library, the pool stays off and calls go by process.
 */
async function loadMcporter() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const bin = path.join(dir, "mcporter");
    if (!fs.existsSync(bin)) continue;
    // <package>/dist/cli.js ← the command (a symlink into the global package).
    const index = path.join(path.dirname(fs.realpathSync(bin)), "index.js");
    if (path.basename(path.dirname(index)) !== "dist" || !fs.existsSync(index)) break;
    return import(pathToFileURL(index).href);
  }
  throw new Error("bibliothèque mcporter introuvable à côté de la commande");
}

/**
 * @param {{ configPath: string, rootDir?: string, enabled?: boolean, log?: (...a: unknown[]) => void, loadLibrary?: () => Promise<any>, heartbeatMs?: number }} options
 */
export function createMcpPool({ configPath, rootDir, enabled = true, log = () => {}, loadLibrary = loadMcporter, heartbeatMs = HEARTBEAT_MS }) {
  /** @type {Promise<{ runtime: any, wrapCallResult: Function }> | null} */
  let ready = null;
  let disabledReason = enabled ? null : "désactivé (MCP_POOL=0)";
  /** server → { lastOkAt, lastUsedAt, connectedAt, calls, reconnects, fallbacks, failures, breakerUntil, lastError } */
  const state = new Map();
  let heartbeat = null;

  const stateOf = (server) => {
    let s = state.get(server);
    if (!s) { s = { lastOkAt: 0, lastUsedAt: 0, connectedAt: 0, calls: 0, reconnects: 0, fallbacks: 0, failures: 0, breakerUntil: 0, lastError: null }; state.set(server, s); }
    return s;
  };

  async function runtimeOf() {
    if (disabledReason) throw new PoolUnavailable(disabledReason);
    if (!ready) {
      ready = (async () => {
        const lib = await loadLibrary();
        const runtime = await lib.createRuntime({ configPath, rootDir, clientInfo: { name: "impulsemotion-relay", version: "1" } });
        return { runtime, wrapCallResult: lib.wrapCallResult };
      })();
      ready.catch((e) => { disabledReason = `indisponible : ${e.message}`; log(`pool désactivé — ${e.message}`); });
    }
    try { return await ready; } catch (e) { throw new PoolUnavailable(e.message); }
  }

  async function drop(server, why) {
    const s = stateOf(server);
    if (!s.connectedAt) return;
    s.connectedAt = 0;
    if (why) log(`${server} : connexion fermée (${why})`);
    try { const { runtime } = await runtimeOf(); await withTimeout(runtime.close(server), 5_000, "close"); } catch { /* already gone */ }
  }

  /** An open, checked connection to the server (reopened when it was lost). */
  async function connection(server) {
    const { runtime } = await runtimeOf();
    const s = stateOf(server);
    if (s.connectedAt && Date.now() - s.lastOkAt > PING_AFTER_MS) {
      try {
        const ctx = await withTimeout(runtime.connect(server), PING_TIMEOUT_MS, "ping");
        await withTimeout(ctx.client.ping(), PING_TIMEOUT_MS, "ping");
        s.lastOkAt = Date.now();
      } catch (e) {
        await drop(server, `ne répond plus : ${e.message}`);
      }
    }
    if (!s.connectedAt) {
      // One opening at a time per server: a burst of calls after a cut shares it.
      s.connecting ??= (async () => {
        const ctx = await withTimeout(runtime.connect(server), CONNECT_TIMEOUT_MS, "connect").catch(async (e) => {
          // A connect still pending after the timeout must not be reused half-open.
          runtime.close(server).catch(() => {});
          throw e;
        });
        // The transport tells us when the server hangs up: the next call reconnects instead of waiting on a dead line.
        const previous = ctx.client.onclose;
        ctx.client.onclose = () => { try { previous?.(); } finally { if (s.connectedAt) { s.connectedAt = 0; log(`${server} : connexion coupée par le serveur`); runtime.close(server).catch(() => {}); } } };
        if (s.opened) s.reconnects++;
        s.opened = true;
        s.connectedAt = Date.now();
        s.lastOkAt = Date.now();
      })().finally(() => { s.connecting = null; });
      await s.connecting;
    }
    return runtime;
  }

  function startHeartbeat() {
    if (heartbeat || !heartbeatMs) return;
    heartbeat = setInterval(async () => {
      for (const [server, s] of state) {
        if (!s.connectedAt) continue;
        if (Date.now() - s.lastUsedAt > IDLE_CLOSE_MS) { await drop(server, "inutilisée depuis 30 min"); continue; }
        try {
          const { runtime } = await runtimeOf();
          const ctx = await withTimeout(runtime.connect(server), PING_TIMEOUT_MS, "ping");
          await withTimeout(ctx.client.ping(), PING_TIMEOUT_MS, "ping");
          s.lastOkAt = Date.now();
        } catch (e) {
          await drop(server, `battement sans réponse : ${e.message}`);
        }
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  /**
   * Calls `<server>.<tool>`. Resolves like the CLI printed:
   *   { ok: true, value }        the tool's JSON result (what `--output json` printed)
   *   { ok: false, toolError }   the tool answered something that is not JSON (its own error text)
   * Throws PoolTimeout when the tool ran out of time, PoolUnavailable when the
   * connection could not be used (the caller then spawns mcporter).
   */
  async function call(server, tool, args, timeoutMs) {
    // Whatever happens underneath (a close that never returns, a connect left pending), the caller
    // gets its answer or its timeout: never later than the tool's own timeout plus a short margin.
    let deadline;
    const late = new Promise((_, reject) => { deadline = setTimeout(() => { drop(server, "délai dépassé").catch(() => {}); reject(new PoolTimeout(`${server}.${tool} timed out after ${timeoutMs}ms`)); }, timeoutMs + HARD_MARGIN_MS); });
    const work = attempt(server, tool, args, timeoutMs);
    work.catch(() => {});
    return Promise.race([work, late]).finally(() => clearTimeout(deadline));
  }

  async function attempt(server, tool, args, timeoutMs) {
    const s = stateOf(server);
    if (disabledReason) throw new PoolUnavailable(disabledReason);
    if (s.breakerUntil > Date.now()) { s.fallbacks++; throw new PoolUnavailable(`${server} : pool en pause après ${BREAKER_AFTER} échecs`); }
    startHeartbeat();
    let lastError;
    for (let round = 1; round <= 2; round++) {
      try {
        const runtime = await connection(server);
        s.lastUsedAt = Date.now();
        const pending = runtime.callTool(server, tool, { args, timeoutMs });
        pending.catch(() => {});
        let watchdog;
        const lineDead = new Promise((_, reject) => {
          if (!(timeoutMs > WATCHDOG_MS + PING_TIMEOUT_MS)) return;
          watchdog = setTimeout(async () => {
            try { const ctx = await withTimeout(runtime.connect(server), PING_TIMEOUT_MS, "ping"); await withTimeout(ctx.client.ping(), PING_TIMEOUT_MS, "ping"); }
            catch (e) { reject(new Error(`ping timed out pendant l'appel (${e.message})`)); }
          }, WATCHDOG_MS);
        });
        const raw = await Promise.race([pending, lineDead]).finally(() => clearTimeout(watchdog));
        const { wrapCallResult } = await runtimeOf();
        s.calls++; s.failures = 0; s.breakerUntil = 0; s.lastOkAt = Date.now(); s.lastUsedAt = Date.now();
        const value = wrapCallResult(raw).callResult.json();
        if (value !== null && value !== undefined) return { ok: true, value };
        // Same text as the CLI printed for a non-JSON answer (a tool error): the caller reads it the same way.
        return { ok: false, toolError: `${typeof raw === "string" ? raw : inspect(raw, { depth: 2, maxStringLength: null, breakLength: 80 })}\n` };
      } catch (e) {
        lastError = e;
        if (e instanceof PoolUnavailable) break;
        // mcporter tore the connection down on this error (resetConnectionOnError): forget it here too.
        s.connectedAt = 0;
        if (isTimeout(e) && !/^(connect|ping) timed out/.test(e.message)) {
          s.lastError = e.message;
          throw new PoolTimeout(e.message);
        }
        log(`${server}.${tool} : tentative ${round} en échec sur la connexion — ${String(e.message).slice(0, 200)}`);
        try { const { runtime } = await runtimeOf(); await withTimeout(runtime.close(server), 5_000, "close"); } catch { /* gone */ }
      }
    }
    s.failures++; s.fallbacks++; s.lastError = String(lastError?.message ?? lastError).slice(0, 300);
    if (s.failures >= BREAKER_AFTER) { s.breakerUntil = Date.now() + BREAKER_MS; log(`${server} : ${s.failures} échecs de suite, appels par processus pendant ${BREAKER_MS / 1000} s`); }
    throw new PoolUnavailable(s.lastError);
  }

  function stats() {
    const servers = {};
    for (const [name, s] of state) servers[name] = { connected: !!s.connectedAt, calls: s.calls, reconnects: s.reconnects, fallbacks: s.fallbacks, ...(s.breakerUntil > Date.now() ? { pausedUntil: new Date(s.breakerUntil).toISOString() } : {}), ...(s.lastError ? { lastError: s.lastError } : {}) };
    return { enabled: !disabledReason, ...(disabledReason ? { reason: disabledReason } : {}), servers };
  }

  async function close() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    for (const s of state.values()) s.connectedAt = 0;
    if (!ready) return;
    try { const { runtime } = await ready; await withTimeout(runtime.close(), 5_000, "close"); } catch { /* best effort */ }
  }

  return { call, stats, close, drop, /** Tests only: the runtime under the pool. */ __runtime: async () => (await runtimeOf()).runtime };
}
