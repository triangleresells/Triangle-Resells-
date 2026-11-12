import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { OrderTools, ReplyEngine } from "../src/ai.js";
import { Bot } from "../src/bot.js";
import type { HandoffAlert } from "../src/handoff.js";
import type { InstagramApi } from "../src/instagram.js";
import { calendarEventFor, confirmationText, handlePaidOrder, type CalendarEvent } from "../src/orders.js";
import { loadPricing } from "../src/config.js";
import { parseStockCsv } from "../src/catalog.js";
import { quoteOrder, tierPrice, type PricingConfig } from "../src/pricing.js";
import { Store } from "../src/store.js";
import { checkoutParams, isValidStripeSignature, paidOrderFromEvent, toForm, type CheckoutApi } from "../src/stripe.js";

// The saved snapshot of the warehouse sheet (BOT STOCK + BOT PRICES).
const pricing = loadPricing();
// Same prices with deep stock, for bulk-tier math.
const deep: PricingConfig = { ...pricing, stock: pricing.stock!.map((r) => (r.status === "for_sale" ? { ...r, qty: 999 } : r)) };
// The real sheet has no free gifts right now. These sample FREEBIE rows test the gift feature on its own.
const GIFTS = parseStockCsv(
  "Category,Brand,Item,Color,Size,Qty,Price List,Status,Notes\nGift,Promo,Promo Gift,,,9,,FREEBIE,1 free with EVERY order\nGift,Promo,Bonus Gift,,,1,,FREEBIE,Free with any 5+ piece order",
);
const withGifts: PricingConfig = { ...pricing, stock: [...pricing.stock!, ...GIFTS] };

describe("pricing", () => {
  it("uses the last tier reached for in-between quantities", () => {
    expect(tierPrice(pricing.tables.ALO, 12)).toBe(43);
    expect(tierPrice(pricing.tables.ALO, 30)).toBe(41);
    expect(tierPrice(pricing.tables.FRAGRANCES, 250)).toBe(24);
    expect(tierPrice(pricing.tables["CHROME HEARTS HATS"], 25)).toBe(21);
    expect(quoteOrder(deep, [{ product: "Alo Hoodie", variant: "Black", size: "XS", qty: 12 }], "pickup").total).toBe(12 * 43);
  });

  it("prices each price list separately and counts its items, sizes and colors together", () => {
    const q = quoteOrder(
      pricing,
      [
        { product: "Chrome Hearts Tee", variant: "White", size: "XL", qty: 1 },
        { product: "Spider Hoodie", variant: "Black/Pink", size: "S", qty: 1 },
        { product: "Alo Hoodie", variant: "Black", size: "XS", qty: 2 },
        { product: "Alo Hoodie", variant: "Gray", size: "M", qty: 1 },
        { product: "Alo Sweatpants", variant: "Black", size: "XL", qty: 2 },
      ],
      "pickup",
    );
    expect(q.problems).toEqual([]);
    expect(q.groups.find((g) => g.product === "ALO")).toMatchObject({ pieces: 5, unitPrice: 48 });
    expect(q.subtotal).toBe(35 + 80 + 5 * 48);
    expect(q.shipping).toBe(0);
  });

  it("adds FREEBIE rows to orders (every order, or 5+ pieces), never charged", () => {
    const one = quoteOrder(withGifts, [{ product: "Bleu de Chanel EDP", qty: 1 }], "pickup");
    expect(one).toMatchObject({ total: 60, freebies: ["1 free Promo Gift"] });
    const four = quoteOrder(withGifts, [{ product: "Chrome Hearts Hat", variant: "Black", qty: 4 }], "pickup");
    expect(four.freebies).toEqual(["1 free Promo Gift"]);
    const five = quoteOrder(withGifts, [{ product: "Chrome Hearts Hat", variant: "Black", qty: 5 }], "pickup");
    expect(five).toMatchObject({ total: 130, freebies: ["1 free Promo Gift", "1 free Bonus Gift"] });
  });

  it("gives no free gifts while the sheet has none (Baccarat and G-Shock are gone)", () => {
    expect(quoteOrder(pricing, [{ product: "Chrome Hearts Hat", variant: "Black", qty: 5 }], "pickup").freebies).toEqual([]);
    expect(quoteOrder(pricing, [{ product: "Baccarat Rouge", qty: 1 }], "pickup").lines).toHaveLength(0);
  });

  it("never sells freebies or NOT FOR SALE rows, and doesn't sell what's not on the sheet", () => {
    const q = quoteOrder(
      withGifts,
      [
        { product: "Promo Gift", qty: 1 },
        { product: "Bonus Gift", qty: 1 },
        { product: "Rolex", qty: 1 },
        { product: "Gallery Dept Jeans", size: "32", qty: 1 },
        { product: "Essentials Hoodie", qty: 1 },
        { product: "Hellstar Hoodie", qty: 1 },
      ],
      "pickup",
    );
    expect(q.lines).toHaveLength(0);
    expect(q.problems[0]).toContain("free gift");
    expect(q.problems[1]).toContain("free gift");
    expect(q.problems[2]).toContain("NOT FOR SALE");
    expect(q.problems[3]).toContain("NOT FOR SALE");
    expect(q.problems[4]).toContain("INCOMING");
    expect(q.problems[5]).toContain("not on the stock sheet");
  });

  it("keeps Valley its own brand and checks colors, sizes and counts against the sheet", () => {
    expect(quoteOrder(pricing, [{ product: "Valley Hoodie", variant: "Black/Burgundy", size: "M", qty: 1 }], "pickup").total).toBe(60);
    expect(quoteOrder(pricing, [{ product: "Alo Sweatpants", variant: "Light Gray", size: "L", qty: 1 }], "pickup").problems[0]).toContain("not in stock");
    expect(quoteOrder(pricing, [{ product: "Alo Hoodie", variant: "Gray", size: "M", qty: 2 }], "pickup").problems[0]).toContain("Only 1");
  });

  it("hands CONFIRM rows and rows with no price to Josh instead of making up a price", () => {
    const stock = [
      ...pricing.stock!,
      { category: "Tee", brand: "X", item: "Mystery Tee", color: "Black", size: "M", qty: 3, priceList: "CHROME TEES", status: "for_sale" as const, rawStatus: "FOR SALE", notes: "CONFIRM price with Josh" },
      { category: "Tee", brand: "Y", item: "Blank Tee", color: "White", size: "L", qty: 2, priceList: "", status: "for_sale" as const, rawStatus: "FOR SALE", notes: "" },
    ];
    const q = quoteOrder({ ...pricing, stock }, [{ product: "Mystery Tee", qty: 1 }, { product: "Blank Tee", qty: 1 }], "pickup");
    expect(q.lines).toHaveLength(0);
    expect(q.problems.every((p) => p.includes("Hand off to josh"))).toBe(true);
  });

  it("adds $10 UPS under 10 pieces and none at 10+ (buyer label)", () => {
    expect(quoteOrder(pricing, [{ product: "Alo Hoodie", variant: "Black", size: "XS", qty: 2 }], "ship")).toMatchObject({ shipping: 10, total: 114 });
    const big = quoteOrder(deep, [{ product: "Alo Hoodie", variant: "Black", size: "XS", qty: 10 }], "ship");
    expect(big).toMatchObject({ shipping: 0, buyerProvidesLabel: true, total: 430 });
  });

  it("flags unpriced items instead of guessing", () => {
    const q = quoteOrder(pricing, [{ product: "Supreme Set", qty: 1 }, { product: "BAPE Tee", qty: 0 }], "pickup");
    expect(q.lines).toHaveLength(0);
    expect(q.problems).toHaveLength(2);
  });
});

