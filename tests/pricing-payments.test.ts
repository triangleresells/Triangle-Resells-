import { describe, expect, it, vi } from "vitest";
import type { ReplyEngine } from "../src/ai.js";
import { Bot, payLineFor, payTextFor } from "../src/bot.js";
import { priceListFor } from "../src/catalog.js";
import { loadPricing } from "../src/config.js";
import { crmPayment } from "../src/crm.js";
import { balanceDue, halfOf, type DepositRow } from "../src/deposits.js";
import type { InstagramApi } from "../src/instagram.js";
import { priceCard, quoteOrder } from "../src/pricing.js";
import { Store } from "../src/store.js";

const pricing = loadPricing();
const card = (item: string, qty?: number) => {
  const hit = priceListFor(pricing.stock ?? [], pricing.tables, item)!;
  return priceCard(pricing, hit.list, hit.name, qty);
};

describe("Josh's bulk tiers (per piece, firm)", () => {
  it.each([
    ["Essentials hoodie", 1, 60],
    ["Essentials hoodie", 3, 60], // bulk starts at 5
    ["Essentials hoodie", 7, 50], // in-between: the 5 tier
    ["Essentials hoodie", 12, 42], // the 10 tier
    ["Essentials hoodie", 25, 30],
    ["Essentials hoodie", 45, 25], // 40+
    ["Spider hoodie", 1, 80],
    ["Spider hoodie", 7, 60],
    ["Spider hoodie", 12, 54],
    ["Spider hoodie", 25, 45], // 25 uses the 20 tier
    ["Spider hoodie", 45, 41], // above the top tier: the 30 price
    ["BAPE tee", 4, 40],
    ["BAPE tee", 7, 35],
    ["BAPE tee", 12, 32],
    ["BAPE tee", 25, 27],
    ["BAPE tee", 45, 24],
  ])("%s x%i = $%i each", (item, qty, each) => {
    expect(card(item, qty)).toContain(`${qty} pieces: $${each} each = $${each * qty}`);
  });

  it("31+ Spider or BAPE: the 30 price and a handoff so the team confirms; 30 itself is quoted normally", () => {
    expect(card("Spider hoodie", 31)).toMatch(/above the 30-piece top tier: tell them \$41 each and call handoff_to_team/);
    expect(card("BAPE tee", 30)).not.toMatch(/above the 30-piece/);
  });

  it("Essentials 40+ is a real tier (no handoff)", () => {
    expect(card("Essentials", 60)).not.toMatch(/handoff/);
  });

  it("Supreme hoodies: no bulk pricing at any quantity", () => {
    expect(card("Supreme hoodie")).toMatch(/No bulk pricing on/);
    expect(card("Supreme hoodie", 20)).toContain("20 pieces: $100 each = $2000");
  });

  it("the price card lists the single price and the bulk tiers from 5", () => {
    expect(card("Spider hoodie")).toContain("$80 each (single price)");
    expect(card("Spider hoodie")).toContain("5+ $60, 10+ $54, 15+ $49, 20+ $45, 30+ $41");
  });

  it("finds price lists for restock items that aren't in stock", () => {
    expect(priceListFor(pricing.stock ?? [], pricing.tables, "essentials")).toMatchObject({ list: "ESSENTIALS", status: expect.stringMatching(/restock|sold out|in stock/) });
    expect(priceListFor(pricing.stock ?? [], pricing.tables, "nike tech fleece")).toBeUndefined();
  });

  it("quote_order flags 31+ Spider for the team (in-stock case)", () => {
    const stocked = { ...pricing, stock: (pricing.stock ?? []).map((r) => (r.priceList === "SPIDER HOODIES" ? { ...r, status: "for_sale" as const, qty: 100 } : r)) };
    const row = stocked.stock.find((r) => r.priceList === "SPIDER HOODIES")!;
    const q = quoteOrder(stocked, [{ product: row.item, variant: row.color, size: row.size, qty: 35 }], "pickup");
    expect(q.groups[0].unitPrice).toBe(41);
    expect(q.problems.join(" ")).toMatch(/above the 30-piece top tier/);
  });
});

