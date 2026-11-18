import { describe, expect, it, vi } from "vitest";
import type { AgentReply, ReplyEngine } from "../src/ai.js";
import { Bot, type WebhookPayload } from "../src/bot.js";
import { addDays, HealthClock, healthText, isRecipientError, isSystemicAiError, localClock, SendWatch, type DayHealth, type HealthDb, type SendLogKind } from "../src/health.js";
import type { InstagramApi } from "../src/instagram.js";
import type { PushRow } from "../src/pushalerts.js";
import { Store } from "../src/store.js";

const OWN = "own";
const TOKEN_ERROR = `Instagram API 400 on /me/messages: {"message":"Object with ID 'me' does not exist","type":"GraphMethodException","code":100,"error_subcode":33}`;
const WINDOW_ERROR = `Instagram API 400 on /me/messages: {"message":"This message is sent outside of allowed window.","code":10,"error_subcode":2018278}`;

function fakeDb(open?: number) {
  const rows: { kind: SendLogKind; ig_user_id?: string; is_test?: boolean }[] = [];
  const db: HealthDb = {
    log: async (r) => void rows.push(r),
    openOutageSince: async () => open,
    dayHealth: async (day) => ({ day, messages_handled: 58, buyers: 17, failed_sends: 3, outages: 1, handoffs: 4 }),
  };
  return { db, rows };
}

describe("isRecipientError", () => {
  it("one buyer's problem is not an outage", () => {
    expect(isRecipientError(WINDOW_ERROR)).toBe(true);
    expect(isRecipientError(`{"code":551,"message":"This person isn't available right now."}`)).toBe(true);
  });
  it("a token / permissions error is an outage", () => {
    expect(isRecipientError(TOKEN_ERROR)).toBe(false);
    expect(isRecipientError(`{"code":190,"message":"Error validating access token: Session has expired"}`)).toBe(false);
  });
});

describe("SendWatch: one alert per outage", () => {
  it("alerts once on the first failure, stays quiet during the outage, resets after a success", async () => {
    const { db, rows } = fakeDb();
    const pushes: PushRow[] = [];
    const w = new SendWatch({ account: "triangleresells", db, push: async (p) => void pushes.push(p) });

    await w.failed("a", new Error(TOKEN_ERROR));
    await w.failed("b", new Error(TOKEN_ERROR));
    await w.failed("c", new Error(TOKEN_ERROR));
    expect(pushes.filter((p) => p.title.includes("rejecting"))).toHaveLength(1);
    expect(pushes[0].priority).toBe("urgent");
    expect(rows.filter((r) => r.kind === "send_failed")).toHaveLength(3);
    expect(rows.filter((r) => r.kind === "outage_started")).toHaveLength(1);

    expect((await w.succeeded()).sort()).toEqual(["a", "b", "c"]);
    expect(rows.filter((r) => r.kind === "outage_ended")).toHaveLength(1);
    expect(await w.succeeded()).toEqual([]); // no outage open anymore

    await w.failed("d", new Error(TOKEN_ERROR)); // a NEW outage alerts again
    expect(pushes.filter((p) => p.title.includes("rejecting"))).toHaveLength(2);
  });

  it("a one-buyer rejection is logged but never alerts", async () => {
    const { db, rows } = fakeDb();
    const push = vi.fn(async () => {});
    const w = new SendWatch({ account: "t", db, push });
    await w.failed("a", new Error(WINDOW_ERROR));
    expect(push).not.toHaveBeenCalled();
    expect(w.inOutage()).toBe(false);
    expect(rows.map((r) => r.kind)).toEqual(["recipient_rejected"]);
  });

  it("test buyers never start a real outage", async () => {
    const { db } = fakeDb();
    const push = vi.fn(async () => {});
    const w = new SendWatch({ account: "t", db, push });
    await w.failed("e2e-test-1", new Error(TOKEN_ERROR), true);
    expect(push).not.toHaveBeenCalled();
  });

  it("after a restart mid-outage it doesn't alert again", async () => {
    const { db } = fakeDb(Date.now() - 60_000);
    const push = vi.fn(async () => {});
    const w = new SendWatch({ account: "t", db, push });
    await w.failed("a", new Error(TOKEN_ERROR));
    expect(push).not.toHaveBeenCalled();
  });
});

