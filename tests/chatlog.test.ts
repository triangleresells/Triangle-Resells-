import { describe, expect, it, vi } from "vitest";
import type { AgentReply, ReplyEngine } from "../src/ai.js";
import { Bot, type WebhookPayload } from "../src/bot.js";
import { supabaseChatLog, type ChatLog, type ChatRole } from "../src/chatlog.js";
import type { InstagramApi } from "../src/instagram.js";
import { Store } from "../src/store.js";

const OWN = "own";
const USER = "buyer-1";
const dm = (text: string, mid: string): WebhookPayload => ({ object: "instagram", entry: [{ id: OWN, messaging: [{ sender: { id: USER }, recipient: { id: OWN }, message: { mid, text } }] }] });
const echo = (text: string, mid: string): WebhookPayload => ({ object: "instagram", entry: [{ id: OWN, messaging: [{ sender: { id: OWN }, recipient: { id: USER }, message: { mid, text, is_echo: true } }] }] });

function fakeLog(silentFor = new Set<string>(), older: { role: ChatRole; text: string; at: string }[] = []) {
  const saved: { userId: string; role: ChatRole; text: string }[] = [];
  const proposed: { question: string; answer: string }[] = [];
  const needs: boolean[] = [];
  const log: ChatLog = {
    message: async (userId, role, text) => void saved.push({ userId, role, text }),
    setNeedsHuman: async (_u, v) => void needs.push(v),
    isSilent: async (u) => silentFor.has(u),
    propose: async (_u, question, answer) => void proposed.push({ question, answer }),
    recent: async () => older,
    approvedText: async () => "\n\nTEAM-APPROVED ANSWERS\n- Q: does the hoodie shrink?\n  A: no, it's pre-shrunk",
  };
  return { log, saved, proposed, needs };
}

function makeBot(log: ChatLog, replies: AgentReply[], seen: string[] = []) {
  const sent: string[] = [];
  const ig: InstagramApi = { sendText: vi.fn(async (_to, t) => (sent.push(t), `bot-${sent.length}`)), sendPrivateReply: vi.fn(async () => "m"), replyToComment: vi.fn(async () => {}), getUsername: vi.fn(async () => "buyer123") };
  const agent: ReplyEngine = { reply: vi.fn(async (_h, _i, _t, sched?: string) => (seen.push(sched ?? ""), replies.shift() ?? { text: "ok" })) };
  const bot = new Bot({ ig, agent, store: new Store(), notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [], humanPauseHours: 0.1, chatLog: log });
  return { bot, sent, agent };
}

describe("Chats + Knowledge in the phone CRM", () => {
  it("saves the buyer's DM and the bot's reply, and the bot sees approved answers", async () => {
    const f = fakeLog();
    const seen: string[] = [];
    const { bot } = makeBot(f.log, [{ text: "Got you, $52." }], seen);
    await bot.handle(dm("how much is the alo hoodie", "m1"));
    await new Promise((r) => setTimeout(r, 0));
    expect(f.saved).toEqual([
      { userId: USER, role: "customer", text: "how much is the alo hoodie" },
      { userId: USER, role: "bot", text: "Got you, $52." },
    ]);
    expect(seen[0]).toContain("does the hoodie shrink?");
  });

  it("Take over in the CRM keeps the bot quiet in that chat (the DM is still saved)", async () => {
    const f = fakeLog(new Set([USER]));
    const { bot, sent, agent } = makeBot(f.log, [{ text: "should not send" }]);
    await bot.handle(dm("hello?", "m1"));
    expect(sent).toEqual([]);
    expect(agent.reply).not.toHaveBeenCalled();
    expect(f.saved.map((s) => s.role)).toEqual(["customer"]);
  });

  it("learning loop: a question passed to the team + the team's answer in Instagram = a pending knowledge entry", async () => {
    const f = fakeLog();
    const { bot } = makeBot(f.log, [{ text: "alright give me a quick sec bro", alerts: [{ reason: "fabric question", summary: "Is the Valley hoodie cotton?", kind: "question" }] }]);
    await bot.handle(dm("is the valley hoodie cotton?", "m1"));
    await bot.handle(echo("yes 100% cotton, heavyweight", "team-1"));
    await new Promise((r) => setTimeout(r, 0));
    expect(f.proposed).toEqual([{ question: "Is the Valley hoodie cotton?", answer: "yes 100% cotton, heavyweight" }]);
    expect(f.saved.at(-1)).toEqual({ userId: USER, role: "agent", text: "yes 100% cotton, heavyweight" });
    expect(f.needs).toContain(false);
    // A second team message is just chat, not another proposal.
    await bot.handle(echo("lmk if you want it", "team-2"));
    expect(f.proposed).toHaveLength(1);
  });

  it("a handoff marks the chat 'needs a human'", async () => {
    const f = fakeLog();
    const { bot } = makeBot(f.log, [{ text: "alright give me a quick sec bro", handoff: { route: "josh", reason: "wants a discount", summary: "asks for $40" } }]);
    await bot.handle(dm("can you do 40", "m1"));
    expect(f.needs).toEqual([true]);
    // Josh's reply after a handoff is proposed for Knowledge too (with the buyer's question).
    await bot.handle(echo("10pc of bape is $30 each", "team-1"));
    expect(f.proposed).toEqual([{ question: "can you do 40", answer: "10pc of bape is $30 each" }]);
  });
});

