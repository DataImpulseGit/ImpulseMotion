import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const BOT = { id: "bot1", dashboard: { id: "d1", name: "DT" } };
type Routine = { id: string; botId: string; userId: string; conversationId: string; name: string; prompt: string; schedule: string; position: number; lastRunAt: Date | null; user?: { id: string; email: string; role: string } };

let routines: Routine[] = [];
let conversations: Array<{ id: string; title: string | null }> = [];
let access: Record<string, number> = {};
const turns: Array<{ userId: string; conversationId: string; message: string; fresh?: boolean }> = [];
let turnResult: { ok: true; jobId: string; conversationId: string } | { ok: false; status: number; error: string } = { ok: true, jobId: "j".repeat(32), conversationId: "" };

vi.mock("@/lib/auth-helpers", () => ({
  requireSession: async () => ({ session: { userId: "u1", role: "client", user: { email: "lh@dt.fr" } } }),
}));
vi.mock("@/lib/bot-access", () => ({
  loadBotFor: async (session: { userId: string }, botId: string) => {
    const status = botId !== BOT.id ? 404 : access[session.userId] ?? 200;
    return status === 200 ? { status, bot: BOT } : { status, bot: null };
  },
}));
vi.mock("@/lib/bot-turn", () => ({
  startBotTurn: async (input: { user: { id: string }; conversationId: string; message: string; fresh?: boolean }) => {
    turns.push({ userId: input.user.id, conversationId: input.conversationId, message: input.message, fresh: input.fresh });
    return turnResult.ok ? { ...turnResult, conversationId: input.conversationId } : turnResult;
  },
}));
vi.mock("@/lib/ai-jobs", () => ({ runningJobOf: async () => null }));
vi.mock("@/lib/prisma", () => {
  const match = (r: Routine, w: Record<string, unknown>) => (!w.id || r.id === w.id) && (!w.botId || r.botId === w.botId) && (!w.userId || r.userId === w.userId);
  const botRoutine = {
    findMany: async ({ where }: { where: Record<string, unknown> }) => routines.filter((r) => (where.schedule ? r.schedule !== "manual" : match(r, where))),
    findFirst: async ({ where }: { where: Record<string, unknown> }) => routines.find((r) => match(r, where)) ?? null,
    count: async ({ where }: { where: Record<string, unknown> }) => routines.filter((r) => match(r, where)).length,
    create: async ({ data }: { data: Omit<Routine, "id" | "lastRunAt"> }) => { const r = { ...data, id: `r${routines.length + 1}`, lastRunAt: null }; routines.push(r); return r; },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Routine> }) => { const r = routines.find((x) => x.id === where.id)!; Object.assign(r, data); return r; },
  };
  const botConversation = {
    create: async ({ data }: { data: { title: string } }) => { const c = { id: `c${conversations.length + 1}`, title: data.title }; conversations.push(c); return c; },
    update: async ({ where, data }: { where: { id: string }; data: { title: string } }) => { Object.assign(conversations.find((c) => c.id === where.id)!, data); },
    delete: async ({ where }: { where: { id: string } }) => { conversations = conversations.filter((c) => c.id !== where.id); routines = routines.filter((r) => r.conversationId !== where.id); },
  };
  const prisma = { botRoutine, botConversation, $transaction: async (fn: (tx: unknown) => unknown) => fn({ botRoutine, botConversation }) };
  return { prisma };
});

import * as listRoute from "@/app/api/bot/[botId]/routines/route";
import * as oneRoute from "@/app/api/bot/[botId]/routines/[rid]/route";
import * as runRoute from "@/app/api/bot/[botId]/routines/[rid]/run/route";
import * as cronRoute from "@/app/api/cron/bot-routines/route";

// The handlers always answer; their declared type also carries the guard's union.
type Handler = (req: NextRequest, ctx: { params: Promise<{ botId: string; rid: string }> }) => Promise<Response>;
const list = listRoute.GET as unknown as Handler;
const create = listRoute.POST as unknown as Handler;
const patch = oneRoute.PATCH as unknown as Handler;
const remove = oneRoute.DELETE as unknown as Handler;
const run = runRoute.POST as unknown as Handler;
const cron = cronRoute.GET as unknown as (req: NextRequest) => Promise<Response>;

const req = (body?: unknown, headers?: Record<string, string>) => new NextRequest("http://x/api", { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers });
const p = (rid?: string) => ({ params: Promise.resolve({ botId: "bot1", rid: rid ?? "" }) });

beforeEach(() => {
  routines = []; conversations = []; access = {}; turns.length = 0;
  turnResult = { ok: true, jobId: "j".repeat(32), conversationId: "" };
  process.env.CRON_SECRET = "s3cret";
  delete process.env.BOT_ROUTINES_CRON;
});