describe("Bot: drop, alert, catch up after the outage", () => {
  function setup() {
    const clock = { t: Date.parse("2026-11-17T15:00:00Z") };
    let broken = true;
    const sent: { to: string; text: string }[] = [];
    const ig: InstagramApi = {
      sendText: vi.fn(async (to, text) => {
        if (broken) throw new Error(TOKEN_ERROR);
        sent.push({ to, text });
        return `mid-${sent.length}`;
      }),
      sendPrivateReply: async () => "x",
      replyToComment: async () => {},
      getUsername: async () => "buyer",
    };
    const asked: string[] = [];
    const agent: ReplyEngine = {
      reply: vi.fn(async (history): Promise<AgentReply> => {
        const last = [...history].reverse().find((t) => t.role === "user")!.text;
        asked.push(last);
        return { text: `Answer to: ${last}` };
      }),
    };
    const { db, rows } = fakeDb();
    const pushes: PushRow[] = [];
    const sendWatch = new SendWatch({ account: "triangleresells", db, push: async (p) => void pushes.push(p), now: () => clock.t });
    const store = new Store(() => clock.t);
    const bot = new Bot({
      ig, agent, store, notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells", keywords: [],
      publicCommentReplies: [], humanPauseHours: 12, sendWatch, now: () => new Date(clock.t),
    });
    const dm = (from: string, text: string): WebhookPayload => ({
      object: "instagram",
      entry: [{ id: OWN, messaging: [{ sender: { id: from }, recipient: { id: OWN }, message: { mid: `${from}-${text}-${clock.t}`, text } }] }],
    });
    return { bot, clock, sent, rows, pushes, asked, dm, fix: () => (broken = false), store };
  }

  it("drops failed replies, alerts once, then answers waiting buyers with 'Sorry for the wait!'", async () => {
    const t = setup();
    await t.bot.handle(t.dm("old", "do you have the alo hoodie"));
    t.clock.t += 25 * 60 * 60_000; // "old" is now outside the 24h window
    await t.bot.handle(t.dm("a", "how much is the spider hoodie"));
    await t.bot.handle(t.dm("b", "do you ship to texas"));
    expect(t.sent).toHaveLength(0);
    expect(t.pushes.filter((p) => p.type === "bot_outage")).toHaveLength(1);

    t.fix();
    t.clock.t += 60_000;
    await t.bot.handle(t.dm("c", "hello"));
    await vi.waitFor(() => expect(t.sent.map((s) => s.to).sort()).toEqual(["a", "b", "c"]));

    const to = (u: string) => t.sent.find((s) => s.to === u)!.text;
    expect(to("c")).toBe("Answer to: hello"); // never waited: no apology
    expect(to("a")).toBe("Sorry for the wait! Answer to: how much is the spider hoodie");
    expect(to("b")).toBe("Sorry for the wait! Answer to: do you ship to texas");
    expect(t.sent.some((s) => s.to === "old")).toBe(false); // outside 24h: nothing sent
    expect(t.rows.filter((r) => r.kind === "catch_up_sent").map((r) => r.ig_user_id).sort()).toEqual(["a", "b"]);
  });

  it("the outage retry answers the newest waiting buyer once sending works", async () => {
    const t = setup();
    await t.bot.handle(t.dm("a", "is the valley hoodie still available"));
    await t.bot.retryAfterOutage(); // still broken: no new alert
    expect(t.pushes.filter((p) => p.type === "bot_outage")).toHaveLength(1);
    t.fix();
    await t.bot.retryAfterOutage();
    expect(t.sent).toEqual([{ to: "a", text: "Sorry for the wait! Answer to: is the valley hoodie still available" }]);
    await t.bot.retryAfterOutage(); // outage over: nothing more
    expect(t.sent).toHaveLength(1);
  });

  it("a Spanish buyer gets the apology in Spanish", async () => {
    const t = setup();
    await t.bot.handle(t.dm("es", "hola tienes sudaderas en talla m"));
    t.fix();
    await t.bot.retryAfterOutage();
    expect(t.sent[0].text.startsWith("¡Perdón por la espera!")).toBe(true);
  });
});

