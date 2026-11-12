/**
 * End to end: the REAL DM bot code (src/bot.ts + src/desk.ts) talks to the REAL CRM API (crm/src/api) on a local
 * Postgres. Only the AI and Instagram are simulated: the "AI" calls the same tools Claude would.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OrderTools, ReplyEngine } from "../../src/ai.js";
import { Bot, type WebhookPayload } from "../../src/bot.js";
import { loadPricing } from "../../src/config.js";
import { crmClient } from "../../src/crm.js";
import { CrmSync } from "../../src/crmsync.js";
import { OrderDesk } from "../../src/desk.js";
import type { HandoffAlert } from "../../src/handoff.js";
import type { InstagramApi } from "../../src/instagram.js";
import { Store } from "../../src/store.js";
import { createApi } from "../src/api/handler.js";
import { testDb, type TestDb } from "./pg.js";

const KEY = "test-bot-key-0123456789-abcdefghijklmnop";
const NOW = new Date("2026-11-12T15:00:00Z"); // Thu 10 AM ET
const OWN = "17840000000000000";
const BUYER = "ig-test-buyer";

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
beforeEach(async () => {
  await t.reset();
  // The bot's own orders are real (not TEST), so this local test database gets real stock rows; Diego's TEST booking uses TEST stock.
  const hatsRow = { brand: "Chrome Hearts", item: "Chrome Hearts Hat", color: "Black", qty: 20, price_list: "CHROME HEARTS HATS", cost: 12 };
  await t.seedStock([hatsRow], false);
  await t.seedStock([hatsRow], true);
});

type Step = (tools: OrderTools) => Promise<unknown>;

function setup(opts: { crmDown?: boolean; oldScript?: boolean } = {}) {
  const api = createApi({ db: t.asService, botApiKey: KEY });
  const fetchToCrm = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (opts.crmDown) throw new TypeError("fetch failed");
    return api(new Request(String(input), init));
  }) as typeof fetch;
  const crm = crmClient("https://crm.test", KEY, fetchToCrm);
  const store = new Store(() => NOW.getTime());
  const alerts: HandoffAlert[] = [];
  const notify = async (a: HandoffAlert) => void alerts.push(a);
  // Google Calendar (the updated script): each event gets an id; moves and deletes are recorded.
  const cal = { made: [] as { id: string; date: string; time: string }[], moved: [] as unknown[][], deleted: [] as string[] };
  const calendar = async (e: { date: string; time: string }) => {
    const id = `evt${cal.made.length + 1}@google.com`;
    cal.made.push({ id, date: e.date, time: e.time });
    return opts.oldScript ? undefined : id;
  };
  const calendarEdit = {
    move: async (...a: unknown[]) => (cal.moved.push(a), true),
    remove: async (id: string) => (cal.deleted.push(id), true),
  };
  const desk = new OrderDesk({ store, notify, accountName: "Triangle Resells", crm, crmAssignee: "Chema", calendar });
  const steps: Step[] = [];
  const results: unknown[] = [];
  const contexts: string[] = [];
  const agent: ReplyEngine = {
    reply: async (_h, _i, tools, schedule) => {
      contexts.push(schedule ?? "");
      const step = steps.shift();
      if (step) results.push(await step(tools!));
      return { text: "ok" };
    },
  };
  const sent: { to: string; text: string }[] = [];
  const ig: InstagramApi = { sendText: async (to, text) => (sent.push({ to, text }), "m"), sendPrivateReply: async () => "m", replyToComment: async () => {}, getUsername: async () => "TEST_buyer" };
  const bot = new Bot({
    ig, agent, store, notify, getInventory: async () => "", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [],
    humanPauseHours: 12, pricing: loadPricing(), getBusy: async () => [], now: () => NOW, desk, crm, calendarEdit,
    payInfo: { zelle: "919-480-7349", cashApp: "$triangleresells" },
  });
  let n = 0;
  const dm = (text: string, step: Step): Promise<void> => {
    steps.push(step);
    const p: WebhookPayload = { object: "instagram", entry: [{ id: OWN, messaging: [{ sender: { id: BUYER }, recipient: { id: OWN }, message: { mid: `m${++n}`, text } }] }] };
    return bot.handle(p);
  };
  const sync = new CrmSync({ crm, store, desk, calendarEdit, includeTest: true, tellBuyer: (u, txt) => bot.messageBuyer(u, txt), notify, accountName: "Triangle Resells" });
  return { dm, store, alerts, results, cal, sync, contexts, sent };
}

const crmBookings = () => t.asService.rpc<Record<string, any>[]>("bookings_between", { p_from: "2026-11-01", p_to: "2026-11-30", p_include_test: true });
const crmLog = async () => (await t.asService.rpc<Record<string, any>[]>("recent_activity", { p_limit: 200 })).reverse();
const hats = [{ product: "Chrome Hearts Hat", variant: "Black", qty: 2 }];

describe("DM bot -> CRM", () => {
  it("TEST 1: a booked DM order lands in the CRM with every field, the customer, and a Bot log line", async () => {
    const { dm, store, results } = setup();
    await dm("2 black ch hats, pickup sat 4pm, cash app", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    expect(results[0]).toMatchObject({ ok: true });
    const [b] = await crmBookings();
    expect(b).toMatchObject({
      date: "2026-11-14", time: "16:00:00", status: "booked", payment_method: "cash_app", fulfillment: "pickup",
      location: "Warehouse", assignee: "Chema", source: "instagram", source_account: "Triangle Resells", created_by: "Bot",
      customer: { ig_user_id: BUYER, ig_handle: "test_buyer" },
      items: [{ item: "Chrome Hearts Hat", color: "Black", qty: 2 }],
    });
    expect(Number(b.sale_price)).toBeGreaterThan(0);
    expect(Number(b.items[0].unit_price) * 2).toBe(Number(b.sale_price));
    expect(store.latestLabelFor(BUYER)!.crmId).toBe(b.id);
    expect((await crmLog()).find((l) => l.entity === "bookings")).toMatchObject({ actor: "Bot", action: "create" });
  });

  it("TEST 2 + paid rule: the bot reschedules (CRM moves it, logs 'Bot rescheduled'), and 'I sent it' is Paid - needs check", async () => {
    const { dm, alerts, results } = setup();
    await dm("2 hats sat 4pm cash app", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    await dm("can we do friday 11 instead", (tl) => tl.rescheduleOrder!("2026-11-20", "11:00 AM"));
    expect(results[1]).toMatch(/^Moved to pickup 2026-11-20 11:00 AM/);
    const [b] = await crmBookings();
    expect(b).toMatchObject({ date: "2026-11-20", time: "11:00:00" });
    expect((await crmLog()).at(-1)).toMatchObject({ actor: "Bot", summary: "Bot rescheduled to 2026-11-20 11:00" });
    expect(alerts.some((a) => a.reason.startsWith("🔁 Rescheduled"))).toBe(true);
    await dm("sent it", (tl) => tl.paymentSent!("cash_app", "TEST says sent $"));
    expect((await crmBookings())[0].status).toBe("paid_needs_check");
  });

  it("refuses a reschedule to a closed time, and changes nothing", async () => {
    const { dm, results } = setup();
    await dm("hats", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    await dm("can i come at 11pm", (tl) => tl.rescheduleOrder!("2026-11-14", "11:00 PM"));
    expect(results[1]).toMatch(/^Could not move it/);
    expect((await crmBookings())[0]).toMatchObject({ date: "2026-11-14", time: "16:00:00" });
  });

  it("TEST 3: the bot cancels an unpaid order (CRM shows Cancelled with the reason); a paid one goes to Josh instead", async () => {
    const { dm, store, results } = setup();
    await dm("hats", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    await dm("nvm dont want them", (tl) => tl.cancelOrder!("TEST changed their mind"));
    expect(results[1]).toMatch(/^Cancelled/);
    expect((await crmBookings())[0]).toMatchObject({ status: "cancelled", status_reason: "TEST changed their mind" });
    expect(store.latestLabelFor(BUYER)).toBeUndefined();
    // A buyer who says they paid can't get the bot to cancel.
    await dm("hats again", (tl) => tl.submitOrder!([{ product: "Chrome Hearts Hat", variant: "Black", qty: 1 }], "pickup", "2026-11-14", "5:00 PM", undefined, "zelle"));
    await dm("sent it", (tl) => tl.paymentSent!("zelle", "TEST sent"));
    await dm("actually cancel", (tl) => tl.cancelOrder!("TEST wants refund"));
    expect(results.at(-1)).toMatch(/already paid/);
    expect((await crmBookings()).map((b) => b.status).sort()).toEqual(["cancelled", "paid_needs_check"]);
  });

  it("TEST 8: CRM down -> the order still stands for the buyer, nothing half-saved in the CRM, and Josh is alerted", async () => {
    const { dm, store, alerts, results } = setup({ crmDown: true });
    await dm("hats", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    expect(results[0]).toMatchObject({ ok: true });
    expect(store.latestLabelFor(BUYER)!.crmId).toBeUndefined();
    expect(alerts.some((a) => a.reason.includes("NOT saved in the CRM") && a.summary!.includes("CRM unreachable"))).toBe(true);
    expect(await crmBookings()).toEqual([]);
    expect(await crmLog()).toEqual([]);
  });
});

describe("DM bot -> Google Calendar", () => {
  it("moves the calendar event on a reschedule and deletes it on a cancel", async () => {
    const { dm, store, alerts, cal } = setup();
    await dm("hats sat 4", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    expect(cal.made).toEqual([{ id: "evt1@google.com", date: "2026-11-14", time: "4:00 PM" }]);
    expect(store.latestLabelFor(BUYER)!.calendarId).toBe("evt1@google.com");
    await dm("friday 11 instead", (tl) => tl.rescheduleOrder!("2026-11-20", "11:00 AM"));
    expect(cal.moved).toEqual([["evt1@google.com", "2026-11-20", "11:00 AM", 30]]);
    expect(alerts.find((a) => a.reason.startsWith("🔁"))!.summary).toContain("Calendar event moved.");
    await dm("nvm cancel", (tl) => tl.cancelOrder!("TEST"));
    expect(cal.deleted).toEqual(["evt1@google.com"]);
    expect(alerts.find((a) => a.reason.startsWith("❌"))!.summary).toContain("Calendar event deleted.");
  });

  it("events from the old script (no id) are left alone and Josh is told to move them by hand", async () => {
    const { dm, alerts, cal } = setup({ oldScript: true });
    await dm("hats sat 4", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    await dm("friday 11 instead", (tl) => tl.rescheduleOrder!("2026-11-20", "11:00 AM"));
    expect(cal.moved).toEqual([]);
    expect(alerts.find((a) => a.reason.startsWith("🔁"))!.summary).toContain("Move the calendar event by hand");
  });
});

describe("CRM -> bot (the loop back)", () => {
  const bookingId = async () => (await crmBookings())[0].id as string;

  it("starts from now on the first sync, and the bot's own changes never come back to it", async () => {
    const { dm, sync, store } = setup();
    await dm("hats", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    expect(await sync.tick()).toBe(0); // first run: sets the starting point
    await dm("move to fri 11", (tl) => tl.rescheduleOrder!("2026-11-20", "11:00 AM"));
    expect(await sync.tick()).toBe(0); // the bot's own reschedule isn't echoed back
    expect(store.crmCursor()).toBe(0);
  });

  it("a team member reschedules in the CRM -> the bot's order and calendar event move", async () => {
    const { dm, sync, store, cal } = setup();
    await sync.tick();
    await dm("hats", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    const chema = await t.login("Chema");
    await t.asUser(chema).rpc("reschedule_booking", { p_id: await bookingId(), p_date: "2026-11-21", p_time: "13:30" });
    expect(await sync.tick()).toBe(1);
    expect(store.latestLabelFor(BUYER)!.when).toBe("pickup 2026-11-21 1:30 PM");
    expect(cal.moved).toEqual([["evt1@google.com", "2026-11-21", "1:30 PM", 30]]);
  });

  it("a team member cancels in the CRM -> the bot closes the order and deletes the calendar event", async () => {
    const { dm, sync, store, cal } = setup();
    await sync.tick();
    await dm("hats", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    const josh = await t.login("Josh");
    await t.asUser(josh).rpc("cancel_booking", { p_id: await bookingId(), p_reason: "TEST buyer called" });
    await sync.tick();
    expect(store.latestLabelFor(BUYER)).toBeUndefined();
    expect(cal.deleted).toEqual(["evt1@google.com"]);
  });

  it("a team member confirms Paid, then Done -> the bot's order follows", async () => {
    const { dm, sync, store } = setup();
    await sync.tick();
    await dm("hats", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "zelle"));
    const josh = await t.login("Josh");
    await t.asUser(josh).rpc("set_booking_status", { p_id: await bookingId(), p_status: "paid" });
    await sync.tick();
    expect(store.latestLabelFor(BUYER)!.label).toBe("PAID");
    await t.asUser(josh).rpc("set_booking_status", { p_id: await bookingId(), p_status: "done" });
    await sync.tick();
    expect(store.latestLabelFor(BUYER)).toBeUndefined();
  });

  it("a team member adds a booking for an IG buyer -> the bot takes it on, and the buyer can reschedule it in the DMs", async () => {
    const { dm, sync, store, cal, results } = setup();
    await sync.tick();
    const diego = await t.login("Diego");
    await t.asUser(diego).rpc("create_booking", { p: {
      date: "2026-11-15", time: "15:00", payment_method: "cash", fulfillment: "pickup", source: "text", is_test: true,
      customer: { ig_user_id: BUYER, ig_handle: "TEST_buyer" }, items: [{ item: "Chrome Hearts Hat", color: "Black", size: "One Size", qty: 1, unit_price: 35 }],
    } });
    await sync.tick();
    const label = store.latestLabelFor(BUYER)!;
    expect(label).toMatchObject({ label: "BOOKED", when: "pickup 2026-11-15 3:00 PM", summary: "1x Chrome Hearts Hat Black", total: 35, calendarId: "evt1@google.com" });
    expect(cal.made[0]).toMatchObject({ date: "2026-11-15", time: "3:00 PM" });
    await dm("can i do 5 instead", (tl) => tl.rescheduleOrder!("2026-11-15", "5:00 PM"));
    expect(results.at(-1)).toMatch(/^Moved to pickup 2026-11-15 5:00 PM/);
    expect((await crmBookings())[0]).toMatchObject({ time: "17:00:00" });
  });

  it("the AI sees the buyer's current CRM bookings before it answers", async () => {
    const { dm, sync, contexts } = setup();
    await sync.tick();
    await dm("hats", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    const chema = await t.login("Chema");
    await t.asUser(chema).rpc("reschedule_booking", { p_id: await bookingId(), p_date: "2026-11-21", p_time: "13:30" });
    await dm("wait when is my pickup again", async () => null);
    expect(contexts.at(-1)).toContain("THIS BUYER'S BOOKINGS IN THE CRM");
    expect(contexts.at(-1)).toContain("Sat, Nov 21 1:30 PM, pickup, 2x Chrome Hearts Hat Black");
  });
});

describe("stock: CRM <-> BOT STOCK <-> bot", () => {
  /** An in-memory Google Sheet with a BOT STOCK tab laid out like the real one (note row, then headers). */
  function fakeSheet(hatQty: number) {
    const tabs: Record<string, string[][]> = {
      "BOT STOCK": [
        ["BOT STOCK - read me"],
        ["Category", "Brand", "Item", "Color", "Size", "Qty", "Price List", "Status", "Notes", "Cost"],
        ["Hat", "Chrome Hearts", "Chrome Hearts Hat", "Black", "", String(hatQty), "CHROME HEARTS HATS", "FOR SALE", "", "12"],
      ],
    };
    return {
      tabs,
      cell: (tab: string, row: number, col: number) => tabs[tab][row - 1][col],
      io: {
        tabs: async (names: string[]) => names.map((n) => {
          if (!tabs[n]) throw new Error(`Unable to parse range: ${n}`);
          return tabs[n].map((r) => [...r]);
        }),
        ranges: async () => [],
        write: async (data: { range: string; values: (string | number)[][] }[]) => {
          for (const d of data) {
            // "'TAB'!F5" (one cell) or "'TAB'!A9:J9" (a whole new row)
            const m = d.range.match(/^'(.+)'!([A-Z]+)(\d+)(?::[A-Z]+\d+)?$/)!;
            const r = Number(m[3]) - 1;
            while (tabs[m[1]].length <= r) tabs[m[1]].push([]);
            d.values[0].forEach((v, j) => (tabs[m[1]][r][m[2].charCodeAt(0) - 65 + j] = String(v)));
          }
        },
      },
    };
  }

  async function stockSetup(opts: { crmDown?: boolean; sheetQty?: number } = {}) {
    const { StockKeeper } = await import("../../src/desk.js");
    const { StockSync } = await import("../../src/stocksync.js");
    const sheet = fakeSheet(opts.sheetQty ?? 20);
    const api = createApi({ db: t.asService, botApiKey: KEY });
    const live = crmClient("https://crm.test", KEY, ((i: RequestInfo | URL, init?: RequestInit) => api(new Request(String(i), init))) as typeof fetch);
    const down = crmClient("https://crm.test", KEY, (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    const keeper = new StockKeeper(sheet.io);
    const store = new Store(() => NOW.getTime());
    const alerts: HandoffAlert[] = [];
    const notify = async (a: HandoffAlert) => void alerts.push(a);
    const desk = new OrderDesk({ store, notify, accountName: "Triangle Resells", crm: opts.crmDown ? down : live, stock: keeper });
    const steps: Step[] = [];
    const results: unknown[] = [];
    const agent: ReplyEngine = { reply: async (_h, _i, tools) => { const s = steps.shift(); if (s) results.push(await s(tools!)); return { text: "ok" }; } };
    const ig: InstagramApi = { sendText: async () => "m", sendPrivateReply: async () => "m", replyToComment: async () => {}, getUsername: async () => "TEST_buyer" };
    const bot = new Bot({ ig, agent, store, notify, getInventory: async () => "", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [], humanPauseHours: 12, pricing: loadPricing(), getBusy: async () => [], now: () => NOW, desk, crm: opts.crmDown ? down : live });
    let n = 0;
    const dm = (step: Step) => {
      steps.push(step);
      return bot.handle({ object: "instagram", entry: [{ id: OWN, messaging: [{ sender: { id: `${BUYER}-${++n}` }, recipient: { id: OWN }, message: { mid: `s${n}`, text: "order" } }] }] });
    };
    const stockSync = new StockSync({ crm: live, io: sheet.io, keeper });
    await stockSync.tick(); // first sync: the CRM learns the sheet
    return { dm, sheet, stockSync, alerts, results };
  }
  const SHEET_QTY = (s: ReturnType<typeof fakeSheet>) => Number(s.cell("BOT STOCK", 3, 5));

  it("a DM order reserves in the CRM, the next sync writes the new count on the sheet, and nothing is taken twice", async () => {
    await t.reset(); // start with no stock: the sheet brings it in
    const { dm, sheet, stockSync } = await stockSetup();
    expect(await t.qty("Chrome Hearts Hat", "Black", null, false)).toBe(20);
    await dm((tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    expect(await t.qty("Chrome Hearts Hat", "Black", null, false)).toBe(18);
    expect(SHEET_QTY(sheet)).toBe(20); // not yet: the bot didn't touch the sheet itself
    expect(await stockSync.tick()).toBe(1);
    expect(SHEET_QTY(sheet)).toBe(18);
    await stockSync.tick();
    expect(SHEET_QTY(sheet)).toBe(18);
    expect(await t.qty("Chrome Hearts Hat", "Black", null, false)).toBe(18);
  });

  it("a restock typed on the sheet reaches the CRM", async () => {
    await t.reset();
    const { sheet, stockSync } = await stockSetup();
    sheet.tabs["BOT STOCK"][2][5] = "35";
    await stockSync.tick();
    expect(await t.qty("Chrome Hearts Hat", "Black", null, false)).toBe(35);
  });

  it("the CRM refuses an order for pieces that are gone, and the AI is told so (nothing booked)", async () => {
    await t.reset();
    const { dm, results } = await stockSetup({ sheetQty: 1 });
    await dm((tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    expect(results[0]).toMatchObject({ ok: false, fixable: true, error: "only 1 left of Chrome Hearts Hat Black (asked for 2)" });
    expect(await crmBookings()).toEqual([]);
    expect(await t.qty("Chrome Hearts Hat", "Black", null, false)).toBe(1);
  });

  it("CRM down: the bot takes the stock off the sheet itself (once) and tells Josh", async () => {
    await t.reset();
    const { dm, sheet, alerts, results } = await stockSetup({ crmDown: true });
    await dm((tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    expect(results[0]).toMatchObject({ ok: true });
    expect(SHEET_QTY(sheet)).toBe(18);
    expect(alerts.some((a) => a.reason.includes("NOT saved in the CRM") && a.summary!.includes("taken off BOT STOCK directly"))).toBe(true);
  });

  it("an empty sheet read never wipes the CRM's stock", async () => {
    await t.reset();
    const { sheet, stockSync } = await stockSetup();
    sheet.tabs["BOT STOCK"] = [];
    await stockSync.tick();
    expect(await t.qty("Chrome Hearts Hat", "Black", null, false)).toBe(20);
  });
});

describe("phase 4: tracking, DM counts, repeat buyers (bot <-> CRM)", () => {
  const shipped = (ig: string) => ({
    date: "2026-11-14", payment_method: "cash_app", fulfillment: "ship", shipping_fee: 10, label_cost: 7.5, is_test: true, location: "TEST address",
    customer: { ig_user_id: ig, ig_handle: "TEST_shipper" }, items: [{ item: "Chrome Hearts Hat", color: "Black", size: "One Size", qty: 1, unit_price: 35 }],
  });

  it("TEST 6: a tracking number added in the CRM is saved and DMed to the buyer", async () => {
    const { dm, sync, sent } = setup();
    await sync.tick();
    await dm("hey did my hat ship", async () => null); // the buyer messaged: Instagram lets the bot answer for 24h
    const josh = await t.login("Josh");
    const b = await t.asUser(josh).rpc<{ id: string }>("create_booking", { p: shipped(BUYER) });
    await sync.tick();
    await t.asUser(josh).rpc("update_booking", { p_id: b.id, p: { tracking_number: "1ZTEST0000000001" } });
    await sync.tick();
    expect((await t.asUser(josh).rpc<{ tracking_number: string }>("get_booking", { p_id: b.id })).tracking_number).toBe("1ZTEST0000000001");
    expect(sent.at(-1)).toEqual({ to: BUYER, text: "Your order shipped 📦 UPS tracking: 1ZTEST0000000001\nhttps://www.ups.com/track?tracknum=1ZTEST0000000001" });
  });

  it("tracking for a buyer outside Instagram's 24h window goes to Josh to send by hand", async () => {
    const { sync, sent, alerts } = setup();
    await sync.tick();
    const josh = await t.login("Josh");
    const b = await t.asUser(josh).rpc<{ id: string }>("create_booking", { p: shipped("ig-quiet-buyer") });
    await t.asUser(josh).rpc("update_booking", { p_id: b.id, p: { tracking_number: "1ZTEST0000000002" } });
    await sync.tick();
    expect(sent).toEqual([]);
    expect(alerts.find((a) => a.reason.includes("tracking number by hand"))!.summary).toContain("1ZTEST0000000002");
  });

  it("counts one DM conversation per visit (not per message)", async () => {
    const { dm } = setup();
    await dm("yo", async () => null);
    await dm("u got hats", async () => null);
    const c = await t.asService.rpc<{ dm_conversations: number }>("find_customer", { p_ig_user_id: BUYER });
    expect(c.dm_conversations).toBe(1);
  });

  it("the AI is told when it's talking to a repeat buyer", async () => {
    const { dm, contexts } = setup();
    await dm("hats", (tl) => tl.submitOrder!(hats, "pickup", "2026-11-14", "4:00 PM", undefined, "cash_app"));
    const josh = await t.login("Josh");
    await t.asUser(josh).rpc("set_booking_status", { p_id: await (async () => (await crmBookings())[0].id)(), p_status: "done" });
    await dm("yo its me again", async () => null);
    expect(contexts.at(-1)).toMatch(/REPEAT BUYER: 1 past order, \$\d+/);
  });
});

describe("restock -> BOT STOCK (through the bot's sync)", () => {
  it("receiving a restock in the CRM flips INCOMING to FOR SALE on the sheet, sets the count, and adds rows for new items", async () => {
    const { StockKeeper } = await import("../../src/desk.js");
    const { StockSync } = await import("../../src/stocksync.js");
    await t.reset();
    const tabs: Record<string, string[][]> = {
      "BOT STOCK": [
        ["BOT STOCK - read me"],
        ["Category", "Brand", "Item", "Color", "Size", "Qty", "Price List", "Status", "Notes", "Cost"],
        ["Hoodie", "Essentials", "Essentials Hoodie", "Black", "XS", "0", "ESSENTIALS", "INCOMING", "", "25"],
      ],
    };
    const io = {
      tabs: async (names: string[]) => names.map((n) => { if (!tabs[n]) throw new Error("no tab"); return tabs[n].map((r) => [...r]); }),
      ranges: async () => [],
      write: async (data: { range: string; values: (string | number)[][] }[]) => {
        for (const d of data) {
          const m = d.range.match(/^'(.+)'!([A-Z]+)(\d+)(?::[A-Z]+\d+)?$/)!;
          const r = Number(m[3]) - 1;
          while (tabs[m[1]].length <= r) tabs[m[1]].push([]);
          d.values[0].forEach((v, j) => (tabs[m[1]][r][m[2].charCodeAt(0) - 65 + j] = String(v)));
        }
      },
    };
    const api = createApi({ db: t.asService, botApiKey: KEY });
    const crm = crmClient("https://crm.test", KEY, ((i: RequestInfo | URL, init?: RequestInit) => api(new Request(String(i), init))) as typeof fetch);
    const sync = new StockSync({ crm, io, keeper: new StockKeeper(io) });
    await sync.tick();
    const josh = await t.login("Josh");
    const r = await t.asUser(josh).rpc<{ id: string }>("create_restock", { p: { name: "TEST restock", items: [
      { brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "XS", qty_expected: 20 },
      { category: "Hoodie", brand: "Supreme", item: "Supreme Hoodie", color: "Red", size: "M", qty_expected: 5, unit_cost: 30, price_list: "SUPREME HOODIES" },
    ] } });
    await t.asUser(josh).rpc("receive_restock", { p_id: r.id });
    await sync.tick();
    expect(tabs["BOT STOCK"][2].slice(2, 8)).toEqual(["Essentials Hoodie", "Black", "XS", "20", "ESSENTIALS", "FOR SALE"]);
    expect(tabs["BOT STOCK"][3]).toEqual(["Hoodie", "Supreme", "Supreme Hoodie", "Red", "M", "5", "SUPREME HOODIES", "FOR SALE", "Added from a restock in the CRM", "30"]);
    await sync.tick(); // settles: nothing more to write, nothing double-counted
    expect(await t.qty("Supreme Hoodie", "Red", "M", false)).toBe(5);
    expect(await t.qty("Essentials Hoodie", "Black", "XS", false)).toBe(20);
    expect(tabs["BOT STOCK"]).toHaveLength(4);
  });
});
