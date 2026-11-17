/**
 * Mo's piloted browser — a real Chromium on the relay's host that a consultant
 * WATCHES in a card of their Mo board, that the AI drives (server "browser",
 * server/mcp-browser.mjs) and that the consultant can take over at any time.
 *
 *   ensure(userId)                 → starts (or finds) the consultant's browser, on their own profile
 *   handleUpgrade(req, socket…)    → the live link of the view: frames out (binary JPEG), mouse / keyboard / commands in
 *   act(userId, action, args)      → the AI's hands: open, snapshot, click, type, press, scroll, wait, screenshot
 *   close(userId), status()
 *
 * It is a REGULAR Chrome, not a headless one: started plainly on a virtual display (Xvfb) and joined through
 * its debugging port, so it shows sites the same face as the consultant's own Chrome (same user agent, French,
 * nothing spoofed). The consultant signs in there as themselves — or brings the cookies of their own Chrome
 * (importCookies), which skips the sign-in.
 *
 * Rules that hold whatever the model writes:
 *   - ONE browser at a time on this host (1 vCPU, ~1.3 GB per Chromium): a second consultant is told who holds it;
 *     a browser nobody watches or drives for IDLE_MS is closed (the profile, hence the logins, stays on disk).
 *   - One profile per consultant (PROFILES_DIR/<userId>, 0700). Keystrokes and cookies are never logged.
 *   - The top page stays on the ads platforms (ALLOWED_SITES); the host itself and private addresses are
 *     blocked for every request (the browser is not a way into the server's own network).
 *   - The AI never clicks a publishing button (PUBLISH_RE): that click is the consultant's.
 *   - While the consultant holds the hand (« Je reprends la main »), the AI's actions are refused.
 *
 * puppeteer-core and ws live in /opt/impulsemotion/tools, like for server/adlib.mjs. The Chromium of this host
 * is a snap: it can only write under /root/snap/chromium/common — a profile anywhere else is silently lost.
 */

import { createRequire } from "node:module";
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const TOOLS_DIR = process.env.ADLIB_NODE_DIR || "/opt/impulsemotion/tools";
const CHROMIUM = process.env.BROWSER_CHROMIUM || process.env.ADLIB_CHROMIUM || "/usr/bin/chromium-browser";
const XVFB = process.env.BROWSER_XVFB || "/usr/bin/Xvfb";
const DISPLAY = process.env.BROWSER_DISPLAY || ":97";
const DEBUG_PORT = Number(process.env.BROWSER_DEBUG_PORT || 9377);
const PROFILES_DIR = process.env.BROWSER_PROFILES_DIR || "/root/snap/chromium/common/impulsemotion-browser";
const IDLE_MS = Number(process.env.BROWSER_IDLE_MS || 8 * 60_000);
const TOKEN_MS = 30 * 60_000;
export const VIEW = { width: 1280, height: 800 };
const VIEW_MIN = { width: 900, height: 560 }; const VIEW_MAX = { width: 1600, height: 1000 };

/** Where the top page may go: the ads platforms and their sign-in pages. */
const ALLOWED_SITES = (process.env.BROWSER_ALLOWED_SITES || "facebook.com,meta.com,fb.com,instagram.com,google.com,google.fr,tiktok.com,youtube.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const HOME = "https://adsmanager.facebook.com/adsmanager/manage/campaigns";
/** Never reachable from the browser, as a page or as a sub-request: this host and private networks. */
const BLOCKED_URLS = ["*://localhost*", "*://127.*", "*://0.0.0.0*", "*://10.*", "*://192.168.*", "*://169.254.*", "*://172.16.*", "*://172.17.*", "*://172.18.*", "*://172.19.*", "*://172.2?.*", "*://172.30.*", "*://172.31.*", "*://[::1]*", "*://*.sslip.io*", "*://*.internal*", "file://*"];
/** The label of a button that puts something live: the consultant's click, never the AI's. */
export const PUBLISH_RE = /^(publier|publish|publier les modifications|publish changes|publier la campagne|publish campaign|confirmer et publier|tout publier|publish all|passer la commande|place order|soumettre|submit|activer|turn on|envoyer pour examen|submit for review|payer|pay now)\b/i;

export function browserEnabled() { return process.env.MO_BROWSER === "1"; }

let puppeteer = null; let WebSocketServer = null;
export function browserConfigured() {
  if (!browserEnabled()) return false;
  if (!fs.existsSync(CHROMIUM) || !fs.existsSync(XVFB) || !fs.existsSync(path.join(TOOLS_DIR, "node_modules", "puppeteer-core"))) return false;
  if (!puppeteer) {
    try { const req = createRequire(path.join(TOOLS_DIR, "package.json")); puppeteer = req("puppeteer-core"); WebSocketServer = req("ws").WebSocketServer; } catch { puppeteer = null; return false; }
  }
  return true;
}

function log(msg) { console.log(`[browser] ${msg}`); }
export class BrowserError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

// ── View tokens: what the consultant's page presents to watch and to act (never the relay's secret) ──────────
const idOk = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{6,60}$/.test(v);
const sign = (secret, payload) => createHmac("sha256", `browser-view:${secret}`).update(payload).digest("base64url");
export function mintViewToken(secret, userId, now = Date.now()) {
  if (!idOk(userId) || !secret || secret.length < 16) throw new BrowserError("jeton impossible", 500);
  const exp = now + TOKEN_MS;
  const payload = `v1.${userId}.${exp}`;
  return { token: `${payload}.${sign(secret, payload)}`, expiresAt: exp };
}
/** → the user id of a valid token, else null. */
export function readViewToken(secrets, token, now = Date.now()) {
  const m = /^(v1\.([A-Za-z0-9_-]{6,60})\.(\d{13}))\.([A-Za-z0-9_-]{43})$/.exec(String(token || ""));
  if (!m || Number(m[3]) < now) return null;
  const given = Buffer.from(m[4]);
  for (const s of secrets) {
    const good = Buffer.from(sign(String(s), m[1]));
    if (good.length === given.length && timingSafeEqual(good, given)) return m[2];
  }
  return null;
}

// ── Where a page may go ─────────────────────────────────────────────────────────────────────────────────
const hostAllowed = (host) => { const h = String(host || "").toLowerCase().replace(/^\./, ""); return ALLOWED_SITES.some((s) => h === s || h.endsWith(`.${s}`)); };
export function siteAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol === "about:") return u.href === "about:blank";
  if (u.protocol !== "https:") return false;
  return hostAllowed(u.hostname);
}
/** What a person typed in the address field → a URL of an allowed site, else null. */
export function normalizeAddress(raw) {
  const t = String(raw || "").trim().slice(0, 2000);
  if (!t) return null;
  const url = /^https?:\/\//i.test(t) ? t.replace(/^http:/i, "https:") : `https://${t}`;
  return siteAllowed(url) ? url : null;
}

