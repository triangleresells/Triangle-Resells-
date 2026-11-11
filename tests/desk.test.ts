import { describe, expect, it, vi } from "vitest";
import { OrderDesk, SalesLog, StockKeeper, trackerTab, type SheetIO } from "../src/desk.js";
import { Bot, payTextFor, type WebhookPayload } from "../src/bot.js";
import type { OrderTools, ReplyEngine } from "../src/ai.js";
import type { HandoffAlert } from "../src/handoff.js";
import type { InstagramApi } from "../src/instagram.js";
import { loadPricing } from "../src/config.js";
import { Store } from "../src/store.js";

const STOCK = [
  ["BOT STOCK - the DM bot reads this tab."],
  ["Category", "Brand", "Item", "Color", "Size", "Qty", "Price List", "Status", "Notes", "Cost"],
  ["Hat", "Chrome Hearts", "Chrome Hearts Hat", "Black", "One Size", "5", "CHROME HEARTS HATS", "FOR SALE", "", "15"],
  ["Tee", "BAPE", "BAPE Tee", "Black (1F80120036)", "", "", "BAPE TEES", "INCOMING", "", "14"],
  ["Fragrance", "", "YSL Y EDP", "", "", "9", "FRAGRANCES", "FOR SALE", "", "10.75"],
];

function fakeSheets(rows = STOCK.map((r) => [...r])) {
  const writes: { range: string; values: (string | number)[][]; sheetId?: string }[] = [];
  const io: SheetIO = {
    tabs: vi.fn(async () => [rows]),
    ranges: vi.fn(async () => [[["11/1/2026"], ["11/2/2026"]]]),
    write: vi.fn(async (data, sheetId) => {
      for (const d of data) {
        writes.push({ ...d, sheetId });
        const m = d.range.match(/^'BOT STOCK'!F(\d+)$/);
        if (m) rows[Number(m[1]) - 1][5] = String(d.values[0][0]);
      }
    }),
  };
  return { io, writes, rows };
}

describe("stock keeper", () => {
  it("takes sold pieces off BOT STOCK and puts them back on cancel", async () => {
    const f = fakeSheets();
    const keeper = new StockKeeper(f.io);
    expect(await keeper.adjust([{ name: "Chrome Hearts Hat", variant: "Black", qty: 3 }, { name: "YSL Y EDP", qty: 1 }], -1)).toEqual([]);
    expect(f.writes.map((w) => [w.range, w.values[0][0]])).toEqual([
      ["'BOT STOCK'!F3", 2],
      ["'BOT STOCK'!F5", 8],
    ]);
    await keeper.adjust([{ name: "Chrome Hearts Hat", variant: "Black", qty: 3 }], 1);
    expect(f.rows[2][5]).toBe("5");
  });

  it("never sells INCOMING rows and reports what it couldn't find", async () => {
    const f = fakeSheets();
    const problems = await new StockKeeper(f.io).adjust([{ name: "BAPE Tee", variant: "Black (1F80120036)", size: "M", qty: 1 }], -1);
    expect(problems[0]).toContain("not found");
  });
});

describe("sales log", () => {
  it("writes a pickup into the local table on the right month tab, skipping Profit", async () => {
    const f = fakeSheets();
    await new SalesLog(f.io, "TRACKER").log({
      date: new Date("2026-11-12T20:00:00Z"),
      username: "kbventuresco",
      products: "6x Chrome Hearts Hat Black",
      cost: 90,
      itemsTotal: 120,
      payment: "zelle",
      fulfillment: "pickup",
      notes: "Bot order",
    });
    expect(trackerTab(new Date("2026-11-12T20:00:00Z"))).toBe("Nov 2026");
    expect(f.writes[0]).toMatchObject({ range: "'Nov 2026'!AD8:AI8", sheetId: "TRACKER", values: [["11/12/2026", "Bot", "@kbventuresco", "6x Chrome Hearts Hat Black", 90, 120]] });
    expect(f.writes[1].range).toBe("'Nov 2026'!AK8:AN8");
  });

  it("writes a shipped order with the address into the online table", async () => {
    const f = fakeSheets();
    await new SalesLog(f.io, "T").log({
      date: new Date("2026-11-12T20:00:00Z"),
      products: "1x YSL Y EDP",
      cost: 10.75,
      itemsTotal: 60,
      shipping: 10,
      payment: "cash app",
      fulfillment: "ship",
      notes: "",
      shipTo: { name: "Jay Smith", street: "1 Main St", city: "Atlanta", state: "GA", zip: "30301" },
    });
    expect(f.writes[0].values[0]).toEqual(["11/12/2026", "Instagram", "", "1x YSL Y EDP", 10.75, 70, "", 10]);
    expect(f.writes[1].values[0]).toContain("Jay Smith");
    expect(f.writes[1].values[0]).toContain("30301");
  });
});

