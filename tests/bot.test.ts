import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { withNote, type AgentReply, type OrderTools, type ReplyEngine } from "../src/ai.js";
import { alertWords, Bot, sameAlert, toBubbles, type WebhookPayload } from "../src/bot.js";
import type { KeywordRule } from "../src/config.js";
import type { HandoffAlert } from "../src/handoff.js";
import type { InstagramApi } from "../src/instagram.js";
import { loadPricing } from "../src/config.js";
import { quoteOrder } from "../src/pricing.js";
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

  it("sends a reply with a blank line as two separate texts, and their echoes don't pause the bot", async () => {
    const t = setup({ text: "Bet, size S. What piece you after?\n\nIn S I got Spider hoodies, Alo hoodies and colognes" });
    await t.bot.handle(dm("size small", "m1"));
    expect(t.sent.map((s) => s.text)).toEqual([
      "Bet, size S. What piece you after?",
      "In S I got Spider hoodies, Alo hoodies and colognes",
    ]);
    await t.bot.handle(echo("Bet, size S. What piece you after?", "mid-bot-1"));
    await t.bot.handle(echo("In S I got Spider hoodies, Alo hoodies and colognes", "mid-bot-2"));
    await t.bot.handle(dm("spider", "m2"));
    expect(t.agent.reply).toHaveBeenCalledTimes(2);
  });

  it("caps a reply at 3 texts and keeps a link on its own line", () => {
    expect(toBubbles("a\n\nb\n\nc\n\nd")).toEqual(["a", "b", "c\nd"]);
    expect(toBubbles("here's your link\nhttps://x.co")).toEqual(["here's your link\nhttps://x.co"]);
  });

  it("adds the write-your-reply note onto the last customer turn so turns still alternate", () => {
    const m = withNote([{ role: "user", content: "got godspeed?" }], "NOTE");
    expect(m).toHaveLength(1);
    expect(m[0].content).toEqual([{ type: "text", text: "got godspeed?" }, { type: "text", text: "NOTE" }]);
    expect(withNote([{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }], "NOTE")).toHaveLength(3);
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
    const pricing = loadPricing();
    const results: unknown[] = [];
    const agent: ReplyEngine = {
      reply: vi.fn(async (_h, _inv, tools?: OrderTools, schedule?: string) => {
        expect(schedule).toContain("3:00 PM-3:30 PM");
        results.push(await tools!.checkout!([{ product: "Alo Hoodie", variant: "Black", size: "XS", qty: 1 }], "pickup", "2026-11-06", "3:00 PM"));
        results.push(await tools!.checkout!([{ product: "Alo Hoodie", variant: "Black", size: "XS", qty: 1 }], "pickup", "2026-11-06", "4:00 PM"));
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
    expect(results[1]).toMatchObject({ ok: true, total: 70 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(decodeURIComponent(body)).toContain("metadata[test_order]=true");
  });

  it("pushes a same-day ship link to tomorrow after 7pm ET", async () => {
    const pricing = loadPricing();
    const create = vi.fn(async () => ({ id: "cs", url: "https://checkout.stripe.com/y", expiresAt: 0 }));
    let note = "";
    const agent: ReplyEngine = {
      reply: vi.fn(async (_h, _inv, tools?: OrderTools) => {
        const r = await tools!.checkout!([{ product: "Spider Hoodie", variant: "White/Black", size: "XS", qty: 1 }], "ship", "2026-11-06");
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
  it("prices every fragrance at $60 for 1 (plus $10 UPS)", () => {
    const pricing = loadPricing();
    expect(quoteOrder(pricing, [{ product: "Bleu de Chanel EDP", qty: 1 }], "ship").total).toBe(70);
    expect(quoteOrder(pricing, [{ product: "YSL Y EDP", qty: 1 }], "pickup").total).toBe(60);
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

  it("bulk tiers from the sheet: Valley, hats, BAPE tees and fragrances", () => {
    const base = loadPricing();
    // BAPE is sold out in the snapshot right now; give it stock so the tiers can be checked.
    const pricing = { ...base, stock: base.stock!.map((r) => (r.item === "BAPE Tee (B tier)" ? { ...r, qty: 2 } : r.item === "Chrome Hearts Hat" ? { ...r, qty: 10 } : r)) };
    const valley = quoteOrder(pricing, [{ product: "Valley Hoodie", variant: "White/Black", size: "XL", qty: 1 }, { product: "Valley Hoodie", variant: "Black/Burgundy", size: "M", qty: 1 }, { product: "Valley Hoodie", variant: "Black/Burgundy", size: "L", qty: 1 }], "pickup");
    expect(valley.groups[0].unitPrice).toBe(58);
    expect(quoteOrder(pricing, [{ product: "Chrome Hearts Hat", variant: "White/Black", qty: 10 }], "pickup").groups[0].unitPrice).toBe(21);
    expect(quoteOrder(pricing, [{ product: "BAPE Tee (B tier)", variant: "Black/Green", size: "M", qty: 1 }], "pickup").total).toBe(40);
    expect(quoteOrder(pricing, [{ product: "BAPE Tee (B tier)", variant: "Black/Green/Pink", size: "S", qty: 2 }, { product: "BAPE Tee (B tier)", variant: "Black/Green", size: "M", qty: 1 }], "pickup").groups[0].unitPrice).toBe(36);
    expect(quoteOrder(pricing, [{ product: "YSL Y EDP", qty: 3 }], "pickup").groups[0].unitPrice).toBe(50);
  });
});

describe("Render placeholders", () => {
  it("treats 'pending' in optional settings as not set up, so those features stay off", async () => {
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig({
      IG_APP_SECRET: "pending", IG_ACCESS_TOKEN: "pending", IG_VERIFY_TOKEN: "made-up", ANTHROPIC_API_KEY: "sk-ant-test",
      GOOGLE_SERVICE_ACCOUNT_JSON: "pending", HANDOFF_WEBHOOK_URL: "Pending", STRIPE_SECRET_KEY: "pending",
      STRIPE_WEBHOOK_SECRET: " pending ", CALENDAR_WEBHOOK_URL: "none", ADMIN_KEY: "a-long-admin-password",
    });
    expect(cfg).toMatchObject({ googleServiceAccountJson: "", stripeEnabled: false, handoffWebhookUrl: "", stripeSecretKey: "", stripeWebhookSecret: "", calendarWebhookUrl: "", adminKey: "a-long-admin-password" });
  });
});

describe("warehouse sheet", () => {
  it("uses the saved snapshot until the sheet is readable, then the live BOT STOCK / BOT PRICES tabs", async () => {
    const { LiveCatalog, catalogFrom } = await import("../src/sheet.js");
    const { formatCatalog } = await import("../src/catalog.js");
    const pricing = loadPricing();
    const snapshot = { pricing, text: formatCatalog(pricing.stock!, pricing.tables), source: "snapshot" as const };
    expect(snapshot.text).toContain("Alo Hoodie | Gray | M | 1 | ALO");
    expect(snapshot.text).not.toMatch(/Baccarat|G-Shock/);
    expect(snapshot.text).toContain("NOT FOR SALE (if asked, hand off to josh): Rolex, Gallery Dept Jeans");
    expect(snapshot.text.split("\n\n")[0]).not.toContain("Essentials");
    expect(snapshot.text).toContain("INCOMING, NOT IN STOCK YET");
    expect(snapshot.text).not.toMatch(/Rolex \| /);

    let calls = 0;
    const reader = {
      tabs: async () => {
        calls++;
        if (calls > 1) throw new Error("google down");
        return [
          [["BOT STOCK title"], ["Category", "Brand", "Item", "Color", "Size", "Qty", "Price List", "Status", "Notes"], ["Hat", "CH", "Chrome Hearts Hat", "Black", "One Size", "3", "CHROME HEARTS HATS", "FOR SALE", ""]],
          [["BOT PRICES title"], ["Price List", "Pieces", "Total", "Each", "Notes"], ["CHROME HEARTS HATS", "1", "$25.00", "$25.00", ""]],
        ];
      },
    };
    const live = new LiveCatalog(snapshot, reader);
    const c = await live.get();
    expect(c.source).toBe("sheet");
    expect(quoteOrder(c.pricing, [{ product: "Chrome Hearts Hat", variant: "Black", qty: 1 }], "pickup").total).toBe(25);
    expect(quoteOrder(c.pricing, [{ product: "Alo Hoodie", variant: "Black", size: "XS", qty: 1 }], "pickup").problems[0]).toContain("not on the stock sheet");
    expect(catalogFrom(pricing, "", "", "snapshot").pricing.stock).toEqual([]);
    await expect(new LiveCatalog(snapshot).get()).resolves.toBe(snapshot);
  });

  it("signs a service account JWT and reads both tabs with it", async () => {
    const { generateKeyPairSync, createVerify } = await import("node:crypto");
    const { GoogleSheetsReader, parseServiceAccount, signedJwt } = await import("../src/sheet.js");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyFile = JSON.stringify({ type: "service_account", client_email: "triangle-bot@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    const sa = parseServiceAccount(keyFile)!;
    expect(parseServiceAccount(Buffer.from(keyFile).toString("base64"))?.client_email).toBe(sa.client_email);
    expect(parseServiceAccount("not json")).toBeUndefined();
    const [h, c, sig] = signedJwt(sa).split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toMatchObject({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets" });

    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      return new Response(JSON.stringify({ valueRanges: [{ values: [["a"]] }, { values: [["b"]] }] }));
    }) as unknown as typeof fetch;
    const tabs = await new GoogleSheetsReader(sa, "SHEET123", fetchFn).tabs(["BOT STOCK", "BOT PRICES"]);
    expect(tabs).toEqual([[["a"]], [["b"]]]);
    expect(decodeURIComponent(urls[1])).toContain("/spreadsheets/SHEET123/values:batchGet?ranges='BOT STOCK'!A:Z&ranges='BOT PRICES'!A:Z");
  });
});

describe("no Stripe: cash, Cash App, Apple Pay", () => {
  const NOW = new Date("2026-11-05T19:00:00Z"); // Thu 2 PM ET
  const busy: BusyBlock[] = [];
  it("locks in the order, hands it to Josh, and only offers submit_order", async () => {
    const { toolsFor } = await import("../src/ai.js");
    const pricing = loadPricing();
    const alerts: HandoffAlert[] = [];
    let result: unknown;
    let offered: string[] = [];
    const agent: ReplyEngine = {
      reply: vi.fn(async (_h, _inv, tools?: OrderTools) => {
        offered = toolsFor(tools).map((t) => t.name);
        result = await tools!.submitOrder!([{ product: "Chrome Hearts Hat", variant: "Black", qty: 5 }], "pickup", "2026-11-06", "4:00 PM", undefined, "cash_app");
        return { text: "bet, Josh will send the Cash App right here", handoff: { route: "josh", reason: "new order", summary: (result as { summary: string }).summary } };
      }),
    };
    const { ig } = setup();
    const store = new Store();
    const bot = new Bot({
      ig, agent, store, notify: async (a) => void alerts.push(a), getInventory: async () => "", accountName: "Triangle Resells",
      keywords: [], publicCommentReplies: [], humanPauseHours: 12, pricing, getBusy: async () => busy, now: () => NOW,
    });
    await bot.handle(dm("5 black ch hats, pickup fri 4, cash app", "m-cash"));
    expect(offered).toContain("submit_order");
    expect(offered).not.toContain("create_checkout_link");
    expect(result).toMatchObject({ ok: true, total: 130, freebies: [] });
    expect((result as { summary: string }).summary).toContain("pays by cash app");
    expect(alerts[0]).toMatchObject({ route: "josh" });
    expect(store.isPaused("user-1")).toBe(true);
    // Not paid yet, so it's BOOKED until Josh marks the Cash App as received.
    expect(store.allLabels()).toMatchObject([{ userId: "user-1", label: "BOOKED", payment: "cash app", total: 130 }]);
    expect(store.allLabels()[0].when).toContain("pickup 2026-11-06 4:00 PM");
  });

  it("never books the same order twice when the AI calls submit_order again", async () => {
    const pricing = loadPricing();
    const results: unknown[] = [];
    const order = [{ product: "Chrome Hearts Tee", variant: "White", size: "XL", qty: 1 }];
    const agent: ReplyEngine = {
      reply: vi.fn(async (_h, _inv, tools?: OrderTools) => {
        results.push(await tools!.submitOrder!(order, "pickup", "2026-11-06", "3:00 PM", undefined, "cash_app"));
        return { text: "Locked in." };
      }),
    };
    const { ig } = setup();
    const store = new Store(() => NOW.getTime());
    const bot = new Bot({
      ig, agent, store, notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells",
      keywords: [], publicCommentReplies: [], humanPauseHours: 12, pricing, getBusy: async () => busy, now: () => NOW,
    });
    await bot.handle(dm("yes lock it in", "m-dupe1"));
    await bot.handle(dm("ok", "m-dupe2"));
    expect(results[0]).toMatchObject({ ok: true, total: 35 });
    expect(results[0]).not.toHaveProperty("alreadyBooked");
    expect(results[1]).toMatchObject({ ok: true, total: 35, alreadyBooked: true });
    expect(store.allLabels()).toHaveLength(1);
  });

  it("nudges a quoted buyer who went quiet once, with no gift pitch while there are no freebies", async () => {
    const { quietNudgeText } = await import("../src/bot.js");
    const pricing = loadPricing();
    const now = { t: NOW };
    const sent: string[] = [];
    const ig: InstagramApi = { sendText: vi.fn(async (_to, t) => (sent.push(t), "mid")), sendPrivateReply: vi.fn(async () => "m"), replyToComment: vi.fn(async () => {}), getUsername: vi.fn(async () => "b") };
    const agent: ReplyEngine = {
      reply: vi.fn(async (_h, _inv, tools?: OrderTools) => ({ text: `that's ${tools!.quote([{ product: "YSL Y EDP", qty: 1 }], "pickup")}` })),
    };
    const store = new Store(() => now.t.getTime());
    const bot = new Bot({ ig, agent, store, notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [], humanPauseHours: 12, pricing, now: () => now.t });
    await bot.handle(dm("how much ysl y", "m-q1"));
    now.t = new Date(NOW.getTime() + 60 * 60_000);
    expect(await bot.followUpUnpaid()).toBe(0);
    now.t = new Date(NOW.getTime() + 95 * 60_000);
    expect(await bot.followUpUnpaid()).toBe(1);
    expect(sent.at(-1)).toBe(quietNudgeText("1x YSL Y EDP"));
    expect(sent.at(-1)).not.toContain("free");
    now.t = new Date(NOW.getTime() + 300 * 60_000);
    expect(await bot.followUpUnpaid()).toBe(0);
  });

  it("does not nudge when the customer sent the last message", async () => {
    const pricing = loadPricing();
    const now = { t: NOW };
    const store = new Store(() => now.t.getTime());
    const { ig } = setup();
    const agent: ReplyEngine = { reply: vi.fn(async (_h, _i, tools?: OrderTools) => ({ text: tools!.quote([{ product: "YSL Y EDP", qty: 1 }], "pickup") })) };
    const bot = new Bot({ ig, agent, store, notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [], humanPauseHours: 12, pricing, now: () => now.t, enabled: () => true });
    await bot.handle(dm("how much ysl y", "m-q2"));
    store.addTurn("user-1", { role: "user", text: "hmm" });
    now.t = new Date(NOW.getTime() + 200 * 60_000);
    expect(await bot.followUpUnpaid()).toBe(0);
  });
});

describe("health check", () => {
  it("answers /health for Render with no secrets", async () => {
    const { createServer } = await import("../src/server.js");
    const app = createServer({ handle: async () => {} }, { appSecret: "s", verifyToken: "v", health: async () => ({ botEnabled: false, stock: "snapshot" }) });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true, botEnabled: false, stock: "snapshot" });
    } finally {
      server.close();
    }
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

describe("Instagram token check", () => {
  it("describes the token kind without printing it, and strips pasted spaces", async () => {
    const { describeToken, loadConfig } = await import("../src/config.js");
    expect(describeToken("pending")).toContain("NOT SET");
    expect(describeToken("IGAAabc")).toContain("too short");
    expect(describeToken("IG" + "a".repeat(150))).toContain("Instagram token");
    expect(describeToken("EAA" + "b".repeat(150))).toContain("Facebook-style");
    expect(describeToken("IG" + "a".repeat(150))).not.toContain("aaaa");
    const cfg = loadConfig({ IG_APP_SECRET: "s", IG_ACCESS_TOKEN: " IGabc\n def ", IG_VERIFY_TOKEN: "v", ANTHROPIC_API_KEY: "k" });
    expect(cfg.igAccessToken).toBe("IGabcdef");
  });
});

describe("Facebook-style (EAA) tokens", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const err = () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 });

  it("swaps a user token for the linked Page token and sends through graph.facebook.com", async () => {
    const { InstagramClient } = await import("../src/instagram.js");
    const calls: { url: string; auth: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: String((init.headers as Record<string, string>).Authorization) });
      if (url.includes("/me/accounts")) {
        return ok({ data: [{ id: "page1", name: "Other", access_token: "EAApageOther" }, { id: "page2", name: "Triangle Resells", access_token: "EAApageTriangle", instagram_business_account: { id: "ig123" } }] });
      }
      return ok({ message_id: "m1" });
    }) as unknown as typeof fetch;
    const ig = new InstagramClient("EAAuserToken", "v23.0", fetchFn);
    ig.setAccountId("ig123");
    expect(await ig.sendText("buyer", "hey")).toBe("m1");
    expect(calls[1]).toEqual({ url: "https://graph.facebook.com/v23.0/page2/messages", auth: "Bearer EAApageTriangle" });
  });

  it("uses a Page token as is, and Instagram tokens keep using graph.instagram.com", async () => {
    const { InstagramClient } = await import("../src/instagram.js");
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return url.includes("/me/accounts") ? err() : ok({ message_id: "m" });
    }) as unknown as typeof fetch;
    await new InstagramClient("EAApageToken", "v23.0", fetchFn).sendText("buyer", "hi");
    expect(urls.at(-1)).toBe("https://graph.facebook.com/v23.0/me/messages");
    await new InstagramClient("IGtoken", "v23.0", fetchFn).sendText("buyer", "hi");
    expect(urls.at(-1)).toBe("https://graph.instagram.com/v23.0/me/messages");
  });
});

describe("pause length", () => {
  it("uses HUMAN_PAUSE_MINUTES and shortens pauses that are already running", async () => {
    const { loadConfig } = await import("../src/config.js");
    const base = { IG_APP_SECRET: "s", IG_ACCESS_TOKEN: "t", IG_VERIFY_TOKEN: "v", ANTHROPIC_API_KEY: "k" };
    expect(loadConfig({ ...base, HUMAN_PAUSE_MINUTES: "5", HUMAN_PAUSE_HOURS: "12" }).humanPauseHours).toBeCloseTo(5 / 60);
    expect(loadConfig({ ...base, HUMAN_PAUSE_HOURS: "12" }).humanPauseHours).toBe(12);
    let t = 0;
    const store = new Store(() => t);
    store.pause("me", 12);
    expect(store.capPauses(5 / 60)).toBe(1);
    t = 4 * 60_000;
    expect(store.isPaused("me")).toBe(true);
    t = 6 * 60_000;
    expect(store.isPaused("me")).toBe(false);
  });
});

describe("master switch (BOT_ENABLED)", () => {
  it("sends nothing while OFF: no replies, no comment DMs, no follow-ups, no blasts, and no AI calls", async () => {
    const sendText = vi.fn(async () => "mid");
    const sendPrivateReply = vi.fn(async () => "mid");
    const replyToComment = vi.fn(async () => {});
    const ig: InstagramApi = { sendText, sendPrivateReply, replyToComment, getUsername: vi.fn(async () => "buyer") };
    const agent: ReplyEngine = { reply: vi.fn(async () => ({ text: "hi" })) };
    const store = new Store();
    let on = false;
    const bot = new Bot({
      ig, agent, store, notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells",
      keywords, publicCommentReplies: ["Sent you a DM!"], humanPauseHours: 12, enabled: () => on,
    });
    await bot.handle(dm("how much the alo hoodie", "off-1"));
    await bot.handle(dm("price", "off-2"));
    await bot.handle(comment("PRICE", "c-off"));
    store.setPendingLink(USER, { url: "https://x", summary: "1x Alo", createdAt: 0 });
    expect(await bot.followUpUnpaid()).toBe(0);
    expect((await bot.blast("restock!", "")).sent).toEqual([]);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendPrivateReply).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
    expect(agent.reply).not.toHaveBeenCalled();
    expect(store.history(USER).some((t) => t.text.includes("alo hoodie"))).toBe(true); // still saved

    on = true;
    await bot.handle(dm("you there?", "on-1"));
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("is OFF unless BOT_ENABLED is true", async () => {
    const { loadConfig } = await import("../src/config.js");
    const base = { IG_APP_SECRET: "s", IG_ACCESS_TOKEN: "t", IG_VERIFY_TOKEN: "v", ANTHROPIC_API_KEY: "k" };
    expect(loadConfig(base).botEnabled).toBe(false);
    expect(loadConfig({ ...base, BOT_ENABLED: "false" }).botEnabled).toBe(false);
    expect(loadConfig({ ...base, BOT_ENABLED: "pending" }).botEnabled).toBe(false);
    expect(loadConfig({ ...base, BOT_ENABLED: "true" }).botEnabled).toBe(true);
  });
});

describe("order labels (PAID / BOOKED)", () => {
  it("labels a Stripe-paid order PAID, and Josh can clear it when it's done", () => {
    const t = setup();
    t.bot.markPaid(USER, "1x Spider Hoodie Black/Gold M", 80, "pickup 2026-11-14 3:00 PM");
    const [l] = t.store.allLabels();
    expect(l).toMatchObject({ label: "PAID", payment: "stripe", total: 80, when: "pickup 2026-11-14 3:00 PM" });
    expect(t.store.clearLabel(l.id)).toBe(true);
    expect(t.store.allLabels()).toHaveLength(0);
  });

  it("flips BOOKED to PAID, clears all at end of day, and survives a restart", () => {
    const store = new Store();
    const a = store.addLabel({ userId: "u1", label: "BOOKED", summary: "1x ERD Tee", total: 40, payment: "cash", when: "delivery" });
    store.addLabel({ userId: "u2", label: "BOOKED", summary: "3x cologne", total: 180, payment: "cash app", when: "pickup" });
    expect(store.markLabelPaid(a.id)).toBe(true);
    expect(store.allLabels().find((l) => l.id === a.id)?.label).toBe("PAID");
    const copy = new Store();
    copy.restore(JSON.parse(JSON.stringify(store.snapshot())));
    expect(copy.allLabels()).toHaveLength(2);
    expect(copy.clearAllLabels()).toBe(2);
    expect(copy.allLabels()).toHaveLength(0);
  });

  it("shows open orders on the admin page with a DM link", async () => {
    const { adminPage } = await import("../src/customers.js");
    const store = new Store();
    store.setUsername("u1", "kbventuresco");
    store.addLabel({ userId: "u1", label: "BOOKED", summary: "6x Chrome Hearts Hat", total: 120, payment: "cash", when: "pickup" });
    const html = adminPage("k", undefined, store.allLabels());
    expect(html).toContain("BOOKED");
    expect(html).toContain("https://ig.me/m/kbventuresco");
    expect(html).toContain("Mark paid");
  });
});

describe("human-like reply timing", () => {
  it("waits longer on a cold DM than in a live back-and-forth", async () => {
    const { pickReplyDelay, DEFAULT_REPLY_TIMING: T } = await import("../src/bot.js");
    for (const r of [0, 0.5, 0.999]) {
      const cold = pickReplyDelay(T, undefined, () => r);
      expect(cold).toBeGreaterThanOrEqual(42_000);
      expect(cold).toBeLessThanOrEqual(58_000);
      const gone = pickReplyDelay(T, 5 * 60_000, () => r);
      expect(gone).toBeGreaterThanOrEqual(42_000);
      const live = pickReplyDelay(T, 20_000, () => r);
      expect(live).toBeGreaterThanOrEqual(8_000);
      expect(live).toBeLessThanOrEqual(18_000);
    }
  });

  it("holds the reply, answers a burst of texts once, and shows typing first", async () => {
    const t = setup();
    const typing = vi.fn(async () => {});
    t.ig.typingOn = typing;
    // Cold wait is far longer than the live-chat wait, so a slow machine can't blur the two (was flaky at 80 vs 10 ms).
    (t.bot as any).d.replyTiming = { coldMinMs: 1000, coldMaxMs: 1000, activeMinMs: 10, activeMaxMs: 10, activeWindowMs: 60_000, settleMs: 20 };
    const started = Date.now();
    await Promise.all([t.bot.handle(dm("yo", "m1")), t.bot.handle(dm("u got essentials?", "m2"))]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
    expect(t.sent).toHaveLength(1);
    expect(typing).toHaveBeenCalledWith(USER);
    // They answer right away: live chat, short wait.
    const again = Date.now();
    await t.bot.handle(dm("L please", "m3"));
    expect(Date.now() - again).toBeLessThan(600);
    expect(t.sent).toHaveLength(2);
  });
});

describe("repeat alerts", () => {
  const nike = (summary: string) => ({ reason: "asked for item not carried", summary, kind: "stock" as const });

  it("treats re-worded alerts about the same item as one, and different items as different", () => {
    const first = alertWords(nike("Asked for black Nike Tech Fleece in size L (saw it on story). Not on stock sheet."));
    expect(sameAlert(first, alertWords(nike("Customer wants Nike Tech Fleece, Black, size L, 1 piece. Asked about restock.")))).toBe(true);
    expect(sameAlert(first, alertWords(nike("Asked for light gray Alo Sweatpants in L (sold out).")))).toBe(false);
  });

  it("pings Josh once per item per chat, but always sends questions the buyer is waiting on", async () => {
    const { bot, agent, alerts } = setup();
    const reply = vi.mocked(agent.reply);
    reply.mockResolvedValueOnce({ text: "We don't carry that.", alerts: [nike("Nike Tech Fleece, black, L. Not on sheet.")] });
    reply.mockResolvedValueOnce({ text: "Got you.", alerts: [nike("Customer wants Nike Tech Fleece Black L, 1 piece. Saw it on story.")] });
    reply.mockResolvedValueOnce({ text: "alright give me a quick sec bro", alerts: [{ reason: "asked if it's real", summary: "Is the Nike Tech Fleece L real?", kind: "question" }] });
    reply.mockResolvedValueOnce({ text: "alright give me a quick sec bro", alerts: [{ reason: "asked for pics", summary: "Pics of the Nike Tech Fleece L tag?", kind: "question" }] });
    for (const [i, t] of ["nike tech L?", "black", "is it real", "pics of tag?"].entries()) await bot.handle(dm(t, `m-alert-${i}`));
    expect(alerts.map((a) => a.summary)).toEqual([
      "Nike Tech Fleece, black, L. Not on sheet.",
      "Is the Nike Tech Fleece L real?",
      "Pics of the Nike Tech Fleece L tag?",
    ]);
  });
});

describe("bot takes the chat back when Josh goes quiet", () => {
  function chat(takeoverMinutes?: number) {
    const clock = { t: new Date("2026-11-12T18:00:00Z").getTime() };
    const sent: string[] = [];
    const ig: InstagramApi = { sendText: vi.fn(async (_to, t) => (sent.push(t), `mid-${sent.length}`)), sendPrivateReply: vi.fn(async () => "m"), replyToComment: vi.fn(async () => {}), getUsername: vi.fn(async () => "buyer123") };
    let n = 0;
    const agent: ReplyEngine = { reply: vi.fn(async () => ({ text: `bot reply ${++n}` })) };
    const store = new Store(() => clock.t);
    const bot = new Bot({ ig, agent, store, notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [], humanPauseHours: 12, now: () => new Date(clock.t), takeoverMinutes });
    const wait = (min: number) => (clock.t += min * 60_000);
    return { bot, store, sent, wait };
  }

  it("DM, bot answers, Josh jumps in, buyer answers, Josh is quiet 5 min: the bot answers", async () => {
    const { bot, store, sent, wait } = chat();
    await bot.handle(dm("weird question", "t1"));
    expect(sent).toEqual(["bot reply 1"]);
    await bot.handle(echo("yo it's Josh, I got you", "t2"));
    expect(store.isPaused(USER)).toBe(true);
    wait(1);
    await bot.handle(dm("ok cool, so what about the hoodie", "t3"));
    expect(sent).toHaveLength(1); // Josh has the chat
    wait(4);
    expect(await bot.takeOverStalled()).toBe(0); // only 4 minutes
    wait(1);
    expect(await bot.takeOverStalled()).toBe(1);
    expect(sent.at(-1)).toBe("bot reply 2");
    expect(store.isPaused(USER)).toBe(false);
    await bot.handle(dm("bet", "t4"));
    expect(sent.at(-1)).toBe("bot reply 3"); // back to normal
  });

  it("stays out when Josh answers within 5 minutes", async () => {
    const { bot, sent, wait } = chat();
    await bot.handle(echo("Josh here", "u1"));
    await bot.handle(dm("question for josh", "u2"));
    wait(3);
    await bot.handle(echo("answered it", "u3"));
    wait(10);
    expect(await bot.takeOverStalled()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("TAKEOVER_MINUTES=0 never takes over", async () => {
    const { bot, sent, wait } = chat(0);
    await bot.handle(echo("Josh here", "v1"));
    await bot.handle(dm("hello?", "v2"));
    wait(60);
    expect(await bot.takeOverStalled()).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