// ── Cookies brought from the consultant's own Chrome ────────────────────────────────────────────────────
const SAME_SITE = { no_restriction: "None", none: "None", lax: "Lax", strict: "Strict" };
/**
 * Reads an export of cookies — the JSON of the usual extensions (Cookie-Editor, EditThisCookie: an array of
 * { name, value, domain, path, secure, httpOnly, sameSite, expirationDate }) or a Netscape cookies.txt —
 * and keeps those of the ads platforms only. → { cookies (CDP shape), skipped, sites }
 */
export function parseCookieExport(text, now = Date.now()) {
  const raw = String(text || "").trim();
  if (!raw) throw new BrowserError("Rien à importer : collez l'export de vos cookies.", 400);
  if (raw.length > 1_500_000) throw new BrowserError("Export trop gros.", 413);
  let rows = [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    let json;
    try { json = JSON.parse(raw); } catch { throw new BrowserError("Export illisible : il faut le JSON copié depuis l'extension (bouton Export).", 400); }
    const list = Array.isArray(json) ? json : Array.isArray(json?.cookies) ? json.cookies : [];
    rows = list.filter((c) => c && typeof c === "object").map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expires: c.expirationDate ?? c.expires ?? c.expiry, hostOnly: c.hostOnly, session: c.session }));
  } else {
    // Netscape cookies.txt: domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
    for (const line of raw.split(/\r?\n/)) {
      const httpOnly = line.startsWith("#HttpOnly_");
      if (!httpOnly && (line.startsWith("#") || !line.trim())) continue;
      const f = (httpOnly ? line.slice(10) : line).split("\t");
      if (f.length < 7) continue;
      rows.push({ domain: f[0], hostOnly: f[1] !== "TRUE", path: f[2], secure: f[3] === "TRUE", expires: Number(f[4]) || undefined, name: f[5], value: f.slice(6).join("\t"), httpOnly });
    }
    if (!rows.length) throw new BrowserError("Export illisible : collez le JSON de l'extension (ou un fichier cookies.txt).", 400);
  }
  const cookies = []; const sites = new Map(); let skipped = 0;
  for (const r of rows.slice(0, 1500)) {
    const name = typeof r.name === "string" ? r.name : ""; const value = typeof r.value === "string" ? r.value : "";
    const domain = typeof r.domain === "string" ? r.domain.trim().toLowerCase() : "";
    if (!name || name.length > 300 || value.length > 8000 || !domain || !hostAllowed(domain)) { skipped++; continue; }
    const expires = typeof r.expires === "number" && Number.isFinite(r.expires) && r.expires > 0 ? Math.round(r.expires > 1e11 ? r.expires / 1000 : r.expires) : undefined;
    if (expires !== undefined && expires * 1000 < now) { skipped++; continue; }
    const sameSite = SAME_SITE[String(r.sameSite || "").toLowerCase()];
    const secure = r.secure === true || sameSite === "None" || name.startsWith("__Secure-") || name.startsWith("__Host-");
    const bare = domain.replace(/^\./, "");
    cookies.push({ name, value, domain: r.hostOnly === true || name.startsWith("__Host-") ? bare : `.${bare}`, path: typeof r.path === "string" && r.path.startsWith("/") ? r.path : "/", secure, httpOnly: r.httpOnly === true, ...(sameSite ? { sameSite } : {}), ...(expires !== undefined && r.session !== true ? { expires } : {}) });
    const site = ALLOWED_SITES.find((s) => bare === s || bare.endsWith(`.${s}`)) || bare;
    sites.set(site, (sites.get(site) || 0) + 1);
  }
  return { cookies, skipped, sites: Object.fromEntries(sites) };
}

// ── The one session of this host ────────────────────────────────────────────────────────────────────────
/** @type {null | { userId: string, name: string, browser: any, proc: any, page: any, cdp: any, view: {width:number,height:number}, viewers: Set<any>, lastFrame: Buffer|null, lastActivity: number, startedAt: number, human: boolean, elements: any[], note: string, idleTimer: any, closing: boolean, chain: Promise<any>, pendingMove: any }} */
let session = null;
let starting = null;
let xvfb = null;

export function status() {
  if (!session) return { configured: browserConfigured(), open: false };
  return { configured: true, open: true, user: session.userId.slice(-6), name: session.name, viewers: session.viewers.size, human: session.human, idleS: Math.round((Date.now() - session.lastActivity) / 1000), ageS: Math.round((Date.now() - session.startedAt) / 1000), url: safeUrl(session.page) };
}
const safeUrl = (page) => { try { const u = new URL(page.url()); return u.protocol === "https:" ? `${u.origin}${u.pathname}`.slice(0, 200) : ""; } catch { return ""; } };

