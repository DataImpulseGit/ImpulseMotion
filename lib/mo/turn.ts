/**
 * What a turn of Mo sends to the relay, shared by the chat route (a real
 * message), the warm-up route (no message: the persistent CLI starts while
 * the person is still talking) and the tests: the caller's scope, the closed
 * client list, the system prompt, the tool belt and its session key.
 */

import { getAllowedAccountIds } from "@/lib/acl";
import { getAccountScope } from "@/lib/scope";
import { listClientRegistry, type ClientRef } from "@/lib/clients/registry";
import { BROWSER_SERVER, CLIENT_DATA_SERVER, HQ_SERVER, MCP_SERVER_WHITELIST, MO_SERVER, SANDBOX_SERVER, STAFF_MCP_SERVERS, TIKTOK_SERVER } from "@/lib/mcp-whitelist";
import { staffDataScopeForAll } from "@/lib/staff-data-scope";
import { MO_PROFILE } from "@/lib/ai-profiles";
import type { RelayChatBody } from "@/lib/relay-chat";
import { moSessionKey } from "@/lib/mo/model";
import { buildMoSystemPrompt } from "@/lib/mo/prompt";

export type MoSession = { userId: string; role?: string | null; user?: { name?: string | null; email?: string | null } | null };

/** A voice answer should come fast; the relay cuts a runaway turn. */
export const MO_BUDGET_MS = 5 * 60_000;
export const MO_MAX_TURNS = MO_PROFILE.maxTurns ?? 12;
/** Driving a browser is many small steps (a relevé after each click): more turns, more time. */
export const MO_BROWSER_MAX_TURNS = 80;
export const MO_BROWSER_BUDGET_MS = 25 * 60_000;
/** The piloted browser is behind a switch (the relay needs MO_BROWSER=1 too). */
export const moBrowserOpen = (): boolean => process.env.MO_BROWSER === "1";
/** A sentence that asks for the piloted browser: the browser itself, or a platform's own interface. */
export function asksForBrowser(message: string): boolean {
  const t = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /\b(navigateur|chrome|ads manager|gestionnaire de publicites?|business manager|business suite|dans l'interface|sur l'interface|interface (meta|facebook|google|tiktok)|pilote le|reprends? le navigateur)\b/.test(t);
}

const BROWSER_GUIDE = `

NAVIGATEUR PILOTÉ (outils browser) — la personne regarde en direct, dans la carte « Navigateur » de son tableau, le vrai Chrome que tu pilotes.
- Commence par open (avec l'adresse : adsmanager.facebook.com, business.facebook.com, ads.google.com, ads.tiktok.com). Chaque action te rend le relevé de la page : la liste numérotée des éléments visibles. Clique et tape par index du DERNIER relevé ; screenshot seulement si le relevé ne suffit pas.
- Si la page demande une connexion, un mot de passe ou un code : arrête-toi et dis à la personne de se connecter elle-même dans la carte, puis de te dire « c'est bon ». Tu ne tapes jamais d'identifiant ni de mot de passe.
- Tu prépares, la personne publie : va jusqu'à l'écran de vérification, puis dis ce qui est prêt et demande-lui de cliquer elle-même sur « Publier ». Ce clic t'est refusé. Toute campagne se crée désactivée / en brouillon quand la plateforme le permet.
- Vérifie le compte publicitaire affiché avant de créer quoi que ce soit (nom du client attendu) ; en cas de doute, demande.
- Si un outil répond que la personne a repris la main : dis-le en une phrase et arrête ce tour.
- Avance par petites étapes et dis en une phrase courte où tu en es quand une étape importante est franchie. Ne recopie jamais un relevé dans ta réponse.
- Pour envoyer un visuel du tableau dans la plateforme : ce n'est pas encore possible depuis ce navigateur ; dis-le, et propose la publication par Mo (meta_publish_ad) pour l'annonce elle-même.`;

export interface MoTurnContext {
  clients: ClientRef[];
  systemPrompt: string;
  accountScope: NonNullable<RelayChatBody["accountScope"]>;
  dataScope: Awaited<ReturnType<typeof staffDataScopeForAll>>;
}

