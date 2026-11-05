import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { OrderTools, ReplyEngine } from "../src/ai.js";
import { Bot, followUpText } from "../src/bot.js";
import type { InstagramApi } from "../src/instagram.js";
import { calendarEventFor } from "../src/orders.js";
import { deliveryFor, quoteOrder, type PricingConfig } from "../src/pricing.js";
import { deliveryProblem, type BusyBlock } from "../src/schedule.js";
import { Store } from "../src/store.js";
import { checkoutParams, paidOrderFromEvent, type CheckoutApi } from "../src/stripe.js";

const pricing = JSON.parse(readFileSync(new URL("../config/pricing.json", import.meta.url), "utf8")) as PricingConfig;
const NOW = new Date("2026-11-05T19:00:00Z"); // Thu Nov 5, 2:00 PM ET

describe("delivery fees", () => {
  it("charges by drive time: $5 / $10 / $15 / $20", () => {
    expect(deliveryFor(pricing, "Knightdale")).toMatchObject({ ok: true, fee: 5 });
    expect(deliveryFor(pricing, "Durham, NC")).toMatchObject({ ok: true, fee: 10 });
    expect(deliveryFor(pricing, "chapel hill")).toMatchObject({ ok: true, fee: 15 });
    expect(deliveryFor(pricing, "Rocky Mount")).toMatchObject({ ok: true, fee: 20 });
    expect(deliveryFor(pricing, "north raleigh")).toMatchObject({ ok: true, area: "Raleigh", fee: 5 });
  });

  it("won't deliver over an hour away and never guesses unknown towns", () => {
    expect(deliveryFor(pricing, "Greensboro")).toMatchObject({ ok: false, reason: "too_far" });
    expect(deliveryFor(pricing, "Atlantis")).toMatchObject({ ok: false, reason: "unknown_area" });
    const q = quoteOrder(pricing, [{ product: "alo_hoodie", qty: 50 }], "delivery", "Greensboro");
    expect(q.problems[0]).toContain("Too far");
  });

  it("adds the fee to the total and the Stripe link", () => {
    const q = quoteOrder(pricing, [{ product: "alo_hoodie", variant: "Gray", size: "M", qty: 2 }], "delivery", "Durham");
    expect(q).toMatchObject({ subtotal: 104, total: 114, delivery: { area: "Durham", minutes: 30, fee: 10 } });
    const p = checkoutParams(q, { igUserId: "u", account: "Triangle Resells", fulfillDate: "2026-11-06", fulfillTime: "3:00 PM", summary: "x" }, "https://x") as any;
    expect(p.line_items.at(-1).price_data).toMatchObject({ unit_amount: 1000, product_data: { name: "Local Delivery (Durham)" } });
    expect(p.shipping_address_collection).toBeTruthy();
    expect(p.metadata).toMatchObject({ fulfillment: "delivery", delivery_area: "Durham", delivery_minutes: "30" });
  });
});

describe("delivery routes: farthest first", () => {
  // Fri Nov 6: a Knightdale (15 min) drop at 4:00 PM is already booked.
  const busy: BusyBlock[] = [{ start: "2026-11-06T21:00:00Z", end: "2026-11-06T21:30:00Z", title: "🚗 DELIVERY 15min Knightdale: buyer – $60" }];

  it("puts the farther Durham drop before the closer Knightdale one", () => {
    expect(deliveryProblem("2026-11-06", "2:00 PM", 30, busy, NOW)).toBeUndefined();
    expect(deliveryProblem("2026-11-06", "5:00 PM", 30, busy, NOW)).toContain("farthest delivery goes first");
    expect(deliveryProblem("2026-11-06", "5:00 PM", 10, busy, NOW)).toBeUndefined();
    expect(deliveryProblem("2026-11-06", "4:00 PM", 30, busy, NOW)).toContain("taken");
  });

  it("calendar titles carry the drive time so the bot can read routes back", () => {
    const ev = calendarEventFor(
      { sessionId: "cs", igUserId: "u", account: "a", fulfillment: "delivery", fulfillDate: "2026-11-06", fulfillTime: "2:00 PM", buyerLabel: false, summary: "2x Alo", total: 114, deliveryArea: "Durham", deliveryMinutes: 30, shipTo: "1 Main St, Durham, NC 27701" },
      "",
    );
    expect(ev.title).toContain("🚗 DELIVERY 30min Durham");
    expect(ev).toMatchObject({ time: "2:00 PM", location: "1 Main St, Durham, NC 27701" });
    const paid = paidOrderFromEvent({
      type: "checkout.session.completed",
      data: { object: { id: "cs", payment_status: "paid", amount_total: 11400, metadata: { source: "ai_dm_bot", ig_user_id: "u", fulfillment: "delivery", fulfill_date: "2026-11-06", fulfill_time: "2:00 PM", delivery_area: "Durham", delivery_minutes: "30" } } },
    });
    expect(paid).toMatchObject({ fulfillment: "delivery", deliveryArea: "Durham", deliveryMinutes: 30, fulfillDate: "2026-11-06" });
  });
});