function touch(s) {
  s.lastActivity = Date.now();
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (session !== s) return;
    // Someone still watching: one more round; nobody: closed, the profile keeps the logins.
    if (s.viewers.size > 0 && Date.now() - s.lastActivity < 3 * IDLE_MS) return touch(s);
    void shutdown(s, "inactif");
  }, IDLE_MS);
}

function emit(s, event, data) {
  const line = JSON.stringify({ e: event, ...data });
  for (const ws of s.viewers) { try { ws.send(line); } catch { /* gone */ } }
}
const meta = (s) => ({ url: safeUrl(s.page), human: s.human, note: s.note, view: s.view });
function sendFrame(s, buf) {
  s.lastFrame = buf;
  for (const ws of s.viewers) {
    // A slow link gets the latest picture, not a queue of old ones.
    if (ws.bufferedAmount > 400_000) continue;
    try { ws.send(buf, { binary: true }); } catch { /* gone */ }
  }
}

async function shutdown(s, why) {
  if (s.closing) return;
  s.closing = true;
  if (session === s) session = null;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  emit(s, "closed", { why });
  for (const ws of s.viewers) { try { ws.close(1000); } catch { /* gone */ } }
  s.viewers.clear();
  // Closed through the browser itself, so the profile (cookies, logins) is written before the process ends.
  try { await Promise.race([s.browser.close(), new Promise((r) => setTimeout(r, 6000))]); } catch { /* already gone */ }
  try { s.proc.kill("SIGTERM"); } catch { /* already gone */ }
  log(`fermé (${why}) — ${s.userId.slice(-6)}, ${Math.round((Date.now() - s.startedAt) / 1000)} s`);
}

async function startScreencast(s) {
  await s.cdp.send("Page.stopScreencast").catch(() => undefined);
  await s.cdp.send("Page.startScreencast", { format: "jpeg", quality: 62, maxWidth: s.view.width, maxHeight: s.view.height, everyNthFrame: 1 });
}

/** The page shown and driven: its screencast feeds the viewers, its top navigations are held on the allowed sites. */
async function attach(s, page) {
  if (s.cdp) { try { await s.cdp.send("Page.stopScreencast"); await s.cdp.detach(); } catch { /* old page gone */ } }
  s.page = page;
  s.elements = [];
  await page.setViewport(s.view).catch(() => undefined);
  const cdp = await page.createCDPSession();
  s.cdp = cdp;
  await cdp.send("Network.enable").catch(() => undefined);
  await cdp.send("Network.setBlockedURLs", { urls: BLOCKED_URLS }).catch(() => undefined);
  cdp.on("Page.screencastFrame", (f) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    if (s.page === page) sendFrame(s, Buffer.from(f.data, "base64"));
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!siteAllowed(url)) {
      s.note = "Cette adresse n'est pas ouverte dans ce navigateur (plateformes publicitaires seulement).";
      log(`adresse refusée — ${(() => { try { return new URL(url).hostname; } catch { return "?"; } })()}`);
      page.goto("about:blank").catch(() => undefined);
    } else if (url !== "about:blank") s.note = "";
    if (s.page === page) emit(s, "meta", meta(s));
  });
  page.on("close", () => {
    if (s.page !== page || s.closing) return;
    s.browser.pages().then((pages) => (pages.length ? attach(s, pages[pages.length - 1]) : s.browser.newPage().then((p) => attach(s, p)))).catch(() => undefined);
  });
  // A blocking dialog (alert, confirm, « quitter la page ? ») would freeze the page: it is dismissed.
  page.on("dialog", (d) => { d.dismiss().catch(() => undefined); });
  await startScreencast(s);
  await page.bringToFront().catch(() => undefined);
  emit(s, "meta", meta(s));
}

/** The virtual display the browser draws on (tiny, kept for the life of the relay). */
async function ensureDisplay() {
  if (xvfb && xvfb.exitCode === null) return;
  xvfb = spawn(XVFB, [DISPLAY, "-screen", "0", `${VIEW_MAX.width + 80}x${VIEW_MAX.height + 200}x24`, "-nolisten", "tcp"], { stdio: "ignore" });
  xvfb.on("error", (e) => log(`Xvfb : ${e.message}`));
  await new Promise((r) => setTimeout(r, 700));
}