describe("pages du bot : routes", () => {
  it("crée la page avec sa conversation et lance sa première réponse, sans historique", async () => {
    const res = await create(req({ name: "  Bilan  hebdo ", prompt: "Fais le bilan", schedule: "weekly:1" }), p());
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.routine).toMatchObject({ name: "Bilan hebdo", prompt: "Fais le bilan", schedule: "weekly:1", conversationId: "c1" });
    expect(j.jobId).toHaveLength(32);
    expect(j.routine.lastRunAt).not.toBeNull();
    expect(conversations[0].title).toBe("Bilan hebdo");
    expect(turns).toEqual([{ userId: "u1", conversationId: "c1", message: "Fais le bilan", fresh: true }]);
  });

  it("refuse une page sans nom, sans question, ou à la fréquence inconnue", async () => {
    expect((await create(req({ name: "", prompt: "x" }), p())).status).toBe(400);
    expect((await create(req({ name: "x", prompt: " " }), p())).status).toBe(400);
    expect((await create(req({ name: "x", prompt: "y", schedule: "hourly" }), p())).status).toBe(400);
    expect(routines).toHaveLength(0);
  });

  it("garde la page si la première réponse ne peut pas partir (quota), et le dit", async () => {
    turnResult = { ok: false, status: 429, error: "quota du jour atteint" };
    const j = await (await create(req({ name: "Bilan", prompt: "q" }), p())).json();
    expect(j).toMatchObject({ jobId: null, error: "quota du jour atteint" });
    expect(j.routine.lastRunAt).toBeNull();
    expect(routines).toHaveLength(1);
  });

  it("plafonne le nombre de pages par personne", async () => {
    for (let i = 0; i < 8; i++) await create(req({ name: `P${i}`, prompt: "q" }), p());
    expect((await create(req({ name: "Trop", prompt: "q" }), p())).status).toBe(429);
  });

  it("renomme l'onglet (et le titre de sa conversation), ne montre que ses propres pages", async () => {
    await create(req({ name: "Bilan", prompt: "q" }), p());
    routines.push({ id: "other", botId: "bot1", userId: "u2", conversationId: "cx", name: "Autre", prompt: "q", schedule: "manual", position: 0, lastRunAt: null });
    const res = await patch(req({ name: "Point du lundi" }), p("r1"));
    expect((await res.json()).routine.name).toBe("Point du lundi");
    expect(conversations[0].title).toBe("Point du lundi");
    expect((await patch(req({ name: "Volé" }), p("other"))).status).toBe(404);
    expect((await patch(req({ name: " " }), p("r1"))).status).toBe(400);
    expect((await (await list(req(), p())).json()).routines.map((r: { id: string }) => r.id)).toEqual(["r1"]);
  });

  it("actualise avec la question enregistrée, et supprime la page avec sa conversation", async () => {
    await create(req({ name: "Bilan", prompt: "Fais le bilan" }), p());
    turns.length = 0;
    const res = await run(req({}), p("r1"));
    expect(res.status).toBe(202);
    expect(turns).toEqual([{ userId: "u1", conversationId: "c1", message: "Fais le bilan", fresh: true }]);
    expect((await run(req({}), p("nope"))).status).toBe(404);
    expect((await remove(req({}), p("r1"))).status).toBe(200);
    expect(routines).toHaveLength(0);
    expect(conversations).toHaveLength(0);
  });
});

describe("pages du bot : passage du matin", () => {
  const auth = { authorization: "Bearer s3cret" };
  const old = new Date("2020-01-01T00:00:00Z");
  const mk = (id: string, userId: string, schedule: string, lastRunAt: Date | null): Routine => ({ id, botId: "bot1", userId, conversationId: `c-${id}`, name: id, prompt: `q-${id}`, schedule, position: 0, lastRunAt, user: { id: userId, email: `${userId}@dt.fr`, role: "client" } });

  it("refuse sans le secret, et s'arrête avec l'interrupteur", async () => {
    expect((await cron(req())).status).toBe(401);
    process.env.BOT_ROUTINES_CRON = "off";
    routines = [mk("a", "u1", "daily", old)];
    expect(await (await cron(req(undefined, auth))).json()).toEqual({ off: true });
    expect(turns).toHaveLength(0);
  });

  it("ne relance que les pages dues, pour leur propriétaire, et saute un accès retiré", async () => {
    routines = [mk("a", "u1", "daily", old), mk("b", "u1", "manual", old), mk("c", "u1", "daily", new Date()), mk("d", "u9", "daily", old)];
    access = { u9: 403 };
    const j = await (await cron(req(undefined, auth))).json();
    expect(j).toMatchObject({ due: 2, started: 1 });
    expect(j.skipped).toEqual(["d : accès retiré"]);
    expect(turns).toEqual([{ userId: "u1", conversationId: "c-a", message: "q-a", fresh: true }]);
    // started → no longer due on the next pass
    turns.length = 0;
    expect((await (await cron(req(undefined, auth))).json()).started).toBe(0);
  });

  it("une page qui n'a pas pu partir reste due pour le passage suivant", async () => {
    routines = [mk("a", "u1", "daily", old)];
    turnResult = { ok: false, status: 429, error: "3 réponses sont déjà en cours" };
    expect((await (await cron(req(undefined, auth))).json()).started).toBe(0);
    expect(routines[0].lastRunAt).toBe(old);
  });
});
