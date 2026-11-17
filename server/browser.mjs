/**
 * Mo's piloted browser — a real Chromium on the relay's host that a consultant
 * WATCHES in a card of their Mo board, that the AI drives (server "browser",
 * server/mcp-browser.mjs) and that the consultant can take over at any time.
 *
 *   ensure(userId)                 → starts (or finds) the consultant's browser, on their own profile
 *   subscribe(userId, res)         → the screen, as server-sent events (JPEG frames of the CDP screencast)
 *   input(userId, events)          → the consultant's mouse / keyboard / paste / commands
 *   act(userId, action, args)      → the AI's hands: open, snapshot, click, type, press, scroll, wait, screenshot
 *   close(userId), status()
 *
 * Rules that hold whatever the model writes:
 *   - ONE browser at a time on this host (1 vCPU, ~1 GB per Chromium): a second consultant is told who holds it;
 *     a browser nobody watches or drives for IDLE_MS is closed (the profile, hence the logins, stays on disk).
 *   - One profile per consultant (PROFILES_DIR/<userId>, 0700): each one signs in to Meta / Google as
 *     themselves, with their own 2FA, typed through the view. Keystrokes are never logged.
 *   - The top page stays on the ads platforms (ALLOWED_SITES); the host itself and private addresses are
 *     blocked for every request (the browser is not a way into the server's own network).
 *   - The AI never clicks a publishing button (PUBLISH_RE): that click is the consultant's.
 *   - While the consultant holds the hand (« Je reprends la main »), the AI's actions are refused.
 *
 * puppeteer-core lives in /opt/impulsemotion/tools, like for server/adlib.mjs.
 */

import { createRequire } from "node:module";
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

const TOOLS_DIR = process.env.ADLIB_NODE_DIR || "/opt/impulsemotion/tools";
const CHROMIUM = process.env.BROWSER_CHROMIUM || process.env.ADLIB_CHROMIUM || "/usr/bin/chromium-browser";
const PROFILES_DIR = process.env.BROWSER_PROFILES_DIR || "/var/lib/impulsemotion-relay/browser-profiles";
const IDLE_MS = Number(process.env.BROWSER_IDLE_MS || 8 * 60_000);
const TOKEN_MS = 30 * 60_000;
export const VIEW = { width: 1280, height: 800 };

/** Where the top page may go: the ads platforms and their sign-in pages. */
const ALLOWED_SITES = (process.env.BROWSER_ALLOWED_SITES || "facebook.com,meta.com,fb.com,instagram.com,google.com,google.fr,tiktok.com,youtube.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const HOME = "https://adsmanager.facebook.com/adsmanager/manage/campaigns";
/** Never reachable from the browser, as a page or as a sub-request: this host and private networks. */
const BLOCKED_URLS = ["*://localhost*", "*://127.*", "*://0.0.0.0*", "*://10.*", "*://192.168.*", "*://169.254.*", "*://172.16.*", "*://172.17.*", "*://172.18.*", "*://172.19.*", "*://172.2?.*", "*://172.30.*", "*://172.31.*", "*://[::1]*", "*://*.sslip.io*", "*://*.internal*", "file://*"];
/** The label of a button that puts something live: the consultant's click, never the AI's. */
export const PUBLISH_RE = /^(publier|publish|publier les modifications|publish changes|publier la campagne|publish campaign|confirmer et publier|tout publier|publish all|passer la commande|place order|soumettre|submit|activer|turn on|envoyer pour examen|submit for review|payer|pay now)\b/i;

export function browserEnabled() { return process.env.MO_BROWSER === "1"; }

let puppeteer = null;
export function browserConfigured() {
  if (!browserEnabled()) return false;
  if (!fs.existsSync(CHROMIUM) || !fs.existsSync(path.join(TOOLS_DIR, "node_modules", "puppeteer-core"))) return false;
  if (!puppeteer) { try { puppeteer = createRequire(path.join(TOOLS_DIR, "package.json"))("puppeteer-core"); } catch { return false; } }
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
export function siteAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol === "about:" ) return u.href === "about:blank";
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_SITES.some((s) => host === s || host.endsWith(`.${s}`));
}
/** What a person typed in the address field → a URL of an allowed site, else null. */
export function normalizeAddress(raw) {
  const t = String(raw || "").trim().slice(0, 2000);
  if (!t) return null;
  const url = /^https?:\/\//i.test(t) ? t.replace(/^http:/i, "https:") : `https://${t}`;
  return siteAllowed(url) ? url : null;
}