describe("Bot: the AI itself fails (Nov 17: out of credit, 15h of silence, no alert)", () => {
  const CREDIT = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 });
  function setup(db = fakeDb()) {
    const clock = { t: Date.parse("2026-11-17T15:00:00Z") };
    let aiDown: Error | undefined = CREDIT;
    const sent: { to: string; text: string }[] = [];
    const ig: InstagramApi = {
      sendText: vi.fn(async (to, text) => (sent.push({ to, text }), `mid-${sent.length}`)),
      sendPrivateReply: async () => "x",
      replyToComment: async () => {},
      getUsername: async () => "buyer",
    };
    const agent: ReplyEngine = {
      reply: vi.fn(async (history): Promise<AgentReply> => {
        if (aiDown) throw aiDown;
        return { text: `Answer to: ${[...history].reverse().find((t) => t.role === "user")!.text}` };
      }),
    };
    const pushes: PushRow[] = [];
    const sendWatch = new SendWatch({ account: "triangleresells", db: db.db, push: async (p) => void pushes.push(p), now: () => clock.t });
    const store = new Store(() => clock.t);
    const bot = new Bot({
      ig, agent, store, notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells", keywords: [],
      publicCommentReplies: [], humanPauseHours: 12, sendWatch, now: () => new Date(clock.t),
    });
    const dm = (from: string, text: string): WebhookPayload => ({
      object: "instagram",
      entry: [{ id: OWN, messaging: [{ sender: { id: from }, recipient: { id: OWN }, message: { mid: `${from}-${text}-${clock.t}`, text } }] }],
    });
    return { bot, clock, sent, rows: db.rows, pushes, dm, store, setAi: (e?: Error) => (aiDown = e) };
  }

  it("out of credit: ONE urgent push that says what to do, then 'Sorry for the wait!' once the AI is back", async () => {
    const t = setup();
    await t.bot.handle(t.dm("a", "how much is the spider hoodie"));
    await t.bot.handle(t.dm("b", "do you ship to texas"));
    expect(t.sent).toHaveLength(0);
    const alerts = t.pushes.filter((p) => p.type === "bot_outage");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].priority).toBe("urgent");
    expect(alerts[0].title).toMatch(/AI isn't answering/);
    expect(alerts[0].body).toMatch(/credit/);
    expect(t.rows.filter((r) => r.kind === "send_failed")).toHaveLength(2);

    t.setAi(undefined); // credit added
    t.clock.t += 60_000;
    await t.bot.retryAfterOutage();
    await vi.waitFor(() => expect(t.sent.map((s) => s.to).sort()).toEqual(["a", "b"]));
    expect(t.sent.find((s) => s.to === "a")!.text).toBe("Sorry for the wait! Answer to: how much is the spider hoodie");
    expect(t.pushes.filter((p) => p.title.includes("answering again"))).toHaveLength(1);
  });

  it("never barges into a chat the team took over during the outage", async () => {
    const t = setup();
    await t.bot.handle(t.dm("a", "do you have the purple hoodie"));
    await t.bot.handle(t.dm("b", "how much for 2"));
    // the team answers "a" from the Instagram inbox; the buyer says "bet"
    t.clock.t += 60_000;
    await t.bot.handle({ object: "instagram", entry: [{ id: OWN, messaging: [{ sender: { id: OWN }, recipient: { id: "a" }, message: { mid: "team-1", text: "yes $80, come by", is_echo: true } }] }] });
    t.clock.t += 13 * 60 * 60_000; // past the team pause, still inside 24h
    await t.bot.handle(t.dm("a", "bet")); // the AI is still down: she stays waiting too
    t.setAi(undefined);
    await t.bot.retryAfterOutage();
    await vi.waitFor(() => expect(t.sent.map((s) => s.to)).toEqual(["b"]));
    await new Promise((r) => setTimeout(r, 50));
    expect(t.sent.map((s) => s.to)).toEqual(["b"]);
  });

  it("an AI error about one chat (not credit, key or overload) is logged only: no outage push", async () => {
    const t = setup();
    t.setAi(Object.assign(new Error("400 messages: text content blocks must be non-empty"), { status: 400 }));
    await t.bot.handle(t.dm("a", "hi"));
    expect(t.pushes).toHaveLength(0);
    expect(t.rows).toHaveLength(0);
  });

  it("after a restart mid-outage: no second alert, and the buyers from the log are still caught up", async () => {
    const db = fakeDb(Date.parse("2026-11-17T14:00:00Z"));
    db.db.droppedSince = async () => [{ userId: "a", at: Date.parse("2026-11-17T14:30:00Z") }];
    const t = setup(db);
    // the restored chat: the buyer's question is the last turn
    t.store.addTurn("a", { role: "user", text: "is the valley hoodie still available" });
    t.setAi(undefined);
    await t.bot.retryAfterOutage();
    await vi.waitFor(() => expect(t.sent).toEqual([{ to: "a", text: "Sorry for the wait! Answer to: is the valley hoodie still available" }]));
    expect(t.pushes.filter((p) => p.title.includes("🚨"))).toHaveLength(0);
  });

  it("which AI errors mean the AI is down for everyone", () => {
    expect(isSystemicAiError(CREDIT)).toBe(true);
    expect(isSystemicAiError(Object.assign(new Error("overloaded"), { status: 529 }))).toBe(true);
    expect(isSystemicAiError(Object.assign(new Error("invalid x-api-key"), { status: 401 }))).toBe(true);
    expect(isSystemicAiError(new Error("Connection error."))).toBe(true);
    expect(isSystemicAiError(Object.assign(new Error("messages: roles must alternate"), { status: 400 }))).toBe(false);
  });
});