/** Starts the consultant's browser, or finds it. Another consultant's live browser → 409 with their name. */
export async function ensure(userId, { name = "" } = {}) {
  if (!idOk(userId)) throw new BrowserError("consultant inconnu", 400);
  if (!browserConfigured()) throw new BrowserError("navigateur piloté non activé sur le relay", 503);
  if (starting) await starting.catch(() => undefined);
  if (session && session.userId === userId) { touch(session); return { created: false }; }
  if (session) {
    const idle = Date.now() - session.lastActivity;
    if (session.viewers.size > 0 || idle < 2 * 60_000) throw new BrowserError(`Le navigateur est utilisé par ${session.name || "un autre consultant"} — un seul à la fois pour l'instant.`, 409);
    await shutdown(session, "repris par un autre consultant");
  }
  starting = (async () => {
    const dir = path.join(PROFILES_DIR, userId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A profile left locked by a crash would refuse to start.
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* none */ } }
    const t0 = Date.now();
    await ensureDisplay();
    // Started like anyone's Chrome (no automation switch), joined through its local debugging port.
    const proc = spawn(CHROMIUM, [
      "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--user-data-dir=${dir}`,
      `--remote-debugging-port=${DEBUG_PORT}`, "--remote-debugging-address=127.0.0.1",
      `--window-size=${VIEW_MAX.width + 40},${VIEW_MAX.height + 160}`, "--window-position=0,0", "--lang=fr-FR",
      "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--disable-features=Translate", "--hide-crash-restore-bubble",
      "--renderer-process-limit=2", "--js-flags=--max-old-space-size=768", "about:blank",
    ], { env: { ...process.env, DISPLAY, LANGUAGE: "fr_FR", LANG: "fr_FR.UTF-8" }, stdio: "ignore" });
    let browser = null;
    for (let i = 0; i < 50 && !browser && proc.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 300));
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null }).catch(() => null);
    }
    if (!browser) { try { proc.kill("SIGKILL"); } catch { /* gone */ } throw new BrowserError("Le navigateur n'a pas démarré.", 502); }
    const s = { userId, name: String(name || "").slice(0, 60), browser, proc, page: null, cdp: null, view: { ...VIEW }, viewers: new Set(), lastFrame: null, lastActivity: Date.now(), startedAt: Date.now(), human: false, elements: [], note: "", idleTimer: null, closing: false, chain: Promise.resolve(), pendingMove: null };
    browser.on("disconnected", () => { if (session === s) void shutdown(s, "chromium arrêté"); });
    proc.on("exit", () => { if (session === s) void shutdown(s, "chromium arrêté"); });
    // A link that opens a tab: the new tab becomes the one shown and driven.
    browser.on("targetcreated", (target) => {
      if (target.type() !== "page") return;
      target.page().then((p) => { if (p && p !== s.page && !s.closing) return attach(s, p); }).catch(() => undefined);
    });
    const pages = await browser.pages();
    await attach(s, pages[0] ?? await browser.newPage());
    session = s;
    touch(s);
    log(`lancé en ${Date.now() - t0} ms — ${userId.slice(-6)}`);
    s.page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
  })();
  try { await starting; } finally { starting = null; }
  return { created: true };
}

const mine = (userId) => {
  if (!session || session.userId !== userId) throw new BrowserError("Le navigateur n'est pas ouvert (ou il a été fermé après une pause).", 410);
  return session;
};

const num = (v, min, max) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);
const BUTTONS = { 0: "left", 1: "middle", 2: "right" };
const NAMED_KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", " ", "F5"]);

/** A named key or a shortcut (Ctrl/Cmd + letter): Cmd is played as Ctrl, this Chrome runs on Linux. */
async function pressKey(page, key, mods = {}) {
  if (key.length !== 1 && !NAMED_KEYS.has(key)) return;
  const held = [(mods.ctrl || mods.meta) && "Control", mods.alt && "Alt", mods.shift && "Shift"].filter(Boolean);
  for (const m of held) await page.keyboard.down(m);
  try { await page.keyboard.press(key.length === 1 ? key.toLowerCase() : key); } catch { /* key unknown to this layout */ }
  for (const m of held.reverse()) await page.keyboard.up(m);
}
/** Text as the person typed it (any layout, accents, a paste): one key for a plain character, inserted as text otherwise. */
async function typeText(page, text) {
  if (text.length === 1 && /^[\x20-\x7e]$/.test(text)) { try { await page.keyboard.press(text); return; } catch { /* not on this layout */ } }
  await page.keyboard.sendCharacter(text);
}

async function applyEvent(s, e) {
  const page = s.page;
  const x = num(e.x, 0, s.view.width); const y = num(e.y, 0, s.view.height);
  switch (e.t) {
    case "m": if (x !== null && y !== null) await page.mouse.move(x, y); return;
    case "d": if (x !== null && y !== null) { await page.mouse.move(x, y); await page.mouse.down({ button: BUTTONS[e.b] || "left", clickCount: num(e.c, 1, 3) ?? 1 }); } return;
    case "u": if (x !== null && y !== null) { await page.mouse.move(x, y); await page.mouse.up({ button: BUTTONS[e.b] || "left", clickCount: num(e.c, 1, 3) ?? 1 }); } return;
    case "w": if (x !== null && y !== null) await page.mouse.move(x, y); await page.mouse.wheel({ deltaX: num(e.dx, -3000, 3000) ?? 0, deltaY: num(e.dy, -3000, 3000) ?? 0 }); return;
    case "k": if (typeof e.key === "string" && e.key.length <= 12) await pressKey(page, e.key, { ctrl: e.ctrl === true, meta: e.meta === true, alt: e.alt === true, shift: e.shift === true }); return;
    case "x": if (typeof e.text === "string" && e.text) await typeText(page, e.text.slice(0, 20_000)); return;
    default: return;
  }
}

/** One message of the consultant's view. Mouse / keyboard are played in order; a newer mouse move replaces a waiting one. */
function onViewerMessage(s, ws, msg) {
  touch(s);
  const reply = (data) => { try { ws.send(JSON.stringify(data)); } catch { /* gone */ } };
  const fail = (e) => reply({ e: "error", message: e instanceof BrowserError ? e.message : "Action impossible." });
  switch (msg.t) {
    case "m": {
      if (s.pendingMove) { s.pendingMove.e = msg; return; }
      const slot = { e: msg };
      s.pendingMove = slot;
      s.chain = s.chain.then(() => { s.pendingMove = null; return applyEvent(s, slot.e); }).catch(() => undefined);
      return;
    }
    case "d": case "u": case "w": case "k": case "x":
      s.chain = s.chain.then(() => applyEvent(s, msg)).catch(() => undefined);
      return;
    case "nav": {
      const url = normalizeAddress(msg.url);
      if (!url) return fail(new BrowserError("Adresse refusée : ce navigateur ouvre seulement les plateformes publicitaires (Meta, Google, TikTok)."));
      s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
      return;
    }
    case "back": s.page.goBack({ timeout: 30_000 }).catch(() => undefined); return;
    case "reload": s.page.reload({ timeout: 60_000 }).catch(() => undefined); return;
    case "hand": s.human = msg.human === true; emit(s, "meta", meta(s)); return;
    case "quit": void shutdown(s, "fermé par le consultant"); return;
    case "size": {
      // The page takes the shape of the card (rounded, bounded), so nothing is letterboxed.
      const w = num(msg.w, VIEW_MIN.width, VIEW_MAX.width); const h = num(msg.h, VIEW_MIN.height, VIEW_MAX.height);
      if (w === null || h === null) return;
      const view = { width: Math.round(w / 20) * 20, height: Math.round(h / 20) * 20 };
      if (view.width === s.view.width && view.height === s.view.height) return;
      s.view = view;
      s.chain = s.chain.then(async () => { await s.page.setViewport(view); await startScreencast(s); emit(s, "meta", meta(s)); }).catch(() => undefined);
      return;
    }
    case "cookies":
      importCookies(s.userId, msg.text).then((r) => reply({ e: "cookies", ...r }), fail);
      return;
    default: return;
  }
}

