/**
 * One detached turn of a client bot, whoever starts it: the chat route (a
 * person typing), a page of the bot refreshed by hand, or the morning pass of
 * the scheduled pages (lib/bot-routines.ts, /api/cron/bot-routines).
 *
 *   1. loads the person's conversation (owner = user.id, else 404);
 *   2. builds the system prompt (business context + enabled sources + data
 *      coverage + loaded datasets, memoised in lib/bot-context.ts) and the
 *      relay body with MCP servers derived from the sources, account / data
 *      scopes derived from the dashboard (server-side scoping: the model
 *      never picks an account or a client_key; the TikTok advertisers are
 *      the ones attached to the dashboard);
 *   3. writes the user message to the thread, starts the relay job, records
 *      it (AiJob) with the ledger context of its usage line.
 *
 * The caller has already checked the person may use the bot (loadBotFor).
 */

import { prisma } from "@/lib/prisma";
import { isStaff } from "@/lib/auth-helpers";
import type { BotWithDashboard } from "@/lib/bot-access";
import { parseMessages, parseSources, serversForSources, type BotMessage } from "@/lib/bot-types";
import { buildBotSystemPrompt } from "@/lib/bot-prompt";
import { loadBotCoverage, loadBotDatasets } from "@/lib/bot-context";
import { botAdsPack, warmBotAdsPack } from "@/lib/bot-ads-pack";
import { getDashboardTikTokIds } from "@/lib/tiktok-accounts";
import type { RelayChatBody, RelayMessage } from "@/lib/relay-chat";
import { appendBotMessages, jobTitle, runningJobCount, runningJobOf, startAiJob } from "@/lib/ai-jobs";
import { botDailyCap, botMessagesToday, readQuotas, botBudgetSpent, clientBotsSpendThisMonth } from "@/lib/quotas";

export const MAX_RUNNING_JOBS_PER_USER = 3;

const MAX_HISTORY = 30;
export const MAX_MESSAGE_CHARS = 12000;
/** Detached: the relay allows a long turn; the browser is not holding a function open. */
const BUDGET_MS = 10 * 60_000;