/** Everything about the caller a turn needs (four reads, in parallel). */
export async function moTurnContext(session: MoSession): Promise<MoTurnContext> {
  const [scope, metaIds, googleIds, tiktokIds, dataScope] = await Promise.all([
    getAccountScope(session),
    getAllowedAccountIds(session.userId, "meta"),
    getAllowedAccountIds(session.userId, "google"),
    getAllowedAccountIds(session.userId, "tiktok"),
    staffDataScopeForAll(),
  ]);
  const clients = await listClientRegistry(scope);
  const author = session.user?.name ?? session.user?.email ?? null;
  return { clients, systemPrompt: buildMoSystemPrompt({ clients, author }), accountScope: { meta: metaIds, google: googleIds, tiktok: tiktokIds, unrestricted: session.role === "admin" }, dataScope };
}

/**
 * Two stable tool belts, each with its own relay session, so a turn always
 * RESUMES (the relay drops a session whose server list changed):
 *   - « mo » (default): Mo's own tools only — warehouse, generation, Drive, publication, Ad Library.
 *   - « wide »: the same plus the live ads platforms, HQ, the staff belt, the sandbox and the client
 *     warehouses, when the sentence clearly asks for them.
 */
export function moBeltFor(message: string, dataScope: boolean, opts: { browserCard?: boolean } = {}): { name: "mo" | "wide" | "browser"; servers: string[] } {
  // The piloted browser has its own belt (and relay session): asked by name, or carried on while its card is on the board
  // and the sentence is not plainly a figures / créas request (those keep their fast belts).
  if (moBrowserOpen() && (asksForBrowser(message) || (opts.browserCard === true && /\b(continue|vas-y|c'est bon|je suis connecte|connecte|clique|ouvre|va sur|remplis|cree|creer|lance|campagne|ensemble|annonce|budget|suivant|reprends|recommence|ferme)\b/.test(message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase())))) return { name: "browser", servers: [MO_SERVER, BROWSER_SERVER] };
  const t = message.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const live = /\b(en direct|temps reel|insights?|ga4|analytics|trafic|sessions?|audiences?|ciblages?|encheres?|placements?|frequence|statuts?|google ads|tiktok|adset|ensembles? de pub|pixel|evenements? de conversion|catalogue)\b/.test(t);
  const hq = /\b(hq|contexte|historique|objectifs?|brief|memoire|persona|strategie)\b/.test(t);
  const staff = /\b(sheet|sheets|tableur|excel|feuille|notion|merchant|magento|drive|gmail|agenda|calendar|web|internet|cherche sur)\b/.test(t);
  const sandbox = /\b(calcul|python|script|graphique avance|fichier|csv|sandbox)\b/.test(t);
  const data = dataScope && /\b(commandes?|entrepot|dataset|datasets|ventes? en base|panier|clients? finaux)\b/.test(t);
  if (!live && !hq && !staff && !sandbox && !data) return { name: "mo", servers: [MO_SERVER] };
  const servers = new Set<string>([MO_SERVER, ...MCP_SERVER_WHITELIST, TIKTOK_SERVER, HQ_SERVER, ...STAFF_MCP_SERVERS, SANDBOX_SERVER]);
  if (dataScope) servers.add(CLIENT_DATA_SERVER);
  return { name: "wide", servers: [...servers] };
}

/** The relay body of a turn minus its messages: the same for a real turn and for a warm-up (the relay matches them by signature). */
export function moRelayBase(ctx: MoTurnContext, session: MoSession, boardId: string, belt: ReturnType<typeof moBeltFor>, opts: { model?: RelayChatBody["model"]; effort?: RelayChatBody["effort"]; account?: string } = {}): Omit<RelayChatBody, "messages"> {
  return {
    systemPrompt: belt.name === "browser" ? `${ctx.systemPrompt}${BROWSER_GUIDE}` : ctx.systemPrompt,
    hqGuidance: "caller",
    sessionKey: belt.name === "mo" ? moSessionKey(boardId) : `${moSessionKey(boardId)}:${belt.name}`,
    model: opts.model ?? MO_PROFILE.model,
    effort: opts.effort ?? MO_PROFILE.effort,
    ...(opts.account ? { account: opts.account } : {}),
    maxTurns: belt.name === "browser" ? MO_BROWSER_MAX_TURNS : MO_MAX_TURNS,
    budgetMs: belt.name === "browser" ? MO_BROWSER_BUDGET_MS : MO_BUDGET_MS,
    allowedServers: belt.servers,
    mo: { userId: session.userId, boardId, ...(session.user?.name ? { name: session.user.name.slice(0, 60) } : {}) },
    ...(ctx.dataScope ? { dataScope: ctx.dataScope } : {}),
    accountScope: ctx.accountScope,
  };
}