describe("payment methods", () => {
  const info = { cashApp: "$triangleresells", zelle: "919-480-7349", venmo: "@joshua-cervantes-51", paypal: "paypal.me/joshuacervantes551" };
  it("Venmo and PayPal lines use Josh's handles exactly", () => {
    expect(payLineFor("venmo", 70, info)).toBe("Venmo $70 to @joshua-cervantes-51");
    expect(payLineFor("paypal", 70, info)).toBe("PayPal $70: paypal.me/joshuacervantes551");
    expect(payLineFor("cash_app", 70, info)).toBe("Cash App $70 to $triangleresells");
  });
  it("a 50% deposit: half now, balance stated", () => {
    expect(halfOf(105)).toBe(52.5);
    expect(balanceDue(105, 52.5)).toBe(52.5);
    const t = payTextFor("venmo", 105, info, 52.5);
    expect(t).toContain('"Venmo $52.5 to @joshua-cervantes-51"');
    expect(t).toContain("balance due is $52.5");
  });
  it("the CRM gets venmo / paypal", () => {
    expect(crmPayment("venmo")).toBe("venmo");
    expect(crmPayment("paypal")).toBe("paypal");
  });
});

describe("Bot: Apple Pay handoff and deposits", () => {
  function setup() {
    const ig: InstagramApi = { sendText: vi.fn(async () => "m"), sendPrivateReply: async () => "m", replyToComment: async () => {}, getUsername: async () => "buyer" };
    const agent: ReplyEngine = { reply: vi.fn(async () => ({ text: "ok" })) };
    const deposits: DepositRow[] = [];
    const stocked = { ...pricing, stock: (pricing.stock ?? []).map((r) => (r.priceList === "SPIDER HOODIES" ? { ...r, status: "for_sale" as const, qty: 20 } : r)) };
    const bot = new Bot({
      ig, agent, store: new Store(), notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [], humanPauseHours: 1,
      pricing: stocked, payInfo: { venmo: "@joshua-cervantes-51", paypal: "paypal.me/joshuacervantes551" },
      recordDeposit: async (d) => void deposits.push(d),
      now: () => new Date("2026-11-17T15:00:00Z"),
    });
    const tools = (bot as any).orderTools("e2e-test-dep", stocked);
    const row = stocked.stock.find((r) => r.priceList === "SPIDER HOODIES")!;
    const items = [{ product: row.item, variant: row.color, size: row.size, qty: 1 }];
    return { tools, deposits, items };
  }

  it("Apple Pay (cards off) hands the chat to the team instead of booking", async () => {
    const { tools, items } = setup();
    const r = await tools.submitOrder(items, "pickup", "2026-11-18", "3:00 PM", undefined, "apple_pay");
    expect(r).toMatchObject({ ok: false, handoff: true });
  });

  it("a 50% deposit on a bulk order asks for half now and records the deposit in the CRM when they say it's sent", async () => {
    const { tools, deposits, items } = setup();
    const bulk = [{ ...items[0], qty: 5 }]; // 5 Spider hoodies = $60 each = $300
    const r = await tools.submitOrder(bulk, "pickup", "2026-11-18", "3:00 PM", undefined, "venmo", undefined, "half");
    expect(r.ok).toBe(true);
    expect(r.payText).toContain('"Venmo $150 to @joshua-cervantes-51"');
    expect(r.payText).toContain("balance due is $150");
    await tools.paymentSent("venmo", "sent $150");
    expect(deposits).toHaveLength(1);
    expect(deposits[0]).toMatchObject({ deposit: 150, orderTotal: 300, payment: "venmo", isTest: true });
    await tools.paymentSent("venmo", "sent it again?"); // once per order
    expect(deposits).toHaveLength(1);
  });

  it("under 5 pieces: no 50% deposit, 100% up front (Josh, Nov 18)", async () => {
    const { tools, deposits, items } = setup();
    const r = await tools.submitOrder(items, "pickup", "2026-11-18", "3:00 PM", undefined, "venmo", undefined, "half");
    expect(r).toMatchObject({ ok: false, fixable: true });
    expect(r.error).toContain("only for bulk orders (5+ pieces)");
    expect(r.error).toContain("100% up front");
    const four = await tools.submitOrder([{ ...items[0], qty: 4 }], "pickup", "2026-11-18", "3:00 PM", undefined, "venmo", undefined, "half");
    expect(four.ok).toBe(false);
    expect(deposits).toHaveLength(0);
  });

  it("a full payment records no deposit", async () => {
    const { tools, deposits, items } = setup();
    const r = await tools.submitOrder(items, "pickup", "2026-11-18", "3:00 PM", undefined, "paypal");
    expect(r.payText).toContain('"PayPal $80: paypal.me/joshuacervantes551"');
    await tools.paymentSent("paypal", "sent");
    expect(deposits).toHaveLength(0);
  });
});