function toRelayMessages(history: BotMessage[]): RelayMessage[] {
  return history
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

export interface BotTurnInput {
  bot: BotWithDashboard;
  user: { id: string; email?: string | null; role?: string | null };
  conversationId: string;
  message: string;
  /**
   * A page being refreshed: the model answers the saved question from today's
   * data only, without the page's earlier runs (they stay in the thread).
   */
  fresh?: boolean;
  /** Work to do behind the answer (`after` of next/server in a route). */
  defer?: (work: () => Promise<unknown>) => void;
}

export type BotTurnResult =
  | { ok: true; jobId: string; conversationId: string }
  | { ok: false; status: number; error: string; jobId?: string };

export async function startBotTurn({ bot, user, conversationId, message, fresh, defer }: BotTurnInput): Promise<BotTurnResult> {
  const staff = isStaff(user);
  const conversation = await prisma.botConversation.findFirst({
    where: { id: conversationId, botId: bot.id, userId: user.id },
    select: { id: true, title: true, messagesJson: true },
  });
  if (!conversation) return { ok: false, status: 404, error: "not found" };
  const running = await runningJobOf(conversation.id, user.id);
  if (running) return { ok: false, status: 409, error: "Une réponse est déjà en cours sur cette conversation. Attendez qu'elle soit terminée avant d'envoyer la suite.", jobId: running.id };
  // Every detached turn is a model call of up to ten minutes: a person gets a few at a time, not an unbounded fan-out.
  if (await runningJobCount(user.id) >= MAX_RUNNING_JOBS_PER_USER) {
    return { ok: false, status: 429, error: `${MAX_RUNNING_JOBS_PER_USER} réponses sont déjà en cours sur votre compte. Attendez qu'une se termine.` };
  }

  // Daily cap of the bot (its own, else the agency's — Admin → Quotas): all its users together, Paris day.
  const quotas = await readQuotas();
  // Month's budget of the client bots (Bedrock, all bots together — Admin → Quotas). The staff
  // answers on the Max subscriptions: neither counted nor blocked.
  if (!staff && botBudgetSpent(quotas, await clientBotsSpendThisMonth())) {
    return { ok: false, status: 429, error: "Attention, limite de la bêta atteinte. Veuillez contacter un administrateur." };
  }
  const cap = botDailyCap(bot, quotas);
  if (cap > 0 && (await botMessagesToday(bot.id)) >= cap) {
    return { ok: false, status: 429, error: `Le quota du jour de cet assistant est atteint (${cap} message${cap > 1 ? "s" : ""}). Il sera de nouveau disponible demain.` };
  }

  const sources = parseSources(bot.sourcesJson);
  // TikTok: read only when the admin ticked it, on the advertisers attached to
  // this dashboard. None attached → the source is dropped for this turn (no
  // server asked, nothing promised in the prompt).
  const tiktokIds = sources.tiktok ? await getDashboardTikTokIds(bot.dashboard.id) : [];
  if (!tiktokIds.length) delete sources.tiktok;
  const history = parseMessages(conversation.messagesJson);
  const userMessage: BotMessage = { role: "user", content: message, at: new Date().toISOString() };
  const thread = [...history, userMessage];

  const coverage = sources.data ? await loadBotCoverage(bot.clientKey) : null;
  // Files: announced only when at least one dataset is loaded (a ticked source
  // with nothing behind it is dropped for this turn, like TikTok).
  const datasets = sources.files ? await loadBotDatasets(bot.clientKey) : [];
  if (!datasets.length) delete sources.files;
  // Creatives + ad performance of the bot's own accounts (warehouse, cached
  // 15 min): the common questions are answered without a tool round trip.
  const adAccounts = {
    meta: sources.meta ? bot.dashboard.metaAccountId : null,
    google: sources.google ? bot.dashboard.googleCustomerId : null,
    tiktok: tiktokIds,
  };
  // Never waits for the platforms: a stored pack is served at once and refreshed behind the answer.
  const pack = await botAdsPack(bot.id, adAccounts).catch(() => ({ text: "", stale: false }));
  const adsPack = pack.text;
  if (pack.stale && defer) defer(() => warmBotAdsPack(bot.id, adAccounts).catch(() => undefined));
  const systemPrompt = buildBotSystemPrompt({ bot: { ...bot, sources }, dashboard: bot.dashboard, coverage, tiktokAdvertiserIds: tiktokIds, datasets, adsPack });

  const accountScope: NonNullable<RelayChatBody["accountScope"]> = {};
  if (sources.meta && bot.dashboard.metaAccountId) accountScope.meta = [bot.dashboard.metaAccountId];
  if (sources.google && bot.dashboard.googleCustomerId) accountScope.google = [bot.dashboard.googleCustomerId];
  if (tiktokIds.length) accountScope.tiktok = tiktokIds;

  const relayBody: RelayChatBody = {
    // A refreshed page starts from a clean session: same question, today's figures.
    sessionKey: fresh ? `bot:${conversation.id}:r${Date.now().toString(36)}` : `bot:${conversation.id}`,
    messages: toRelayMessages(fresh ? [userMessage] : thread),
    systemPrompt,
    allowedServers: serversForSources(sources),
    accountScope,
    budgetMs: BUDGET_MS,
    // Speed: little thinking, few tool rounds (the ads pack answers most questions).
    effort: "low",
    maxTurns: 8,
    // Client-bot restrictions (no HQ, no web) whoever is asking.
    clientBot: true,
  };
  // Amazon Bedrock (AWS, EU region) is for clients only: a consultant or an
  // admin trying a bot runs it on the agency's Claude Max accounts (rule of
  // 2026-10-01, Melvin).
  if (!staff) relayBody.provider = "bedrock";
  if (sources.data || sources.files || sources.ga4PropertyId) {
    const tools: Array<"orders" | "datasets"> = [];
    if (sources.data) tools.push("orders");
    if (sources.files) tools.push("datasets");
    relayBody.dataScope = { clientKey: bot.clientKey, ga4PropertyId: sources.ga4PropertyId, ...(tools.length ? { tools } : {}) };
  }

  // The question is part of the thread from now on; the answer joins it when
  // the job ends (whoever notices first: the browser's reader, the relay's
  // webhook, the reconciliation of the lists).
  await appendBotMessages(conversation.id, [userMessage], conversation.title ?? jobTitle(message));
  const started = await startAiJob({
    relayBody,
    surface: "bot",
    userId: user.id,
    conversationId: conversation.id,
    botId: bot.id,
    title: message,
    usageContext: {
      feature: "client_bot",
      dashboardId: bot.dashboard.id,
      clientName: bot.dashboard.name,
      botId: bot.id,
      clientKey: bot.clientKey,
      user: { id: user.id, email: user.email, role: user.role ?? "client" },
    },
  });
  if ("error" in started) {
    await appendBotMessages(conversation.id, [{ role: "assistant", content: `_L'assistant n'a pas pu répondre : ${started.error}_`, at: new Date().toISOString() }]);
    return { ok: false, status: 502, error: started.error };
  }
  return { ok: true, jobId: started.jobId, conversationId: conversation.id };
}
