import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AgentReply, OrderTools, ReplyEngine } from "../src/ai.js";
import { Bot, type WebhookPayload } from "../src/bot.js";
import type { KeywordRule } from "../src/config.js";
import type { HandoffAlert } from "../src/handoff.js";
import type { InstagramApi } from "../src/instagram.js";
import { quoteOrder, type PricingConfig } from "../src/pricing.js";
import { pickupProblem, scheduleText, shipDateFor, type BusyBlock } from "../src/schedule.js";
import { Store } from "../src/store.js";
import { paidOrderFromEvent, StripeCheckout } from "../src/stripe.js";

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

describe("pickup schedule and ship cutoff", () => {
  // Thu Nov 5, 2026, 2:00 PM in North Carolina (EST = UTC-5).
  const NOW = new Date("2026-11-05T19:00:00Z");
  const busy: BusyBlock[] = [
    { start: "2026-11-06T20:00:00Z", end: "2026-11-06T20:30:00Z" }, // Fri 3:00-3:30 PM taken
    { start: "2026-11-07T05:00:00Z", end: "2026-11-08T05:00:00Z", allDay: true, title: "CLOSED" }, // Sat closed
    { start: "2026-11-09T05:00:00Z", end: "2026-11-10T05:00:00Z", allDay: true, title: "📦 SHIP: buyer" }, // doesn't block
  ];

  it("allows only open times from 10 AM to 10 PM", () => {
    expect(pickupProblem("2026-11-06", "2:30 PM", busy, NOW)).toBeUndefined();
    expect(pickupProblem("2026-11-06", "3pm", busy, NOW)).toContain("already taken");
    expect(pickupProblem("2026-11-06", "3:15 PM", busy, NOW)).toContain("already taken");
    expect(pickupProblem("2026-11-06", "9:00 AM", busy, NOW)).toContain("10 AM to 10 PM");
    expect(pickupProblem("2026-11-06", "10:00 PM", busy, NOW)).toContain("10 AM to 10 PM");
    expect(pickupProblem("2026-11-06", "9", busy, NOW)).toBeUndefined(); // bare 9 = 9 PM
    expect(pickupProblem("2026-11-07", "2:00 PM", busy, NOW)).toContain("closed");
    expect(pickupProblem("2026-11-09", "2:00 PM", busy, NOW)).toBeUndefined();
    expect(pickupProblem("2026-11-05", "1:00 PM", busy, NOW)).toContain("passed");
  });

  it("tells the AI the hours and taken times", () => {
    const text = scheduleText(busy, NOW);
    expect(text).toContain("10:00 AM to 10:00 PM");
    expect(text).toContain("Fri, Nov 6 (2026-11-06): 3:00 PM-3:30 PM");
    expect(text).toContain("Sat, Nov 7 (2026-11-07): CLOSED");
  });

  it("ships next day when paid after 7pm ET, never before the chosen day", () => {
    expect(shipDateFor("2026-11-05", new Date("2026-11-05T23:59:00Z"))).toBe("2026-11-05"); // 6:59 PM
    expect(shipDateFor("2026-11-05", new Date("2026-11-06T00:20:00Z"))).toBe("2026-11-06"); // 7:20 PM
    expect(shipDateFor("2026-11-10", new Date("2026-11-06T00:20:00Z"))).toBe("2026-11-10");
    const paid = paidOrderFromEvent({
      type: "checkout.session.completed",
      created: Date.parse("2026-11-06T00:20:00Z") / 1000,
      data: { object: { id: "cs", payment_status: "paid", amount_total: 6500, metadata: { source: "ai_dm_bot", ig_user_id: "u", fulfillment: "ship", fulfill_date: "2026-11-05", test_order: "true" } } },
    });
    expect(paid).toMatchObject({ fulfillDate: "2026-11-06", test: true });
  });

  it("refuses a taken pickup time so the AI offers another, and marks test-key checkouts", async () => {
    const pricing = JSON.parse(readFileSync(new URL("../config/pricing.json", import.meta.url), "utf8")) as PricingConfig;
    const results: unknown[] = [];
    const agent: ReplyEngine = {
      reply: vi.fn(async (_h, _inv, tools?: OrderTools, schedule?: string) => {
        expect(schedule).toContain("3:00 PM-3:30 PM");
        results.push(await tools!.checkout([{ product: "alo_hoodie", qty: 1 }], "pickup", "2026-11-06", "3:00 PM"));
        results.push(await tools!.checkout([{ product: "alo_hoodie", qty: 1 }], "pickup", "2026-11-06", "4:00 PM"));
        return { text: "bet" };
      }),
    };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/x", expires_at: 1 })));
    const { ig } = setup();
    const bot = new Bot({
      ig,
      agent,
      store: new Store(),
      notify: async () => {},
      getInventory: async () => "",
      accountName: "Triangle Resells",
      keywords: [],
      publicCommentReplies: [],
      humanPauseHours: 12,
      pricing,
      checkout: new StripeCheckout("rk_test_123", "https://triangleresells.com", fetchFn as unknown as typeof fetch),
      getBusy: async () => busy,
      now: () => NOW,
    });
    await bot.handle(dm("3pm friday", "m-sched"));
    expect(results[0]).toMatchObject({ ok: false, fixable: true });
    expect(results[1]).toMatchObject({ ok: true, total: 55 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(decodeURIComponent(body)).toContain("metadata[test_order]=true");
  });

  it("pushes a same-day ship link to tomorrow after 7pm ET", async () => {
    const pricing = JSON.parse(readFileSync(new URL("../config/pricing.json", import.meta.url), "utf8")) as PricingConfig;
    const create = vi.fn(async () => ({ id: "cs", url: "https://checkout.stripe.com/y", expiresAt: 0 }));
    let note = "";
    const agent: ReplyEngine = {
      reply: vi.fn(async (_h, _inv, tools?: OrderTools) => {
        const r = await tools!.checkout([{ product: "spider_hoodie", qty: 1 }], "ship", "2026-11-06");
        if (r.ok) note = r.note ?? "";
        return { text: "bet" };
      }),
    };
    const { ig } = setup();
    const bot = new Bot({
      ig, agent, store: new Store(), notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells",
      keywords: [], publicCommentReplies: [], humanPauseHours: 12, pricing, checkout: { create },
      now: () => new Date("2026-11-07T00:30:00Z"), // Fri Nov 6, 7:30 PM ET
    });
    await bot.handle(dm("ship it", "m-ship"));
    expect((create.mock.calls[0] as unknown as [unknown, { fulfillDate: string }])[1].fulfillDate).toBe("2026-11-07");
    expect(note).toContain("ships tomorrow");
  });
});

describe("prices and rules from Josh (Nov 5)", () => {
  it("prices every fragrance at $60 for 1, LV stays $65", () => {
    const pricing = JSON.parse(readFileSync(new URL("../config/pricing.json", import.meta.url), "utf8")) as PricingConfig;
    expect(quoteOrder(pricing, [{ product: "cologne", variant: "Bleu de Chanel", qty: 1 }], "ship").total).toBe(70);
    expect(quoteOrder(pricing, [{ product: "lv_cologne", qty: 1 }], "pickup").total).toBe(65);
  });

  it("keeps the rule fixes in the bot's instructions", () => {
    const instructions = readFileSync(new URL("../config/agent-instructions.md", import.meta.url), "utf8");
    expect(instructions).toContain("treat it as NOT IN STOCK below (alert_team and keep selling, no handoff)");
    expect(instructions).toContain("the label is provided by them");
    expect(instructions).toContain("at 10+ the label's on you");
    expect(instructions).toContain("PICKUP SCHEDULE");
  });
});

describe("pickup spot and no-bulk items (Nov 6)", () => {
  it("tells paid pickups to meet in the parking lot, never the unit", async () => {
    const { confirmationText } = await import("../src/orders.js");
    const text = confirmationText(
      { sessionId: "cs", igUserId: "u", account: "a", fulfillment: "pickup", fulfillDate: "2026-11-07", fulfillTime: "3:00 PM", buyerLabel: false, summary: "x", total: 55 },
      "Ample Storage, 1260 Partin Rd, Raleigh, NC 27610",
    );
    expect(text).toContain("parking lot at Ample Storage, 1260 Partin Rd");
    expect(text).toContain("bring it out");
    const instructions = readFileSync(new URL("../config/agent-instructions.md", import.meta.url), "utf8");
    expect(instructions).toContain("never offer to let anyone inside");
  });

  it("Valley hoodies and hats are the same price at any quantity; BAPE tees keep their bulk tiers", () => {
    const pricing = JSON.parse(readFileSync(new URL("../config/pricing.json", import.meta.url), "utf8")) as PricingConfig;
    expect(quoteOrder(pricing, [{ product: "valley_hoodie", qty: 10 }], "pickup").groups[0].unitPrice).toBe(60);
    expect(quoteOrder(pricing, [{ product: "hat", qty: 20 }], "pickup").groups[0].unitPrice).toBe(30);
    expect(quoteOrder(pricing, [{ product: "bape_tee", qty: 1 }], "pickup").total).toBe(35);
    expect(quoteOrder(pricing, [{ product: "bape_tee", qty: 3 }], "pickup").groups[0].unitPrice).toBe(31);
    expect(quoteOrder(pricing, [{ product: "cologne", qty: 3 }], "pickup").groups[0].unitPrice).toBe(50);
  });
});

describe("Render placeholders", () => {
  it("treats 'pending' in optional settings as not set up, so those features stay off", async () => {
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig({
      IG_APP_SECRET: "pending", IG_ACCESS_TOKEN: "pending", IG_VERIFY_TOKEN: "made-up", ANTHROPIC_API_KEY: "sk-ant-test",
      INVENTORY_SHEET_CSV_URL: "pending", HANDOFF_WEBHOOK_URL: "Pending", STRIPE_SECRET_KEY: "pending",
      STRIPE_WEBHOOK_SECRET: " pending ", CALENDAR_WEBHOOK_URL: "none", ADMIN_KEY: "a-long-admin-password",
    });
    expect(cfg).toMatchObject({ inventorySheetCsvUrl: "", handoffWebhookUrl: "", stripeSecretKey: "", stripeWebhookSecret: "", calendarWebhookUrl: "", adminKey: "a-long-admin-password" });
  });
});

describe("starter stock list", () => {
  it("uses config/stock.csv until the Google Sheet is connected, and the sheet once it is", async () => {
    const { InventorySheet } = await import("../src/inventory.js");
    const csv = readFileSync(new URL("../config/stock.csv", import.meta.url), "utf8");
    const starter = await new InventorySheet("", fetch, csv).get();
    expect(starter).toContain("Alo Hoodie | Gray | M | 3");
    expect(starter.split("\n")[0]).toContain("Item | Colorway | Size | Qty");
    const sheet = new InventorySheet("https://sheet", (async () => new Response("Item,Qty\nHat,10")) as unknown as typeof fetch, csv);
    expect(await sheet.get()).toBe("Item | Qty\nHat | 10");
  });
});

describe("webhook signature with two possible app secrets", () => {
  it("accepts deliveries signed with either the Instagram or the Facebook app secret", async () => {
    const { createHmac } = await import("node:crypto");
    const { createServer } = await import("../src/server.js");
    const handled: unknown[] = [];
    const app = createServer({ handle: async (p) => void handled.push(p) }, { appSecret: "ig-secret", verifyToken: "v", extraAppSecrets: ["fb-secret"] });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const body = JSON.stringify({ object: "instagram", entry: [] });
    const post = (secret: string) =>
      fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` },
        body,
      }).then((r) => r.status);
    try {
      expect(await post("ig-secret")).toBe(200);
      expect(await post("fb-secret")).toBe(200);
      expect(await post("wrong")).toBe(403);
      expect(handled).toHaveLength(2);
    } finally {
      server.close();
    }
  });
});
