import { describe, expect, it, vi } from "vitest";
import type { AgentReply, ReplyEngine } from "../src/ai.js";
import { Bot, type WebhookPayload } from "../src/bot.js";
import type { KeywordRule } from "../src/config.js";
import type { HandoffAlert } from "../src/handoff.js";
import type { InstagramApi } from "../src/instagram.js";
import { Store } from "../src/store.js";

const OWN_ID = "17840000000000000";
const USER = "user-1";

const keywords: KeywordRule[] = [
  { account: "Triangle Resells", keyword: "PRICE", reply: "Yo, which item? I'll get you the price plus shipping to your state." },
  { account: "Triangle Resells", keyword: "SHIP", reply: "Yo, we ship nationwide! What are you looking for, and what state are you in?" },
];

function setup(agentReply: AgentReply = { text: "Yo, how can I help you?" }) {
  const sent: { to: string; text: string }[] = [];
  const privateReplies: { commentId: string; text: string }[] = [];
  const publicReplies: string[] = [];
  const alerts: HandoffAlert[] = [];
  let n = 0;
  const ig: InstagramApi = {
    sendText: vi.fn(async (to, text) => {
      sent.push({ to, text });
      return `mid-bot-${++n}`;
    }),
    sendPrivateReply: vi.fn(async (commentId, text) => {
      privateReplies.push({ commentId, text });
      return `mid-bot-${++n}`;
    }),
    replyToComment: vi.fn(async (_id, text) => {
      publicReplies.push(text);
    }),
    getUsername: vi.fn(async () => "buyer123"),
  };
  const agent: ReplyEngine = { reply: vi.fn(async () => agentReply) };
  const store = new Store();
  const bot = new Bot({
    ig,
    agent,
    store,
    notify: async (a) => {
      alerts.push(a);
    },
    getInventory: async () => "",
    accountName: "Triangle Resells",
    keywords,
    publicCommentReplies: ["Sent you a DM!"],
    humanPauseHours: 12,
  });
  return { bot, ig, agent, store, sent, privateReplies, publicReplies, alerts };
}

const dm = (text: string, mid: string, extra: Record<string, unknown> = {}): WebhookPayload => ({
  object: "instagram",
  entry: [{ id: OWN_ID, messaging: [{ sender: { id: USER }, recipient: { id: OWN_ID }, message: { mid, text, ...extra } }] }],
});

const echo = (text: string, mid: string): WebhookPayload => ({
  object: "instagram",
  entry: [
    { id: OWN_ID, messaging: [{ sender: { id: OWN_ID }, recipient: { id: USER }, message: { mid, text, is_echo: true } }] },
  ],
});

const comment = (text: string, id = "c1", from = USER): WebhookPayload => ({
  object: "instagram",
  entry: [{ id: OWN_ID, changes: [{ field: "comments", value: { id, text, from: { id: from, username: "buyer123" } } }] }],
});

describe("DMs", () => {
  it("answers a normal DM with the AI reply", async () => {
    const t = setup();
    await t.bot.handle(dm("yo", "m1"));
    expect(t.sent).toEqual([{ to: USER, text: "Yo, how can I help you?" }]);
    expect(t.agent.reply).toHaveBeenCalledOnce();
  });

  it("answers a bare keyword DM with the keyword reply, skipping the AI", async () => {
    const t = setup();
    await t.bot.handle(dm("price!", "m1"));
    expect(t.sent[0].text).toBe(keywords[0].reply);
    expect(t.agent.reply).not.toHaveBeenCalled();
  });

  it("sends a keyword used inside a real question to the AI", async () => {
    const t = setup();
    await t.bot.handle(dm("what's the price on hoodies", "m1"));
    expect(t.agent.reply).toHaveBeenCalledOnce();
  });

  it("ignores Meta's duplicate deliveries", async () => {
    const t = setup();
    await t.bot.handle(dm("yo", "m1"));
    await t.bot.handle(dm("yo", "m1"));
    expect(t.sent).toHaveLength(1);
  });

  it("hands off, pauses, and alerts the team", async () => {
    const t = setup({
      text: "Bet, let me get Josh to put together a bulk quote for you.",
      handoff: { route: "josh", reason: "bulk order", summary: "20 shorts, same brand" },
    });
    await t.bot.handle(dm("I want 20 pairs of shorts, nike", "m1"));
    expect(t.alerts).toEqual([
      expect.objectContaining({ route: "josh", reason: "bulk order", username: "buyer123", userId: USER }),
    ]);
    expect(t.store.isPaused(USER)).toBe(true);

    await t.bot.handle(dm("you there?", "m2"));
    expect(t.sent).toHaveLength(1); // paused: no second reply
  });

  it("ignores its own echoes but pauses when a team member types", async () => {
    const t = setup();
    await t.bot.handle(dm("yo", "m1"));
    await t.bot.handle(echo("Yo, how can I help you?", "mid-bot-1"));
    expect(t.store.isPaused(USER)).toBe(false);

    await t.bot.handle(echo("This is Josh, I got you", "mid-human-1"));
    expect(t.store.isPaused(USER)).toBe(true);
  });

  it("describes photos and shared posts to the AI", async () => {
    const t = setup();
    await t.bot.handle(dm("", "m1", { attachments: [{ type: "image" }] }));
    const history = (t.agent.reply as any).mock.calls[0][0];
    expect(history.at(-1).text).toContain("image");
  });

  it("debounces quick back-to-back texts into one reply", async () => {
    const t = setup();
    (t.bot as any).d.debounceMs = 30;
    await Promise.all([t.bot.handle(dm("yo", "m1")), t.bot.handle(dm("u got hoodies?", "m2"))]);
    expect(t.sent).toHaveLength(1);
  });
});

describe("comment to DM", () => {
  it("DMs the commenter when they comment a keyword, and replies publicly", async () => {
    const t = setup();
    await t.bot.handle(comment("SHIP 🔥", "c1"));
    expect(t.privateReplies).toEqual([{ commentId: "c1", text: keywords[1].reply }]);
    expect(t.publicReplies).toEqual(["Sent you a DM!"]);
  });

  it("does nothing for comments without a keyword", async () => {
    const t = setup();
    await t.bot.handle(comment("fire fit", "c2"));
    expect(t.privateReplies).toHaveLength(0);
  });

  it("ignores our own comments", async () => {
    const t = setup();
    await t.bot.handle(comment("PRICE", "c3", OWN_ID));
    expect(t.privateReplies).toHaveLength(0);
  });

  it("gives the AI the comment context when they reply in DMs", async () => {
    const t = setup();
    await t.bot.handle(comment("PRICE", "c4"));
    await t.bot.handle(dm("the black hoodie, im in texas", "m9"));
    const history = (t.agent.reply as any).mock.calls[0][0];
    expect(history[0].text).toContain("Commented");
    expect(history[1]).toEqual({ role: "assistant", text: keywords[0].reply });
  });
});