describe("stripe", () => {
  const q = quoteOrder(pricing, [{ product: "Chrome Hearts Tee", variant: "White", size: "XL", qty: 1 }], "ship");
  const order = { igUserId: "u1", account: "Triangle Resells", fulfillDate: "2026-11-12", summary: "1x Chrome Hearts Tee White XL" };

  it("builds a branded link with shipping, metadata, and a 31-minute hold", () => {
    const p = checkoutParams(q, order, "https://triangleresells.com", 1_000_000_000_000) as any;
    expect(p.branding_settings.button_color).toBe("#D4A017");
    expect(p.line_items).toHaveLength(2);
    expect(p.line_items[1].price_data.unit_amount).toBe(1000);
    expect(p.shipping_address_collection.allowed_countries).toEqual(["US"]);
    expect(p.metadata).toMatchObject({ ig_user_id: "u1", fulfill_date: "2026-11-12", source: "ai_dm_bot" });
    expect(p.expires_at).toBe(1_000_000_000 + 31 * 60);
  });

  it("form-encodes nested params the way Stripe expects", () => {
    const f = toForm({ line_items: [{ quantity: 1, price_data: { unit_amount: 5000 } }] });
    expect(f.get("line_items[0][quantity]")).toBe("1");
    expect(f.get("line_items[0][price_data][unit_amount]")).toBe("5000");
  });

  it("checks Stripe webhook signatures", () => {
    const raw = Buffer.from('{"type":"x"}');
    const t = 1_700_000_000;
    const sig = createHmac("sha256", "whsec").update(`${t}.${raw}`).digest("hex");
    expect(isValidStripeSignature(raw, `t=${t},v1=${sig}`, "whsec", t * 1000)).toBe(true);
    expect(isValidStripeSignature(raw, `t=${t},v1=${"0".repeat(64)}`, "whsec", t * 1000)).toBe(false);
    expect(isValidStripeSignature(raw, `t=${t},v1=${sig}`, "whsec", (t + 3600) * 1000)).toBe(false);
  });

  it("only treats paid bot checkouts as orders", () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          payment_status: "paid",
          amount_total: 10500,
          customer_details: { name: "Test Buyer", email: "t@x.com", phone: "+19195550100" },
          metadata: { source: "ai_dm_bot", ig_user_id: "u1", fulfillment: "pickup", fulfill_date: "2026-11-12", fulfill_time: "3:00 PM", order_summary: "2 hoodies" },
        },
      },
    };
    expect(paidOrderFromEvent(event)).toMatchObject({ igUserId: "u1", total: 105, fulfillTime: "3:00 PM" });
    expect(paidOrderFromEvent({ ...event, data: { object: { ...event.data.object, metadata: { slugs: "hoodie-vendor" } } } })).toBeUndefined();
  });
});