function harness(agentFn: ReplyEngine["reply"], now: { t: Date }) {
  const sent: string[] = [];
  const ig: InstagramApi = {
    sendText: vi.fn(async (_to, text) => {
      sent.push(text);
      return `mid-${sent.length}`;
    }),
    sendPrivateReply: vi.fn(async () => "mid"),
    replyToComment: vi.fn(async () => {}),
    getUsername: vi.fn(async () => "buyer"),
  };
  const checkout: CheckoutApi = { create: vi.fn(async () => ({ id: "cs", url: `https://checkout.stripe.com/${sent.length}`, expiresAt: 0 })) };
  const store = new Store(() => now.t.getTime());
  const bot = new Bot({
    ig, agent: { reply: vi.fn(agentFn) }, store, notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells",
    keywords: [], publicCommentReplies: [], humanPauseHours: 12, pricing, checkout, now: () => now.t,
  });
  const dm = (text: string, mid: string) =>
    bot.handle({ object: "instagram", entry: [{ id: "own", messaging: [{ sender: { id: "u1" }, recipient: { id: "own" }, message: { mid, text } }] }] });
  return { bot, sent, dm, checkout };
}

describe("follow-up on unpaid links", () => {
  const makeLink: ReplyEngine["reply"] = async (_h, _i, tools?: OrderTools) => {
    const r = await tools!.checkout([{ product: "alo_hoodie", variant: "Gray", size: "M", qty: 1 }], "pickup", "2026-11-06", "3:00 PM");
    return { text: "All sales final. Here's your link, I'm holding it for you.", checkoutUrl: r.ok ? r.url : undefined };
  };

  it("follows up once after the link expires, and not before", async () => {
    const now = { t: NOW };
    const { bot, sent, dm } = harness(makeLink, now);
    await dm("2 alo gray m pickup tmrw 3", "m1");
    now.t = new Date(NOW.getTime() + 20 * 60_000);
    expect(await bot.followUpUnpaid()).toBe(0);
    now.t = new Date(NOW.getTime() + 32 * 60_000);
    expect(await bot.followUpUnpaid()).toBe(1);
    expect(sent.at(-1)).toBe(followUpText("1x Alo Hoodie Gray M"));
    now.t = new Date(NOW.getTime() + 120 * 60_000);
    expect(await bot.followUpUnpaid()).toBe(0); // only once
  });

  it("skips the follow-up once they pay or say they don't want it", async () => {
    const now = { t: NOW };
    const a = harness(makeLink, now);
    await a.dm("send the link", "m1");
    a.bot.markPaid("u1");
    now.t = new Date(NOW.getTime() + 40 * 60_000);
    expect(await a.bot.followUpUnpaid()).toBe(0);

    now.t = NOW;
    let first = true;
    const b = harness(async (h, i, tools) => {
      if (first) {
        first = false;
        return makeLink(h, i, tools);
      }
      return { text: "No problem at all, I'm here if you change your mind.", cancelFollowUp: true };
    }, now);
    await b.dm("send the link", "m1");
    await b.dm("nah I'm good actually", "m2");
    now.t = new Date(NOW.getTime() + 40 * 60_000);
    expect(await b.bot.followUpUnpaid()).toBe(0);
  });
});

describe("new prices (Nov 5)", () => {
  it("jeans $70, Valley hoodies $60, hats $30, every cologne $60", () => {
    const q = quoteOrder(
      pricing,
      [
        { product: "jeans", qty: 1 },
        { product: "valley_hoodie", qty: 1 },
        { product: "hat", qty: 2 },
        { product: "cologne", variant: "Prada Paradoxe", qty: 1 },
        { product: "cologne", variant: "Valentino Born in Roma", qty: 1 },
      ],
      "pickup",
    );
    expect(q.problems).toEqual([]);
    expect(q.groups.map((g) => [g.product, g.unitPrice])).toEqual([
      ["jeans", 70],
      ["valley_hoodie", 60],
      ["hat", 30],
      ["cologne", 52], // 2 colognes hit the 2-piece tier
    ]);
  });
});