// ── The one session of this host ────────────────────────────────────────────────────────────────────────
/** @type {null | { userId: string, name: string, browser: any, page: any, cdp: any, subscribers: Set<any>, lastFrame: string|null, lastActivity: number, startedAt: number, human: boolean, elements: any[], note: string, idleTimer: any, closing: boolean }} */
let session = null;
let starting = null;

export function status() {
  if (!session) return { configured: browserConfigured(), open: false };
  return { configured: true, open: true, user: session.userId.slice(-6), name: session.name, viewers: session.subscribers.size, human: session.human, idleS: Math.round((Date.now() - session.lastActivity) / 1000), ageS: Math.round((Date.now() - session.startedAt) / 1000), url: safeUrl(session.page) };
}
const safeUrl = (page) => { try { const u = new URL(page.url()); return u.protocol === "https:" ? `${u.origin}${u.pathname}`.slice(0, 200) : ""; } catch { return ""; } };

function touch(s) {
  s.lastActivity = Date.now();
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (session !== s) return;
    // Someone still watching: one more round; nobody: closed, the profile keeps the logins.
    if (s.subscribers.size > 0 && Date.now() - s.lastActivity < 3 * IDLE_MS) return touch(s);
    void shutdown(s, "inactif");
  }, IDLE_MS);
}

function emit(s, event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of s.subscribers) { try { res.write(line); } catch { /* gone */ } }
}
const meta = (s) => ({ url: safeUrl(s.page), human: s.human, note: s.note });

async function shutdown(s, why) {
  if (s.closing) return;
  s.closing = true;
  if (session === s) session = null;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  emit(s, "closed", { why });
  for (const res of s.subscribers) { try { res.end(); } catch { /* gone */ } }
  s.subscribers.clear();
  try { await s.browser.close(); } catch { /* already gone */ }
  log(`fermé (${why}) — ${s.userId.slice(-6)}, ${Math.round((Date.now() - s.startedAt) / 1000)} s`);
}

/** The page shown and driven: its screencast feeds the viewers, its top navigations are held on the allowed sites. */
async function attach(s, page) {
  if (s.cdp) { try { await s.cdp.send("Page.stopScreencast"); await s.cdp.detach(); } catch { /* old page gone */ } }
  s.page = page;
  s.elements = [];
  await page.setViewport({ width: VIEW.width, height: VIEW.height }).catch(() => undefined);
  await page.setExtraHTTPHeaders({ "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.6" }).catch(() => undefined);
  const cdp = await page.createCDPSession();
  s.cdp = cdp;
  await cdp.send("Network.enable").catch(() => undefined);
  await cdp.send("Network.setBlockedURLs", { urls: BLOCKED_URLS }).catch(() => undefined);
  cdp.on("Page.screencastFrame", (f) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    if (s.page !== page) return;
    s.lastFrame = f.data;
    emit(s, "frame", { d: f.data });
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
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 2 });
  await page.bringToFront().catch(() => undefined);
  emit(s, "meta", meta(s));
}