describe("paid orders", () => {
  const order = {
    sessionId: "cs_1",
    igUserId: "u1",
    account: "Triangle Resells",
    fulfillment: "pickup" as const,
    fulfillDate: "2026-11-12",
    fulfillTime: "3:00 PM",
    buyerLabel: false,
    summary: "1x Essentials Hoodie Black L, 1x Spider Hoodie Pink/Black M",
    total: 105,
    buyerName: "Test Buyer",
  };

  it("puts a held pickup on the calendar for the pickup day, not the payment day", () => {
    const e = calendarEventFor(order, "123 Warehouse Rd");
    expect(e).toMatchObject({ date: "2026-11-12", time: "3:00 PM", location: "123 Warehouse Rd" });
    expect(e.title).toContain("PICKUP");
    expect(e.description).toContain("Hold these items");
  });

  it("DMs the buyer, adds the calendar event, and alerts the team, even if one step fails", async () => {
    const dms: string[] = [];
    const events: CalendarEvent[] = [];
    const alerts: HandoffAlert[] = [];
    await handlePaidOrder(order, {
      sendDm: async (_id, t) => {
        dms.push(t);
      },
      calendar: async () => {
        throw new Error("calendar down");
      },
      notify: async (a) => {
        alerts.push(a);
      },
      warehouseAddress: "",
      accountName: "Triangle Resells",
    });
    expect(dms[0]).toContain("paid ✅");
    expect(dms[0]).toContain("Thu, Nov 12 at 3:00 PM");
    expect(events).toHaveLength(0);
    expect(alerts[0]).toMatchObject({ paused: false });
    expect(confirmationText({ ...order, fulfillment: "ship" }, "")).toContain("UPS");
  });
});