/**
 * The cookies of the consultant's own Chrome, put in their profile here: the platforms then see the same
 * signed-in person, without a sign-in. Only the ads platforms' cookies are kept; no value is ever logged.
 */
export async function importCookies(userId, text) {
  const s = mine(userId);
  const { cookies, skipped, sites } = parseCookieExport(text);
  if (!cookies.length) throw new BrowserError("Aucun cookie de Meta, Google ou TikTok dans cet export. Exportez-les depuis la page de la plateforme (facebook.com, ads.google.com…).", 400);
  let set = 0;
  for (let i = 0; i < cookies.length; i += 100) {
    const part = cookies.slice(i, i + 100);
    try { await s.cdp.send("Network.setCookies", { cookies: part }); set += part.length; }
    catch {
      // One refused cookie must not lose the others of its batch.
      for (const c of part) { try { await s.cdp.send("Network.setCookies", { cookies: [c] }); set++; } catch { /* refused by Chrome */ } }
    }
  }
  log(`cookies importés — ${userId.slice(-6)} : ${set} (${Object.entries(sites).map(([k, v]) => `${k} ${v}`).join(", ")}), ${skipped} ignorés`);
  s.page.reload({ timeout: 60_000 }).catch(() => undefined);
  return { set, skipped, sites };
}

/** The live link of a view: the page authenticates with its view token in its first message, never in the address. */
export function handleUpgrade(req, socket, head, secrets) {
  const deny = () => { try { socket.destroy(); } catch { /* gone */ } };
  if (!browserConfigured()) return deny();
  // Only the view page itself (same origin as this host) may open the link.
  let originHost = "";
  try { originHost = new URL(req.headers.origin || "").host; } catch { /* no origin */ }
  if (!originHost || originHost !== req.headers.host) return deny();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  wss.handleUpgrade(req, socket, head, (ws) => {
    let s = null;
    const timer = setTimeout(() => { if (!s) ws.close(4001, "auth"); }, 8000);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (!s) {
        const userId = msg.t === "auth" ? readViewToken(secrets, msg.token) : null;
        if (!userId || !session || session.userId !== userId) { try { ws.send(JSON.stringify({ e: "closed", why: userId ? "fermé après une pause" : "session expirée" })); } catch { /* gone */ } ws.close(4001, "auth"); return; }
        s = session;
        clearTimeout(timer);
        s.viewers.add(ws);
        touch(s);
        ws.send(JSON.stringify({ e: "meta", ...meta(s) }));
        if (s.lastFrame) ws.send(s.lastFrame, { binary: true });
        return;
      }
      if (s.closing || session !== s) return;
      try { onViewerMessage(s, ws, msg); } catch { /* a bad message never takes the link down */ }
    });
    const beat = setInterval(() => { try { ws.ping(); } catch { /* gone */ } }, 25_000);
    ws.on("close", () => { clearTimeout(timer); clearInterval(beat); if (s) s.viewers.delete(ws); });
    ws.on("error", () => undefined);
  });
}

export async function close(userId) {
  if (session && session.userId === userId) await shutdown(session, "fermé");
  return { ok: true };
}
/** The relay is stopping: the browser is closed properly so the profile is written. */
export async function closeAll() {
  if (session) await shutdown(session, "relay arrêté");
  try { xvfb?.kill("SIGTERM"); } catch { /* gone */ }
}

// ── The AI's hands ──────────────────────────────────────────────────────────────────────────────────────
/** Runs in the page: what can be clicked or filled, visible on screen, with its centre. */
function listElementsInPage(max) {
  const sel = "a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemradio],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[contenteditable=true]";
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const out = []; const seen = new Set();
  const vw = window.innerWidth; const vh = window.innerHeight;
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= max) break;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.pointerEvents === "none" || Number(cs.opacity) === 0) continue;
    const x = Math.round(Math.min(vw - 2, Math.max(2, r.left + r.width / 2))); const y = Math.round(Math.min(vh - 2, Math.max(2, r.top + r.height / 2)));
    const top = document.elementFromPoint(x, y);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) continue; // covered by something else
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? `input:${el.type || "text"}` : tag);
    const secret = tag === "input" && el.type === "password";
    const name = clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.innerText || el.getAttribute("name") || el.getAttribute("alt"));
    const value = secret ? "" : clean(tag === "input" || tag === "textarea" || tag === "select" ? el.value : el.getAttribute("aria-checked") || el.getAttribute("aria-selected") || "");
    const key = `${role}|${name}|${x}|${y}`;
    if (seen.has(key) || (!name && !value && !role.startsWith("input") && tag !== "textarea")) continue;
    seen.add(key);
    out.push({ role, name, ...(value ? { value } : {}), ...(el.disabled || el.getAttribute("aria-disabled") === "true" ? { disabled: true } : {}), x, y });
  }
  const text = clean(document.title) + " — " + String(document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1200);
  return { elements: out, text, scrollY: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight) };
}