describe("HealthClock", () => {
  const at = (iso: string) => Date.parse(iso);
  function clockWith(now: { t: number }, expiry?: string) {
    const pushes: PushRow[] = [];
    const days: string[] = [];
    const { db } = fakeDb();
    const c = new HealthClock({
      account: "triangleresells",
      db: { ...db, dayHealth: async (day: string) => (days.push(day), { day, messages_handled: 1, buyers: 1, failed_sends: 0, outages: 0, handoffs: 0 }) },
      push: async (p) => void pushes.push(p),
      tz: "America/New_York",
      summaryAt: "00:00",
      tokenExpiry: async () => expiry,
      tokenAlertTimes: ["09:00", "18:00"],
      now: () => now.t,
    });
    return { c, pushes, days };
  }

  it("at midnight New York time it pushes the summary for the day that just ended, once", async () => {
    const now = { t: at("2026-11-18T05:01:00Z") }; // 00:01 ET on Nov 18
    const { c, pushes, days } = clockWith(now);
    await c.tick();
    await c.tick();
    expect(days).toEqual(["2026-11-17"]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].dedupe_key).toBe("bot-health:triangleresells:2026-11-17");
  });

  it("token warning: twice on the day 3 days before expiry (09:00 and 18:00 ET), never other days", async () => {
    const now = { t: at("2027-01-12T13:00:00Z") }; // 08:00 ET Jan 12, expiry Jan 15
    const { c, pushes } = clockWith(now, "2027-01-15");
    const token = () => pushes.filter((p) => p.type === "token_expiry");
    await c.tick();
    expect(token()).toHaveLength(0);
    now.t = at("2027-01-12T14:05:00Z"); // 09:05 ET
    await c.tick();
    await c.tick();
    expect(token()).toHaveLength(1);
    now.t = at("2027-01-12T23:10:00Z"); // 18:10 ET
    await c.tick();
    expect(token()).toHaveLength(2);
    now.t = at("2027-01-13T14:05:00Z"); // the next day
    await c.tick();
    expect(token()).toHaveLength(2);
  });

  it("formats the summary, marking what isn't tracked yet", () => {
    const h: DayHealth = { day: "2026-11-17", messages_handled: 58, buyers: 17, failed_sends: 3, outages: 1, handoffs: 4 };
    const text = healthText("triangleresells", h);
    expect(text).toContain("Messages handled: 58 from 17 buyer(s)");
    expect(text).toContain("Failed sends: 3 (1 outage)");
    expect(text).toContain("Hot buyers flagged: not tracked yet");
  });

  it("date helpers", () => {
    expect(localClock(at("2026-11-18T04:30:00Z"), "America/New_York")).toEqual({ date: "2026-11-17", minutes: 23 * 60 + 30 });
    expect(addDays("2027-01-01", -3)).toBe("2026-12-29");
  });
});
