/**
 * End to end: the REAL DM bot code (src/bot.ts + src/desk.ts) talks to the REAL CRM API (crm/src/api) on a local
 * Postgres. Only the AI and Instagram are simulated: the "AI" calls the same tools Claude would.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OrderTools, ReplyEngine } from "../../src/ai.js";
import { Bot, type WebhookPayload } from "../../src/bot.js";
import { loadPricing } from "../../src/config.js";
import { crmClient } from "../../src/crm.js";
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
  const agent: ReplyEngine = {
    reply: async (_h, _i, tools) => {
      const step = steps.shift();
      if (step) results.push(await step(tools!));
      return { text: "ok" };
    },
  };
  const ig: InstagramApi = { sendText: async () => "m", sendPrivateReply: async () => "m", replyToComment: async () => {}, getUsername: async () => "TEST_buyer" };
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
  return { dm, store, alerts, results, cal };
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