describe("order desk", () => {
  it("booked: stock off, BOOKED with cost, calendar + alert; paid logs once; cancel puts stock back", async () => {
    const f = fakeSheets();
    const store = new Store();
    const alerts: HandoffAlert[] = [];
    const cal = vi.fn(async () => {});
    const { parseStockCsv } = await import("../src/catalog.js");
    const desk = new OrderDesk({
      store,
      notify: async (a) => void alerts.push(a),
      accountName: "Triangle Resells",
      stock: new StockKeeper(f.io),
      sales: new SalesLog(f.io, "T"),
      calendar: cal,
      stockRows: async () => parseStockCsv(f.rows),
    });
    const label = await desk.booked({
      userId: "u1",
      lines: [{ name: "Chrome Hearts Hat", variant: "Black", qty: 2 }],
      items: "2x Chrome Hearts Hat Black",
      itemsTotal: 58,
      total: 58,
      payment: "zelle",
      fulfillment: "pickup",
      fulfillDate: "2026-11-13",
      fulfillTime: "3:00 PM",
      freebies: ["1 free Baccarat Rouge"],
    });
    expect(label).toMatchObject({ label: "BOOKED", cost: 30 });
    expect(f.rows[2][5]).toBe("3");
    expect((cal.mock.calls[0] as any)[0].title).toContain("BOOKED");
    expect(alerts[0].reason).toContain("BOOKED $58");
    expect(await desk.markPaid(label.id)).toBe(true);
    expect(await desk.markPaid(label.id)).toBe(false);
    const logged = f.writes.filter((w) => w.sheetId === "T" && w.range.includes("AD"));
    expect(logged).toHaveLength(1);
    expect(await desk.cancel(label.id)).toEqual({ ok: true, wasLogged: true });
    expect(f.rows[2][5]).toBe("5");
  });
});

describe("bot payment rules", () => {
  const OWN = "17840000000000000";
  const dm = (text: string, mid: string): WebhookPayload => ({ object: "instagram", entry: [{ id: OWN, messaging: [{ sender: { id: "u1" }, recipient: { id: OWN }, message: { mid, text } }] }] });

  async function run(call: (t: OrderTools) => Promise<unknown>) {
    let out: unknown;
    const agent: ReplyEngine = { reply: vi.fn(async (_h, _i, tools?: OrderTools) => ((out = await call(tools!)), { text: "ok" })) };
    const ig: InstagramApi = { sendText: vi.fn(async () => "m"), sendPrivateReply: vi.fn(async () => "m"), replyToComment: vi.fn(async () => {}), getUsername: vi.fn(async () => "buyer") };
    const alerts: HandoffAlert[] = [];
    const booked = vi.fn(async () => ({}) as any);
    const store = new Store();
    const bot = new Bot({
      ig, agent, store, notify: async (a) => void alerts.push(a), getInventory: async () => "", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [],
      humanPauseHours: 12, pricing: loadPricing(), now: () => new Date("2026-11-05T19:00:00Z"), desk: { booked, stripePaid: vi.fn() },
      payInfo: { zelle: "919-480-7349", cashApp: "$TriangleResells" },
    });
    await bot.handle(dm("yo", "m1"));
    return { out: out as any, alerts, booked, store };
  }
  const hats = [{ product: "Chrome Hearts Hat", variant: "Black", qty: 2 }];

  it("sends cash deliveries to Josh and keeps shipped orders prepaid", async () => {
    expect((await run((t) => t.submitOrder!(hats, "delivery", "2026-11-06", "4:00 PM", "Garner", "cash"))).out).toMatchObject({ ok: false, handoff: true });
    expect((await run((t) => t.submitOrder!(hats, "ship", "2026-11-06", undefined, undefined, "cash"))).out).toMatchObject({ ok: false, fixable: true });
  });

  it("won't book a shipped order without the full address", async () => {
    const r = await run((t) => t.submitOrder!(hats, "ship", "2026-11-06", undefined, undefined, "zelle", { name: "Jay", street: "1 Main", city: "", state: "GA", zip: "" }));
    expect(r.out.error).toContain("city, zip");
  });

  it("books a Zelle pickup with the exact lines and hands the buyer the Zelle info", async () => {
    const r = await run((t) => t.submitOrder!(hats, "pickup", "2026-11-06", "4:00 PM", undefined, "zelle"));
    expect(r.out).toMatchObject({ ok: true });
    expect(r.out.payText).toContain("919-480-7349");
    expect(r.booked.mock.calls[0]).toMatchObject([{ lines: [{ name: "Chrome Hearts Hat", variant: "Black", qty: 2 }], payment: "zelle", fulfillment: "pickup" }]);
  });

  it("'I sent it' alerts Josh to check, flags the order, and never confirms", async () => {
    const r = await run((t) => t.paymentSent!("zelle", "screenshot shows $58 to Josh"));
    expect(r.out).toContain("Never say the payment is confirmed");
    expect(r.alerts[0].reason).toContain("CHECK YOUR APP");
  });

  it("cash orders get no payment info", () => {
    expect(payTextFor("cash", 58)).toContain("cash at pickup");
    expect(payTextFor("cash_app", 58, { cashApp: "$X" })).toContain("Cash App $58 to $X");
  });
});