describe("bot checkout", () => {
  it("makes the link from the price list and always gets it to the customer", async () => {
    const sent: string[] = [];
    const ig: InstagramApi = {
      sendText: vi.fn(async (_to, text) => {
        sent.push(text);
        return "mid";
      }),
      sendPrivateReply: vi.fn(async () => "mid"),
      replyToComment: vi.fn(async () => {}),
      getUsername: vi.fn(async () => "buyer"),
    };
    const checkout: CheckoutApi = { create: vi.fn(async () => ({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1", expiresAt: 0 })) };
    let seenTotal = 0;
    const agent: ReplyEngine = {
      reply: vi.fn(async (_h, _inv, tools?: OrderTools) => {
        const r = await tools!.checkout!([{ product: "Alo Hoodie", variant: "Gray", size: "M", qty: 1 }, { product: "Spider Hoodie", variant: "Black/Pink", size: "S", qty: 1 }], "pickup", "2026-11-12", "3:00 PM");
        if (r.ok) seenTotal = r.total;
        return { text: "bet, all sales final. here's your link, holding it for you", checkoutUrl: r.ok ? r.url : undefined };
      }),
    };
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
      checkout,
      now: () => new Date("2026-11-05T17:00:00Z"),
    });
    await bot.handle({ object: "instagram", entry: [{ id: "own", messaging: [{ sender: { id: "u1" }, recipient: { id: "own" }, message: { mid: "m1", text: "ok send it" } }] }] });
    expect(seenTotal).toBe(150);
    expect(sent[0]).toContain("https://checkout.stripe.com/c/pay/cs_1");
    expect((checkout.create as any).mock.calls[0][1]).toMatchObject({ igUserId: "u1", fulfillDate: "2026-11-12", fulfillTime: "3:00 PM" });
  });
});

describe("alerts", () => {
  it("alerts Josh about a missing item without pausing the chat", async () => {
    const alerts: HandoffAlert[] = [];
    const ig: InstagramApi = {
      sendText: vi.fn(async () => "mid"),
      sendPrivateReply: vi.fn(async () => "mid"),
      replyToComment: vi.fn(async () => {}),
      getUsername: vi.fn(async () => "buyer"),
    };
    const store = new Store();
    const agent: ReplyEngine = {
      reply: vi.fn(async () => ({
        text: "don't got supreme rn, but I got spider hoodies in S and M. want me to set you up?",
        alerts: [{ reason: "asked for item not in stock", summary: "Supreme set, size L" }],
      })),
    };
    const bot = new Bot({ ig, agent, store, notify: async (a) => void alerts.push(a), getInventory: async () => "", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [], humanPauseHours: 12, pricing });
    await bot.handle({ object: "instagram", entry: [{ id: "own", messaging: [{ sender: { id: "u1" }, recipient: { id: "own" }, message: { mid: "m1", text: "got a supreme set?" } }] }] });
    expect(alerts[0]).toMatchObject({ route: "josh", paused: false, summary: "Supreme set, size L" });
    expect(store.isPaused("u1")).toBe(false);
  });
});

describe("screenshots", () => {
  it("downloads DM pictures and sends the latest ones to the AI as images", async () => {
    const ig: InstagramApi = {
      sendText: vi.fn(async () => "mid"),
      sendPrivateReply: vi.fn(async () => "mid"),
      replyToComment: vi.fn(async () => {}),
      getUsername: vi.fn(async () => "buyer"),
    };
    const agent: ReplyEngine = { reply: vi.fn(async () => ({ text: "that's the ABC Camo, what size?" })) };
    const bot = new Bot({
      ig, agent, store: new Store(), notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells",
      keywords: [], publicCommentReplies: [], humanPauseHours: 12,
      fetchImage: async () => ({ mediaType: "image/jpeg", data: "AAAA" }),
    });
    await bot.handle({ object: "instagram", entry: [{ id: "own", messaging: [{ sender: { id: "u1" }, recipient: { id: "own" }, message: { mid: "m1", text: "how much for this", attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }] } }] }] });
    const history = (agent.reply as any).mock.calls[0][0];
    expect(history.at(-1).images).toHaveLength(1);
    const { toApiMessages } = await import("../src/ai.js");
    const msgs = toApiMessages(history) as any;
    expect(msgs[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", data: "AAAA" } });
  });

  it("rejects files that aren't images", async () => {
    const { downloadImage } = await import("../src/bot.js");
    const fake = (async () => new Response("x", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    expect(await downloadImage("https://x", fake)).toBeUndefined();
  });
});

describe("FREEBIES_ENABLED switch", () => {
  // The live sheet as it was: Baccarat and G-Shock still marked FREEBIE.
  const oldSheet = [
    ["Category", "Brand", "Item", "Color", "Size", "Qty", "Price List", "Status", "Notes"],
    ["Hat", "Chrome Hearts", "Chrome Hearts Hat", "Black", "", "10", "CHROME HEARTS HATS", "FOR SALE", ""],
    ["Fragrance", "Baccarat", "Baccarat Rouge (B tier)", "", "", "9", "", "FREEBIE", "1 free with EVERY order"],
    ["Watch", "Casio", "G-Shock", "Black", "", "1", "", "FREEBIE", "Free with any 5+ piece order"],
  ];

  it("ignores FREEBIE rows on the live sheet unless FREEBIES_ENABLED=true", async () => {
    const { catalogFrom } = await import("../src/sheet.js");
    const off = catalogFrom({ ...pricing, freebiesEnabled: false }, oldSheet, [], "sheet");
    expect(off.text).not.toMatch(/Baccarat|G-Shock/);
    expect(quoteOrder(off.pricing, [{ product: "Chrome Hearts Hat", variant: "Black", qty: 5 }], "pickup").freebies).toEqual([]);
    const on = catalogFrom({ ...pricing, freebiesEnabled: true }, oldSheet, [], "sheet");
    expect(quoteOrder(on.pricing, [{ product: "Chrome Hearts Hat", variant: "Black", qty: 5 }], "pickup").freebies).toHaveLength(2);
  });

  it("is off unless FREEBIES_ENABLED is exactly true", async () => {
    const { loadConfig } = await import("../src/config.js");
    const base = { IG_APP_SECRET: "x", IG_ACCESS_TOKEN: "x", IG_VERIFY_TOKEN: "x", ANTHROPIC_API_KEY: "x" };
    expect(loadConfig(base).pricing.freebiesEnabled).toBe(false);
    expect(loadConfig({ ...base, FREEBIES_ENABLED: "TRUE" }).pricing.freebiesEnabled).toBe(true);
    expect(loadConfig({ ...base, FREEBIES_ENABLED: "pending" }).pricing.freebiesEnabled).toBe(false);
  });
});