describe("longer memory: a buyer coming back after the bot forgot the chat", () => {
  it("loads their earlier messages from Chats (with dates and a 'time has passed' note) before answering", async () => {
    const f = fakeLog(new Set(), [
      { role: "customer", text: "how much for the essentials", at: "2026-11-02T18:00:00Z" },
      { role: "bot", text: "Essentials are $60 and land Monday.", at: "2026-11-02T18:01:00Z" },
      { role: "agent", text: "I got you on a dark M", at: "2026-11-02T19:00:00Z" },
    ]);
    const seen: { role: string; text: string }[][] = [];
    const sent: string[] = [];
    const ig: InstagramApi = { sendText: vi.fn(async (_to, t) => (sent.push(t), "b1")), sendPrivateReply: vi.fn(async () => "m"), replyToComment: vi.fn(async () => {}), getUsername: vi.fn(async () => "buyer123") };
    const agent: ReplyEngine = { reply: vi.fn(async (h) => (seen.push(h.map((t) => ({ role: t.role, text: t.text }))), { text: "Welcome back!" })) };
    const bot = new Bot({ ig, agent, store: new Store(), notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [], humanPauseHours: 0.1, chatLog: f.log });
    await bot.handle(dm("yo did the essentials land", "m9"));
    const h = seen[0];
    expect(h[0]).toEqual({ role: "user", text: "[Nov 2] how much for the essentials" });
    expect(h[1].text).toBe("Essentials are $60 and land Monday.");
    expect(h[2].text).toBe("[Team member replied] I got you on a dark M");
    expect(h[3].text).toContain("Time has passed");
    expect(h.at(-1)).toEqual({ role: "user", text: "yo did the essentials land" });
    // Only once: a chat the bot already remembers isn't reloaded.
    await bot.handle(dm("u there", "m10"));
    expect(seen[1].filter((t) => t.text.includes("Nov 2"))).toHaveLength(1);
  });
});

describe("supabaseChatLog (REST calls)", () => {
  it("upserts the conversation, inserts the message (deduped by Instagram id), and reads Take over with a short cache", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(url.includes("select=bot_silent") ? JSON.stringify([{ bot_silent: true }]) : null, { status: url.includes("select=") ? 200 : 201 });
    }) as unknown as typeof fetch;
    let t = 1_000_000;
    const log = supabaseChatLog("https://x.supabase.co/", "sb_secret_abc", fetchFn, () => t);
    await log.message("123", "customer", "hi", { mid: "mid.1", username: "buyer" });
    expect(calls[0].url).toBe("https://x.supabase.co/rest/v1/conversations?on_conflict=id");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ id: "123", ig_user_id: "123", ig_handle: "buyer" });
    expect(calls[1].url).toBe("https://x.supabase.co/rest/v1/messages?on_conflict=ig_mid");
    expect((calls[1].init.headers as Record<string, string>).Prefer).toContain("ignore-duplicates");
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBeUndefined(); // sb_ keys go in apikey only
    expect(await log.isSilent("123")).toBe(true);
    const n = calls.length;
    expect(await log.isSilent("123")).toBe(true);
    expect(calls.length).toBe(n); // cached
    t += 11_000;
    await log.isSilent("123");
    expect(calls.length).toBe(n + 1);
  });

  it("a database error never throws into the chat", async () => {
    const log = supabaseChatLog("https://x.supabase.co", "k", (async () => new Response(null, { status: 500 })) as unknown as typeof fetch);
    await expect(log.message("1", "bot", "hi")).resolves.toBeUndefined();
    await expect(log.isSilent("1")).resolves.toBe(false);
    await expect(log.approvedText()).resolves.toBe("");
  });
});
