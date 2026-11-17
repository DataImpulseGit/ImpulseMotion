#!/usr/bin/env node
/**
 * MCP stdio "browser" — the AI's hands on the consultant's piloted browser
 * (server/browser.mjs), the one they watch in a card of their Mo board.
 * Each tool is one call to the relay (POST /api/browser/act), for the
 * consultant the relay pinned in env — never one named by the model.
 *
 *   BROWSER_ACT_URL  — http://127.0.0.1:<port>/api/browser/act
 *   BROWSER_TOKEN    — RELAY_SHARED_SECRET
 *   BROWSER_USER     — the consultant's user id
 *   BROWSER_NAME     — their name (shown to a colleague who finds the browser busy)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const URL_ = process.env.BROWSER_ACT_URL || "";
const TOKEN = process.env.BROWSER_TOKEN || "";
const USER = process.env.BROWSER_USER || "";
const NAME = process.env.BROWSER_NAME || "";
if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(URL_) || TOKEN.length < 16 || !USER) {
  console.error("[mcp-browser] BROWSER_ACT_URL / BROWSER_TOKEN / BROWSER_USER manquants — refus de démarrer");
  process.exit(1);
}

async function call(action, args = {}) {
  let json = null; let status = 0;
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ userId: USER, action, args: action === "open" ? { ...args, name: NAME } : args }),
      signal: AbortSignal.timeout(90_000),
    });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch (e) {
    return { content: [{ type: "text", text: `ERREUR navigateur : ${e?.message || "injoignable"}` }], isError: true };
  }
  if (status !== 200 || !json?.ok) return { content: [{ type: "text", text: `ERREUR ${action} : ${json?.error || `HTTP ${status}`}` }], isError: true };
  const r = json.result;
  if (action === "screenshot") return { content: [{ type: "image", data: r.image, mimeType: r.mime }, { type: "text", text: r.url }] };
  // A snapshot reads better as lines than as JSON (and costs fewer tokens).
  const head = [r.clicked ? `Cliqué : ${r.clicked}` : null, r.typed ? `Tapé : ${r.typed} caractères` : null, `Adresse : ${r.url}`, r.note ? `Note : ${r.note}` : null, `Défilement : ${r.scroll}`, `Page : ${r.page}`].filter(Boolean).join("\n");
  return { content: [{ type: "text", text: `${head}\n\nÉléments visibles (index à donner à click / type) :\n${(r.elements || []).join("\n") || "(aucun)"}` }] };
}

const server = new McpServer({ name: "browser", version: "1.0.0" });
const index = z.number().int().min(0).max(200);

server.tool("open", "Ouvre le navigateur du consultant (il le voit dans sa carte « Navigateur ») et, si une adresse est donnée, y va. Seulement les plateformes publicitaires (adsmanager.facebook.com, business.facebook.com, ads.google.com, ads.tiktok.com). Rend le relevé de la page.", { url: z.string().max(2000).optional() }, (a) => call("open", a));
server.tool("snapshot", "Relevé de la page affichée : adresse, texte, et la liste numérotée des éléments visibles qu'on peut cliquer ou remplir. À refaire quand la page a changé sans action de ta part.", {}, () => call("snapshot"));
server.tool("click", "Clique un élément du DERNIER relevé (index), ou un point (x, y sur 1280×800) quand rien d'autre ne marche. Rend le nouveau relevé. Les boutons qui publient ou paient sont refusés : c'est le consultant qui clique.", { index: index.optional(), x: z.number().optional(), y: z.number().optional() }, (a) => call("click", a));
server.tool("type", "Tape un texte, dans l'élément d'index donné (cliqué d'abord) ou là où est le curseur. replace=true vide le champ avant ; enter=true valide ensuite. Jamais de mot de passe.", { text: z.string().min(1).max(5000), index: index.optional(), replace: z.boolean().optional(), enter: z.boolean().optional() }, (a) => call("type", a));
server.tool("press", "Appuie une touche : Enter, Tab, Escape, Backspace, Delete, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, PageDown, PageUp, Home, End.", { key: z.string().max(12) }, (a) => call("press", a));
server.tool("scroll", "Fait défiler la page (dy en pixels, positif = vers le bas ; x, y = où poser la souris pour défiler un panneau précis). Rend le nouveau relevé.", { dy: z.number().optional(), x: z.number().optional(), y: z.number().optional() }, (a) => call("scroll", a));
server.tool("wait", "Attend que la page charge (ms, 8000 au plus) puis rend le relevé.", { ms: z.number().optional() }, (a) => call("wait", a));
server.tool("screenshot", "Image de l'écran, quand le relevé ne suffit pas à comprendre la page (à utiliser rarement : c'est lourd).", {}, () => call("screenshot"));

await server.connect(new StdioServerTransport());