const AGENT_ACTIONS = new Set(["open", "snapshot", "click", "type", "press", "scroll", "wait", "screenshot"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cursor = (s, x, y, label) => emit(s, "cursor", { x, y, label: String(label || "").slice(0, 60) });

async function snapshot(s) {
  const r = await s.page.evaluate(listElementsInPage, 140).catch(() => ({ elements: [], text: "(page illisible pour l'instant — attends puis reprends un relevé)", scrollY: 0, height: 0 }));
  s.elements = r.elements;
  const lines = r.elements.map((e, i) => `[${i}] ${e.role} « ${e.name} »${e.value ? ` = ${e.value}` : ""}${e.disabled ? " (inactif)" : ""}`);
  return { url: safeUrl(s.page), page: r.text, scroll: `${r.scrollY} / ${r.height}`, elements: lines, ...(s.note ? { note: s.note } : {}) };
}

/** One action of the AI on the consultant's browser → a compact result (a fresh snapshot after anything that changes the page). */
export async function act(userId, action, args = {}) {
  if (!AGENT_ACTIONS.has(action)) throw new BrowserError("action inconnue", 400);
  if (action === "open") await ensure(userId, { name: typeof args.name === "string" ? args.name : "" });
  const s = mine(userId);
  if (s.human) throw new BrowserError("Le consultant a repris la main sur le navigateur : dis-le-lui et attends qu'il te la rende, ne réessaie pas.", 423);
  touch(s);
  const page = s.page;
  switch (action) {
    case "open": {
      if (args.url) {
        const url = normalizeAddress(args.url);
        if (!url) throw new BrowserError("Adresse refusée : seulement les plateformes publicitaires (Meta, Google, TikTok).", 400);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
        await sleep(2500);
      } else await sleep(1500);
      return snapshot(mine(userId));
    }
    case "snapshot": return snapshot(s);
    case "click": {
      const el = Number.isInteger(args.index) ? s.elements[args.index] : null;
      const x = el ? el.x : num(args.x, 0, s.view.width); const y = el ? el.y : num(args.y, 0, s.view.height);
      if (x === null || y === null) throw new BrowserError("Donne l'index d'un élément du dernier relevé (ou x et y).", 400);
      // A click by coordinates is checked against what is really under the point.
      const label = el ? el.name : await page.evaluate((px, py) => { const t = document.elementFromPoint(px, py); const b = t?.closest("button,[role=button],a"); return String((b || t)?.getAttribute?.("aria-label") || (b || t)?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 90); }, x, y).catch(() => "");
      if (PUBLISH_RE.test(label)) throw new BrowserError(`« ${label} » met quelque chose en ligne : ce clic est réservé au consultant. Dis-lui que tout est prêt et qu'il peut cliquer lui-même dans le navigateur.`, 403);
      cursor(s, x, y, label);
      await page.mouse.move(x, y, { steps: 6 });
      await page.mouse.click(x, y);
      await sleep(1200);
      return { clicked: label || `${x},${y}`, ...(await snapshot(mine(userId))) };
    }
    case "type": {
      const text = typeof args.text === "string" ? args.text.slice(0, 5000) : "";
      if (!text) throw new BrowserError("texte vide", 400);
      if (Number.isInteger(args.index)) {
        const el = s.elements[args.index];
        if (!el) throw new BrowserError("Index inconnu : reprends un relevé.", 400);
        if (/^input:password/.test(el.role)) throw new BrowserError("Un mot de passe se tape par le consultant, jamais par toi.", 403);
        cursor(s, el.x, el.y, el.name);
        await page.mouse.click(el.x, el.y);
        if (args.replace === true) { await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control"); await page.keyboard.press("Backspace"); }
      }
      await page.keyboard.type(text, { delay: 12 }).catch(() => page.keyboard.sendCharacter(text));
      if (args.enter === true) await page.keyboard.press("Enter");
      await sleep(700);
      return { typed: text.length, ...(await snapshot(mine(userId))) };
    }
    case "press": {
      const key = typeof args.key === "string" ? args.key : "";
      if (!NAMED_KEYS.has(key)) throw new BrowserError(`Touche inconnue. Possibles : ${[...NAMED_KEYS].filter((k) => k.trim()).join(", ")}.`, 400);
      await page.keyboard.press(key);
      await sleep(700);
      return snapshot(mine(userId));
    }
    case "scroll": {
      const dy = num(args.dy, -3000, 3000) ?? 600;
      await page.mouse.move(num(args.x, 0, s.view.width) ?? s.view.width / 2, num(args.y, 0, s.view.height) ?? s.view.height / 2);
      await page.mouse.wheel({ deltaY: dy });
      await sleep(700);
      return snapshot(s);
    }
    case "wait": { await sleep(num(args.ms, 200, 8000) ?? 2000); return snapshot(mine(userId)); }
    case "screenshot": {
      const data = await page.screenshot({ type: "jpeg", quality: 55, encoding: "base64" });
      return { image: data, mime: "image/jpeg", url: safeUrl(page) };
    }
  }
  throw new BrowserError("action inconnue", 400);
}

/** The page the consultant's card frames (served by the relay, same origin as the live link). No secret in it: the token comes in the fragment. */
export const VIEW_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Navigateur Mo</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0b0b10;color:#e8e6f0;font:13px/1.4 system-ui,sans-serif;overflow:hidden}
#bar{display:flex;gap:6px;align-items:center;padding:6px 8px;background:#15141d;border-bottom:1px solid #2a2836;height:40px}
button{background:#22202e;color:#e8e6f0;border:1px solid #34314a;border-radius:8px;padding:5px 9px;cursor:pointer;font:inherit;white-space:nowrap}
button:hover{background:#2c2940}button.on{background:#7043F5;border-color:#7043F5;color:#fff}
#addr{flex:1;min-width:60px;background:#0b0b10;color:#e8e6f0;border:1px solid #34314a;border-radius:8px;padding:6px 9px;font:inherit}
#wrap{position:absolute;top:40px;left:0;right:0;bottom:22px;background:#000;overflow:hidden}
#screen{position:absolute;left:0;top:0;width:100%;height:100%;display:block;cursor:default}
#keys{position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none;outline:none;font-size:16px}
#cur{position:absolute;pointer-events:none;display:none;transform:translate(-4px,-4px);z-index:3}
#cur i{display:block;width:14px;height:14px;border-radius:50%;background:#7043F5;box-shadow:0 0 0 4px rgba(112,67,245,.35)}
#cur span{position:absolute;left:18px;top:-4px;background:#7043F5;color:#fff;border-radius:6px;padding:1px 6px;white-space:nowrap;font-size:11px}
#st{position:absolute;left:0;right:0;bottom:0;height:22px;padding:3px 8px;background:#15141d;border-top:1px solid #2a2836;color:#a19db5;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#msg{position:absolute;inset:40px 0 22px 0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:#a19db5;background:#0b0b10;z-index:4}
#ck{position:absolute;inset:40px 0 22px 0;display:none;background:rgba(11,11,16,.96);z-index:5;padding:18px 22px;overflow:auto}
#ck h3{margin:0 0 6px;font-size:15px}#ck p,#ck li{color:#c9c5d9;margin:4px 0}#ck ol{padding-left:18px;margin:6px 0 10px}
#ckt{width:100%;height:150px;background:#0b0b10;color:#e8e6f0;border:1px solid #34314a;border-radius:8px;padding:8px;font:12px ui-monospace,monospace}
#ckr{margin:8px 0;min-height:18px;color:#b9f3c8}#ck .warn{color:#f3d9a0}
</style></head><body>
<div id="bar"><button id="back" title="Page précédente">←</button><button id="reload" title="Recharger">↻</button><input id="addr" spellcheck="false" autocomplete="off" placeholder="adsmanager.facebook.com, ads.google.com…"><button id="ckb" title="Reprendre la connexion de votre propre Chrome, sans retaper vos identifiants">Mes cookies</button><button id="hand" title="Tant que vous avez la main, Mo ne touche à rien">Je reprends la main</button><button id="quit" title="Ferme le navigateur (vos connexions sont gardées)">Fermer</button></div>
<div id="wrap"><canvas id="screen"></canvas><textarea id="keys" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Clavier du navigateur"></textarea><div id="cur"><i></i><span></span></div></div>
<div id="ck"><h3>Reprendre la connexion de votre Chrome</h3>
<p>Ce navigateur reprend votre session telle qu'elle est dans votre Chrome : pas d'identifiant ni de code à retaper.</p>
<ol><li>Dans <b>votre</b> Chrome, ouvrez la plateforme où vous êtes connecté (facebook.com, ads.google.com, ads.tiktok.com).</li>
<li>Avec l'extension <b>Cookie-Editor</b> : bouton <b>Export</b> → <b>JSON</b> (copié dans le presse-papiers).</li>
<li>Collez ici, puis « Importer ». À refaire pour chaque plateforme.</li></ol>
<textarea id="ckt" spellcheck="false" placeholder='[{"domain":".facebook.com","name":"c_user",…}]'></textarea>
<div id="ckr"></div>
<p class="warn">Ces cookies donnent accès à votre compte : ils vont directement dans votre profil sur ce navigateur, ne sont ni affichés ni journalisés, et seuls ceux de Meta, Google et TikTok sont gardés. Une plateforme peut demander une vérification quand une session change d'appareil.</p>
<button id="cki" class="on">Importer</button> <button id="ckc">Fermer</button></div>
<div id="msg">Démarrage du navigateur…</div><div id="st"></div>
<script>
(function(){
var token=(location.hash.match(/t=([^&]+)/)||[])[1]||"";try{token=decodeURIComponent(token)}catch(e){}history.replaceState(null,"",location.pathname);
var $=function(i){return document.getElementById(i)},cv=$("screen"),cx=cv.getContext("2d"),keys=$("keys"),msg=$("msg"),st=$("st"),addr=$("addr"),hand=$("hand"),cur=$("cur"),wrap=$("wrap"),ck=$("ck");
var view={width:1280,height:800},human=false,ws=null,ready=false,tries=0,closed=false,curT=0,note="",decoding=false,waiting=null;
function say(t){msg.textContent=t;msg.style.display=t?"flex":"none"}
function send(o){if(ws&&ws.readyState===1&&ready)ws.send(JSON.stringify(o))}
function status(t){st.textContent=t||note||(human?"Vous avez la main — Mo attend.":"Mo peut piloter ce navigateur. Vous pouvez cliquer et taper à tout moment.")}
function draw(buf){if(decoding){waiting=buf;return}decoding=true;createImageBitmap(new Blob([buf],{type:"image/jpeg"})).then(function(b){if(cv.width!==b.width||cv.height!==b.height){cv.width=b.width;cv.height=b.height}cx.drawImage(b,0,0);b.close();say("")}).catch(function(){}).then(function(){decoding=false;if(waiting){var n=waiting;waiting=null;draw(n)}})}
function meta(m){if(m.view)view=m.view;human=!!m.human;note=m.note||"";hand.textContent=human?"Rendre la main à Mo":"Je reprends la main";hand.className=human?"on":"";if(document.activeElement!==addr)addr.value=m.url||"";status()}
function onText(d){
 if(d.e==="meta")meta(d);
 else if(d.e==="cursor"){var r=cv.getBoundingClientRect(),w=wrap.getBoundingClientRect();cur.style.left=(r.left-w.left+d.x*r.width/view.width)+"px";cur.style.top=(r.top-w.top+d.y*r.height/view.height)+"px";cur.lastChild.textContent=d.label?"Mo : "+d.label:"Mo";cur.style.display="block";clearTimeout(curT);curT=setTimeout(function(){cur.style.display="none"},2500)}
 else if(d.e==="closed"){closed=true;say("Navigateur fermé"+(d.why?" ("+d.why+")":"")+". Rouvrez la carte pour le relancer — vos connexions sont gardées.")}
 else if(d.e==="error"){status(d.message);$("ckr").textContent=ck.style.display==="block"?d.message:"";$("ckr").style.color="#f3a0a0"}
 else if(d.e==="cookies"){var s=Object.keys(d.sites||{}).map(function(k){return k+" ("+d.sites[k]+")"}).join(", ");$("ckr").style.color="#b9f3c8";$("ckr").textContent=d.set+" cookies importés : "+s+". La page se recharge.";$("ckt").value=""}}
function size(){var w=wrap.clientWidth,h=wrap.clientHeight;if(w<200||h<150)return;var k=Math.max(900/w,560/h,1);send({t:"size",w:Math.round(w*k),h:Math.round(h*k)})}
var sizeT=0;window.addEventListener("resize",function(){clearTimeout(sizeT);sizeT=setTimeout(size,350)});
function connect(){ready=false;ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/browser/ws");ws.binaryType="arraybuffer";
 ws.onopen=function(){ws.send(JSON.stringify({t:"auth",token:token}));ready=true;tries=0;size()};
 ws.onmessage=function(ev){if(typeof ev.data==="string"){try{onText(JSON.parse(ev.data))}catch(e){}}else draw(ev.data)};
 ws.onclose=function(){ready=false;if(closed)return;if(tries++<4)setTimeout(connect,700*tries);else say("Connexion au navigateur perdue. Rouvrez la carte.")}}
function pt(e){var r=cv.getBoundingClientRect();return{x:Math.round((e.clientX-r.left)*view.width/r.width),y:Math.round((e.clientY-r.top)*view.height/r.height)}}
var lastMove=0;
cv.addEventListener("mousemove",function(e){var n=Date.now();if(n-lastMove<33)return;lastMove=n;var p=pt(e);send({t:"m",x:p.x,y:p.y})});
var down=false;
cv.addEventListener("mousedown",function(e){e.preventDefault();keys.focus({preventScroll:true});down=true;var p=pt(e);send({t:"d",x:p.x,y:p.y,b:e.button,c:e.detail||1})});
window.addEventListener("mouseup",function(e){if(!down)return;down=false;var p=pt(e);send({t:"u",x:p.x,y:p.y,b:e.button,c:e.detail||1})});
cv.addEventListener("contextmenu",function(e){e.preventDefault()});
var wdx=0,wdy=0,wT=0,wp=null;
cv.addEventListener("wheel",function(e){e.preventDefault();var k=e.deltaMode===1?32:1;wdx+=e.deltaX*k;wdy+=e.deltaY*k;wp=pt(e);if(!wT)wT=setTimeout(function(){wT=0;send({t:"w",x:wp.x,y:wp.y,dx:Math.round(wdx),dy:Math.round(wdy)});wdx=wdy=0},40)},{passive:false});
/* Typing: what the keyboard really produced (any layout, AltGr, accents, a paste) is read from a hidden field; only named keys and shortcuts go as keys. */
var NAMED={Enter:1,Tab:1,Backspace:1,Delete:1,Escape:1,ArrowLeft:1,ArrowRight:1,ArrowUp:1,ArrowDown:1,Home:1,End:1,PageUp:1,PageDown:1,F5:1},composing=false;
keys.addEventListener("keydown",function(e){
 if(e.isComposing||e.key==="Dead"||e.key==="Process")return;
 var altgr=e.getModifierState&&e.getModifierState("AltGraph");
 if(NAMED[e.key]){e.preventDefault();send({t:"k",key:e.key,ctrl:e.ctrlKey&&!altgr,meta:e.metaKey,shift:e.shiftKey});return}
 if((e.ctrlKey||e.metaKey)&&!altgr&&!e.altKey&&e.key.length===1){var k=e.key.toLowerCase();if(k==="v")return;e.preventDefault();send({t:"k",key:k,ctrl:true,shift:e.shiftKey})}});
keys.addEventListener("compositionstart",function(){composing=true});
keys.addEventListener("compositionend",function(){composing=false;flushKeys()});
function flushKeys(){var v=keys.value;if(!v)return;keys.value="";send({t:"x",text:v})}
keys.addEventListener("input",function(){if(!composing)flushKeys()});
addr.addEventListener("focus",function(){setTimeout(function(){addr.select()},0)});
addr.addEventListener("keydown",function(e){if(e.key==="Enter"){send({t:"nav",url:addr.value});keys.focus()}});
$("back").onclick=function(){send({t:"back"})};$("reload").onclick=function(){send({t:"reload"})};
hand.onclick=function(){send({t:"hand",human:!human})};$("quit").onclick=function(){send({t:"quit"})};
$("ckb").onclick=function(){$("ckr").textContent="";ck.style.display="block";$("ckt").focus()};$("ckc").onclick=function(){ck.style.display="none";keys.focus()};
$("cki").onclick=function(){var v=$("ckt").value.trim();if(!v){$("ckr").textContent="Collez d'abord l'export.";return}$("ckr").style.color="#c9c5d9";$("ckr").textContent="Import en cours…";send({t:"cookies",text:v})};
if(!token)say("Lien incomplet : rouvrez la carte depuis Mo.");else connect();
})();
</script></body></html>`;