/** Starts the consultant's browser, or finds it. Another consultant's live browser → 409 with their name. */
export async function ensure(userId, { name = "" } = {}) {
  if (!idOk(userId)) throw new BrowserError("consultant inconnu", 400);
  if (!browserConfigured()) throw new BrowserError("navigateur piloté non activé sur le relay", 503);
  if (starting) await starting.catch(() => undefined);
  if (session && session.userId === userId) { touch(session); return { created: false }; }
  if (session) {
    const idle = Date.now() - session.lastActivity;
    if (session.subscribers.size > 0 || idle < 2 * 60_000) throw new BrowserError(`Le navigateur est utilisé par ${session.name || "un autre consultant"} — un seul à la fois pour l'instant.`, 409);
    await shutdown(session, "repris par un autre consultant");
  }
  starting = (async () => {
    const dir = path.join(PROFILES_DIR, userId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A profile left locked by a crash would refuse to start.
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* none */ } }
    const t0 = Date.now();
    const browser = await puppeteer.launch({
      executablePath: CHROMIUM, headless: true, userDataDir: dir,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--window-size=${VIEW.width},${VIEW.height}`, "--renderer-process-limit=2", "--disable-extensions", "--disable-background-networking", "--no-first-run", "--lang=fr-FR", "--js-flags=--max-old-space-size=768"],
      defaultViewport: VIEW,
    });
    const s = { userId, name: String(name || "").slice(0, 60), browser, page: null, cdp: null, subscribers: new Set(), lastFrame: null, lastActivity: Date.now(), startedAt: Date.now(), human: false, elements: [], note: "", idleTimer: null, closing: false };
    browser.on("disconnected", () => { if (session === s) void shutdown(s, "chromium arrêté"); });
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

/** The screen, as server-sent events, until the viewer leaves. */
export function subscribe(userId, res) {
  const s = mine(userId);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
  s.subscribers.add(res);
  touch(s);
  res.write(`event: meta\ndata: ${JSON.stringify({ ...meta(s), view: VIEW })}\n\n`);
  if (s.lastFrame) res.write(`event: frame\ndata: ${JSON.stringify({ d: s.lastFrame })}\n\n`);
  const beat = setInterval(() => { try { res.write(": .\n\n"); } catch { /* gone */ } }, 20_000);
  res.on("close", () => { clearInterval(beat); s.subscribers.delete(res); });
}

const num = (v, min, max) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);
const BUTTONS = { 0: "left", 1: "middle", 2: "right" };
const NAMED_KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Shift", "Control", "Alt", "Meta", " ", "F5"]);

async function pressKey(page, key, mods = {}) {
  const held = [mods.ctrl && "Control", mods.meta && "Meta", mods.alt && "Alt"].filter(Boolean);
  if (key.length === 1 && !held.length) {
    // A printable character: typed as text (every layout, accents included).
    try { await page.keyboard.press(key); } catch { await page.keyboard.sendCharacter(key); }
    return;
  }
  if (key.length !== 1 && !NAMED_KEYS.has(key)) return;
  for (const m of held) await page.keyboard.down(m);
  try { await page.keyboard.press(key.length === 1 ? key.toLowerCase() : key); } catch { /* key unknown to this layout */ }
  for (const m of held.reverse()) await page.keyboard.up(m);
}

/** The consultant's hands. Events are applied in order; nothing typed is ever logged. */
export async function input(userId, body) {
  const s = mine(userId);
  touch(s);
  const page = s.page;
  if (typeof body?.cmd === "string") {
    switch (body.cmd) {
      case "navigate": {
        const url = normalizeAddress(body.url);
        if (!url) throw new BrowserError("Adresse refusée : ce navigateur ouvre seulement les plateformes publicitaires (Meta, Google, TikTok).", 400);
        page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
        return { ok: true };
      }
      case "back": page.goBack({ timeout: 30_000 }).catch(() => undefined); return { ok: true };
      case "reload": page.reload({ timeout: 60_000 }).catch(() => undefined); return { ok: true };
      case "control": s.human = body.human === true; emit(s, "meta", meta(s)); return { ok: true, human: s.human };
      case "close": await shutdown(s, "fermé par le consultant"); return { ok: true };
      default: throw new BrowserError("commande inconnue", 400);
    }
  }
  const events = Array.isArray(body?.events) ? body.events.slice(0, 200) : [];
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const x = num(e.x, 0, VIEW.width); const y = num(e.y, 0, VIEW.height);
    try {
      if (e.t === "m" && x !== null && y !== null) await page.mouse.move(x, y);
      else if (e.t === "d" && x !== null && y !== null) { await page.mouse.move(x, y); await page.mouse.down({ button: BUTTONS[e.b] || "left", clickCount: num(e.c, 1, 3) ?? 1 }); }
      else if (e.t === "u" && x !== null && y !== null) { await page.mouse.move(x, y); await page.mouse.up({ button: BUTTONS[e.b] || "left", clickCount: num(e.c, 1, 3) ?? 1 }); }
      else if (e.t === "w") await page.mouse.wheel({ deltaX: num(e.dx, -2000, 2000) ?? 0, deltaY: num(e.dy, -2000, 2000) ?? 0 });
      else if (e.t === "k" && typeof e.key === "string" && e.key.length <= 12) await pressKey(page, e.key, { ctrl: e.ctrl === true, meta: e.meta === true, alt: e.alt === true });
      else if (e.t === "p" && typeof e.text === "string") await page.keyboard.sendCharacter(e.text.slice(0, 20_000));
    } catch { /* the page moved under the event */ }
  }
  return { ok: true };
}

export async function close(userId) {
  if (session && session.userId === userId) await shutdown(session, "fermé");
  return { ok: true };
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
      const x = el ? el.x : num(args.x, 0, VIEW.width); const y = el ? el.y : num(args.y, 0, VIEW.height);
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
      await page.mouse.move(num(args.x, 0, VIEW.width) ?? VIEW.width / 2, num(args.y, 0, VIEW.height) ?? VIEW.height / 2);
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

/** The page the consultant's card frames (served by the relay, same origin as the stream). No secret in it: the token comes in the fragment. */
export const VIEW_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Navigateur Mo</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0b0b10;color:#e8e6f0;font:13px/1.4 system-ui,sans-serif;overflow:hidden}
#bar{display:flex;gap:6px;align-items:center;padding:6px 8px;background:#15141d;border-bottom:1px solid #2a2836;height:40px}
#bar button{background:#22202e;color:#e8e6f0;border:1px solid #34314a;border-radius:8px;padding:5px 9px;cursor:pointer;font:inherit;white-space:nowrap}
#bar button:hover{background:#2c2940}#bar button.on{background:#7043F5;border-color:#7043F5;color:#fff}
#addr{flex:1;min-width:60px;background:#0b0b10;color:#e8e6f0;border:1px solid #34314a;border-radius:8px;padding:6px 9px;font:inherit}
#wrap{position:absolute;top:40px;left:0;right:0;bottom:22px;display:flex;align-items:center;justify-content:center;background:#000}
#screen{max-width:100%;max-height:100%;display:block;outline:none;cursor:default}
#cur{position:absolute;pointer-events:none;display:none;transform:translate(-4px,-4px);z-index:3}
#cur i{display:block;width:14px;height:14px;border-radius:50%;background:#7043F5;box-shadow:0 0 0 4px rgba(112,67,245,.35)}
#cur span{position:absolute;left:18px;top:-4px;background:#7043F5;color:#fff;border-radius:6px;padding:1px 6px;white-space:nowrap;font-size:11px}
#st{position:absolute;left:0;right:0;bottom:0;height:22px;padding:3px 8px;background:#15141d;border-top:1px solid #2a2836;color:#a19db5;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#msg{position:absolute;inset:40px 0 22px 0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:#a19db5;background:#0b0b10}
</style></head><body>
<div id="bar"><button id="back" title="Page précédente">←</button><button id="reload" title="Recharger">↻</button><input id="addr" spellcheck="false" placeholder="adsmanager.facebook.com, ads.google.com…"><button id="hand" title="Tant que vous avez la main, Mo ne touche à rien">Je reprends la main</button><button id="quit" title="Ferme le navigateur (vos connexions sont gardées)">Fermer</button></div>
<div id="wrap"><img id="screen" tabindex="0" alt="" draggable="false"><div id="cur"><i></i><span></span></div></div>
<div id="msg">Démarrage du navigateur…</div><div id="st"></div>
<script>
(function(){
var token=(location.hash.match(/t=([^&]+)/)||[])[1]||"";history.replaceState(null,"",location.pathname);
var $=function(i){return document.getElementById(i)},img=$("screen"),msg=$("msg"),st=$("st"),addr=$("addr"),hand=$("hand"),cur=$("cur");
var view={width:1280,height:800},human=false,queue=[],sending=false,curT=0;
function say(t){msg.textContent=t;msg.style.display=t?"flex":"none"}
function post(body){return fetch("input",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"View "+token},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){if(!r.ok)st.textContent=j.error||"Erreur";return j})}).catch(function(){})}
function flush(){if(sending||!queue.length)return;sending=true;var ev=queue.splice(0,60);post({events:ev}).then(function(){sending=false;if(queue.length)flush()})}
function push(e){queue.push(e);flush()}
function pt(e){var r=img.getBoundingClientRect();return{x:Math.round((e.clientX-r.left)*view.width/r.width),y:Math.round((e.clientY-r.top)*view.height/r.height)}}
var lastMove=0;
img.addEventListener("mousemove",function(e){var n=Date.now();if(n-lastMove<70)return;lastMove=n;var p=pt(e);if(queue.length&&queue[queue.length-1].t==="m")queue.pop();push({t:"m",x:p.x,y:p.y})});
img.addEventListener("mousedown",function(e){e.preventDefault();img.focus();var p=pt(e);push({t:"d",x:p.x,y:p.y,b:e.button,c:e.detail||1})});
img.addEventListener("mouseup",function(e){e.preventDefault();var p=pt(e);push({t:"u",x:p.x,y:p.y,b:e.button,c:e.detail||1})});
img.addEventListener("contextmenu",function(e){e.preventDefault()});
img.addEventListener("wheel",function(e){e.preventDefault();var p=pt(e);push({t:"w",x:p.x,y:p.y,dx:Math.round(e.deltaX),dy:Math.round(e.deltaY)})},{passive:false});
img.addEventListener("keydown",function(e){if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="v")return;e.preventDefault();if(e.key==="Dead"||e.key==="Process"||e.key==="Unidentified")return;push({t:"k",key:e.key,ctrl:e.ctrlKey,meta:e.metaKey,alt:e.altKey&&!e.ctrlKey})});
img.addEventListener("paste",function(e){e.preventDefault();var t=(e.clipboardData||window.clipboardData).getData("text");if(t)push({t:"p",text:t})});
document.addEventListener("paste",function(e){if(document.activeElement===img){e.preventDefault();var t=e.clipboardData.getData("text");if(t)push({t:"p",text:t})}});
addr.addEventListener("focus",function(){setTimeout(function(){addr.select()},0)});
addr.addEventListener("keydown",function(e){if(e.key==="Enter"){post({cmd:"navigate",url:addr.value});img.focus()}});
$("back").onclick=function(){post({cmd:"back"})};$("reload").onclick=function(){post({cmd:"reload"})};
hand.onclick=function(){post({cmd:"control",human:!human})};
$("quit").onclick=function(){post({cmd:"close"})};
function meta(m){if(m.view)view=m.view;human=!!m.human;hand.textContent=human?"Rendre la main à Mo":"Je reprends la main";hand.className=human?"on":"";if(document.activeElement!==addr)addr.value=m.url||"";st.textContent=m.note||(human?"Vous avez la main — Mo attend.":"Mo peut piloter ce navigateur. Vous pouvez cliquer et taper à tout moment.")}
function on(ev,data){var d;try{d=JSON.parse(data)}catch(e){return}
 if(ev==="frame"){img.src="data:image/jpeg;base64,"+d.d;say("")}
 else if(ev==="meta")meta(d)
 else if(ev==="cursor"){var r=img.getBoundingClientRect(),w=$("wrap").getBoundingClientRect();cur.style.left=(r.left-w.left+d.x*r.width/view.width)+"px";cur.style.top=(r.top-w.top+d.y*r.height/view.height)+"px";cur.lastChild.textContent=d.label?"Mo : "+d.label:"Mo";cur.style.display="block";clearTimeout(curT);curT=setTimeout(function(){cur.style.display="none"},2500)}
 else if(ev==="closed"){say("Navigateur fermé"+(d.why?" ("+d.why+")":"")+". Rouvrez la carte pour le relancer — vos connexions sont gardées.")}}
function stream(){fetch("stream",{headers:{"Authorization":"View "+token}}).then(function(r){
 if(!r.ok)return r.json().then(function(j){say(j.error||"Navigateur indisponible.")},function(){say("Navigateur indisponible.")});
 var rd=r.body.getReader(),dec=new TextDecoder(),buf="";
 (function pump(){rd.read().then(function(x){if(x.done){if(msg.style.display==="none")say("Connexion au navigateur perdue. Rouvrez la carte.");return}
  buf+=dec.decode(x.value,{stream:true});var i;while((i=buf.indexOf("\\n\\n"))>=0){var b=buf.slice(0,i);buf=buf.slice(i+2);var ev=(b.match(/^event: (.*)$/m)||[])[1],da=(b.match(/^data: (.*)$/m)||[])[1];if(ev&&da)on(ev,da)}
  pump()}).catch(function(){say("Connexion au navigateur perdue. Rouvrez la carte.")})})()
}).catch(function(){say("Navigateur injoignable.")})}
if(!token)say("Lien incomplet : rouvrez la carte depuis Mo.");else stream();
})();
</script></body></html>`;
