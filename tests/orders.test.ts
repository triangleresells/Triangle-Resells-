import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { OrderTools, ReplyEngine } from "../src/ai.js";
import { Bot } from "../src/bot.js";
import type { HandoffAlert } from "../src/handoff.js";
import type { InstagramApi } from "../src/instagram.js";
import { calendarEventFor, confirmationText, handlePaidOrder, type CalendarEvent } from "../src/orders.js";
import { quoteOrder, tierPrice, type PricingConfig } from "../src/pricing.js";
import { Store } from "../src/store.js";
import { checkoutParams, isValidStripeSignature, paidOrderFromEvent, toForm, type CheckoutApi } from "../src/stripe.js";

const pricing = JSON.parse(readFileSync(new URL("../config/pricing.json", import.meta.url), "utf8")) as PricingConfig;

describe("pricing", () => {
  it("uses the last tier reached for in-between quantities", () => {
    expect(tierPrice(pricing.tables.heavy_hoodies, 12)).toBe(43);
    expect(tierPrice(pricing.tables.heavy_hoodies, 30)).toBe(41);
    expect(tierPrice(pricing.tables.essentials, 250)).toBe(25);
  });

  it("prices each product separately and counts its sizes together (rulebook example: $330)", () => {
    const q = quoteOrder(
      pricing,
      [
        { product: "bape_tee", size: "S", qty: 1 },
        { product: "spider_hoodie", variant: "Pink/Black", size: "M", qty: 1 },
        { product: "alo_hoodie", variant: "Gray", size: "S", qty: 2 },
        { product: "alo_hoodie", variant: "Gray", size: "M", qty: 2 },
        { product: "alo_hoodie", variant: "Gray", size: "L", qty: 1 },
      ],
      "pickup",
    );
    expect(q.subtotal).toBe(330);
    expect(q.shipping).toBe(0);
    expect(q.groups.find((g) => g.product === "alo_hoodie")).toMatchObject({ pieces: 5, unitPrice: 48 });
  });

  it("adds $10 UPS under 10 pieces and none at 10+ (buyer label)", () => {
    expect(quoteOrder(pricing, [{ product: "essentials_hoodie", qty: 2 }], "ship")).toMatchObject({ shipping: 10, total: 100 });
    const big = quoteOrder(pricing, [{ product: "essentials_hoodie", qty: 10 }], "ship");
    expect(big).toMatchObject({ shipping: 0, buyerProvidesLabel: true, total: 330 });
  });

  it("flags unpriced items instead of guessing", () => {
    const q = quoteOrder(pricing, [{ product: "jeans", qty: 1 }, { product: "bape_tee", qty: 0 }], "pickup");
    expect(q.lines).toHaveLength(0);
    expect(q.problems).toHaveLength(2);
  });
});

describe("stripe", () => {
  const q = quoteOrder(pricing, [{ product: "essentials_hoodie", variant: "Black", size: "L", qty: 1 }], "ship");
  const order = { igUserId: "u1", account: "Triangle Resells", fulfillDate: "2026-11-12", summary: "1x Essentials Hoodie Black L" };

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
        const r = await tools!.checkout([{ product: "essentials_hoodie", size: "L", qty: 1 }, { product: "spider_hoodie", size: "M", qty: 1 }], "pickup", "2026-11-12", "3:00 PM");
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
    });
    await bot.handle({ object: "instagram", entry: [{ id: "own", messaging: [{ sender: { id: "u1" }, recipient: { id: "own" }, message: { mid: "m1", text: "ok send it" } }] }] });
    expect(seenTotal).toBe(105);
    expect(sent[0]).toContain("https://checkout.stripe.com/c/pay/cs_1");
    expect((checkout.create as any).mock.calls[0][1]).toMatchObject({ igUserId: "u1", fulfillDate: "2026-11-12", fulfillTime: "3:00 PM" });
  });
});
