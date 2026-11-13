/**
 * The brief's 8 end-to-end tests, run against a REAL CRM through the REAL bot code, with TEST data only:
 * the buyers are "e2e-test-..." (never a real Instagram id), every booking is is_test, and only TEST stock (the
 * "BOT STOCK TEST" copy) is touched. Instagram and the AI are simulated; the CRM, its database and its rules are real.
 * At the end every TEST row is deleted. Used by scripts/e2e-live.ts (live) and crm/tests (local database).
 */
import type { OrderTools, ReplyEngine } from "../../src/ai.js";
import { Bot } from "../../src/bot.js";
import type { Crm } from "../../src/crm.js";
import { crmClient } from "../../src/crm.js";
import { CrmSync } from "../../src/crmsync.js";
import { OrderDesk, stockKey } from "../../src/desk.js";
import type { HandoffAlert } from "../../src/handoff.js";
import type { InstagramApi } from "../../src/instagram.js";
import type { PricingConfig } from "../../src/pricing.js";
import { Store } from "../../src/store.js";
import type { UserDb } from "../../src/team/assistant.js";

export interface E2EDeps {
  /** The bot's CRM client (bot key). */
  crm: Crm;
  /** Raw CRM API calls with the bot key, for checks. */
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  /** A logged-in team member (their login), for the team's side. */
  team: UserDb;
  teamName: string;
  /** The bot's prices (to quote); the item used must be FOR SALE here AND in TEST stock with 3+ pieces. */
  pricing: PricingConfig;
  now: Date;
}

export interface E2EResult {
  n: string;
  name: string;
  pass: boolean;
  detail: string;
}

const iso = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);

export async function runE2E(d: E2EDeps): Promise<{ results: E2EResult[]; cleanup: unknown }> {
  const results: E2EResult[] = [];
  const check = async (n: string, name: string, fn: () => Promise<string>) => {
    try {
      results.push({ n, name, pass: true, detail: await fn() });
    } catch (err) {
      results.push({ n, name, pass: false, detail: (err as Error).message ?? String(err) });
    }
  };
  const must = (ok: unknown, why: string) => {
    if (!ok) throw new Error(why);
  };
  const day = iso(addDays(d.now, 3));
  const day2 = iso(addDays(d.now, 4));
  const stamp = d.now.getTime().toString(36);
  const testStock = async () => (await d.api("GET", "/stock?is_test=true")).stock as { item: string; color: string | null; size: string | null; qty: number; status: string }[];
  const qtyOf = async (it: { item: string; color: string | null; size: string | null }) =>
    (await testStock()).find((s) => s.item === it.item && s.color === it.color && s.size === it.size)?.qty ?? -1;
  const bookingsOn = async (from: string, to = from) => (await d.api("GET", `/bookings?from=${from}&to=${to}&include_test=true`)).bookings as any[];

  // An item that's sellable for the bot AND has 3+ pieces in TEST stock.
  const stock = await testStock();
  const it = stock.find((s) => s.status === "for_sale" && s.qty >= 3 &&
    (d.pricing.stock ?? []).some((r) => r.status === "for_sale" && r.qty > 0 && stockKey(r.item, r.color, r.size) === stockKey(s.item, s.color, s.size)));
  if (!it) {
    return { results: [{ n: "setup", name: "a test item", pass: false, detail: "No item is FOR SALE in BOT STOCK with 3+ pieces in BOT STOCK TEST. Duplicate BOT STOCK as BOT STOCK TEST and let the bot sync it." }], cleanup: null };
  }
  const line = { product: it.item, variant: it.color ?? undefined, size: it.size ?? undefined, qty: 1 };

  // The real bot, with simulated Instagram and AI (the AI calls the same tools Claude would).
  const alerts: HandoffAlert[] = [];
  const sent: { to: string; text: string }[] = [];
  const steps: ((t: OrderTools) => Promise<unknown>)[] = [];
  const out: unknown[] = [];
  const agent: ReplyEngine = { reply: async (_h, _i, tools) => { const s = steps.shift(); if (s) out.push(await s(tools!)); return { text: "ok" }; } };
  const ig: InstagramApi = { sendText: async (to, text) => (sent.push({ to, text }), "m"), sendPrivateReply: async () => "m", replyToComment: async () => {}, getUsername: async () => "TEST_e2e" };
  const makeBot = (crm: Crm) => {
    const store = new Store(() => d.now.getTime());
    const notify = async (a: HandoffAlert) => void alerts.push(a);
    const desk = new OrderDesk({ store, notify, accountName: "Triangle Resells", crm, crmAssignee: "Chema" });
    const bot = new Bot({ ig, agent, store, notify, getInventory: async () => "", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [],
      humanPauseHours: 12, pricing: d.pricing, getBusy: async () => [], now: () => d.now, desk, crm });
    return { bot, store, desk };
  };
  const { bot, store, desk } = makeBot(d.crm);
  let mid = 0;
  const dm = async (buyer: string, step: (t: OrderTools) => Promise<unknown>) => {
    steps.push(step);
    await bot.handle({ object: "instagram", entry: [{ id: "own", messaging: [{ sender: { id: buyer }, recipient: { id: "own" }, message: { mid: `e2e-${stamp}-${++mid}`, text: "TEST order" } }] }] });
    return out.at(-1);
  };
  const buyer = `e2e-test-${stamp}-1`;
  let botBooking: any;

  await check("1", "Bot books a pickup from a DM", async () => {
    const before = await qtyOf(it);
    const r: any = await dm(buyer, (t) => t.submitOrder!([line], "pickup", day, "4:00 PM", undefined, "cash_app"));
    must(r?.ok, `submit_order failed: ${r?.error}`);
    botBooking = (await bookingsOn(day)).find((b) => b.customer?.ig_user_id === buyer);
    must(botBooking, "the booking isn't in the CRM calendar");
    for (const f of ["date", "time", "payment_method", "fulfillment", "location", "assignee", "source_account", "sale_price"]) must(botBooking[f] != null, `field ${f} is empty`);
    must(botBooking.created_by === "Bot" && botBooking.is_test, "not logged as Bot / not TEST");
    must(botBooking.customer?.id, "no customer record");
    must((await qtyOf(it)) === before - 1, "TEST stock wasn't reserved");
    must(alerts.some((a) => a.reason.includes("BOOKED")), "no booking notification");
    return `${botBooking.date} ${botBooking.time}, ${it.item}, $${botBooking.sale_price}, customer made, TEST stock ${before} -> ${before - 1}, notification sent`;
  });

  await check("2", "Bot reschedules it", async () => {
    must(botBooking, "test 1 didn't book");
    const r: any = await dm(buyer, (t) => t.rescheduleOrder!(day2, "5:00 PM"));
    must(String(r).startsWith("Moved"), `reschedule failed: ${r}`);
    const moved = (await bookingsOn(day2)).find((b) => b.id === botBooking.id);
    must(moved?.time?.startsWith("17:00"), "not moved on the calendar");
    const log = (await d.api("GET", `/activity?entity=bookings&entity_id=${botBooking.id}`)).activity as { summary: string | null }[];
    must(log.some((l) => l.summary?.startsWith("Bot rescheduled")), 'no "Bot rescheduled" in the log');
    return `moved to ${day2} 5:00 PM, log says "Bot rescheduled"`;
  });

  await check("3", "Bot cancels it", async () => {
    must(botBooking, "test 1 didn't book");
    const before = await qtyOf(it);
    const r: any = await dm(buyer, (t) => t.cancelOrder!("TEST cancel"));
    must(String(r).startsWith("Cancelled"), `cancel failed: ${r}`);
    const b = (await bookingsOn(day2)).find((x) => x.id === botBooking.id);
    must(b?.status === "cancelled", "not Cancelled (bright red)");
    must((await qtyOf(it)) === before + 1, "TEST stock didn't come back");
    return `Cancelled, TEST stock ${before} -> ${before + 1}`;
  });

  let teamBooking: any;
  await check("4", "Team adds an in-person sale by hand", async () => {
    const { latest } = await d.api("GET", "/notifications");
    const before = await qtyOf(it);
    teamBooking = await d.team.rpc("create_booking", { p: { date: day, time: "15:00", payment_method: "cash", fulfillment: "pickup", source: "in_person", assignee: d.teamName,
      is_test: true, customer: { name: `TEST walk-in ${stamp}` }, items: [{ item: it.item, color: it.color, size: it.size ?? "One Size", qty: 1, unit_price: 50 }] } });
    must(teamBooking?.created_by === d.teamName, "not logged as the team member");
    must(teamBooking.customer?.id, "no customer record");
    must((await qtyOf(it)) === before - 1, "TEST stock wasn't reserved");
    const n = (await d.api("GET", `/notifications?after=${latest}`)).notifications as { text: string }[];
    must(n.some((x) => x.text.includes(`${d.teamName} booked a sale`)), "no team notification");
    return `logged as ${d.teamName}, customer made, TEST stock reserved, notification: "${n[0]?.text.slice(0, 70)}..."`;
  });

  await check("5", "Paid then Done: revenue, profit, drill-down, cash", async () => {
    must(teamBooking, "test 4 didn't book");
    await d.team.rpc("set_booking_status", { p_id: teamBooking.id, p_status: "paid" });
    await d.team.rpc("set_booking_status", { p_id: teamBooking.id, p_status: "done" });
    const rep: any = await d.team.rpc("sales_report", { p_from: day, p_to: day, p_filters: {}, p_include_test: true });
    must(rep.sales.some((s: any) => s.id === teamBooking.id), "not in the drill-down");
    const sum = (k: string) => Math.round(rep.sales.reduce((t: number, s: any) => t + Number(s[k]), 0) * 100) / 100;
    must(sum("revenue") === Number(rep.totals.revenue) && sum("profit") === Number(rep.totals.profit), "drill-down doesn't add up to the totals");
    const cash: any = await d.team.rpc("cash_report", { p_day: iso(new Date()), p_include_test: true });
    must(cash.people.find((p: any) => p.name === d.teamName)?.bookings.some((b: any) => b.id === teamBooking.id), "not in cash per person");
    return `revenue $${rep.totals.revenue}, profit $${rep.totals.profit} (adds up to the cent), cash collected by ${d.teamName}`;
  });

  await check("6", "Shipped order: tracking saved and sent to the buyer", async () => {
    const shipBuyer = `e2e-test-${stamp}-2`;
    await dm(shipBuyer, async () => null); // the buyer messaged (Instagram lets the bot answer for 24h)
    const sync = new CrmSync({ crm: d.crm, store, desk, includeTest: true, tellBuyer: (u, t) => bot.messageBuyer(u, t) });
    await sync.tick();
    const s: any = await d.team.rpc("create_booking", { p: { date: day, payment_method: "cash_app", fulfillment: "ship", shipping_fee: 10, location: "TEST address", is_test: true,
      customer: { ig_user_id: shipBuyer, ig_handle: `TEST_ship_${stamp}` }, items: [{ item: it.item, color: it.color, size: it.size ?? "One Size", qty: 1, unit_price: 50 }] } });
    await d.team.rpc("update_booking", { p_id: s.id, p: { tracking_number: `1ZTEST${stamp}`.toUpperCase() } });
    await sync.tick();
    await sync.tick();
    const saved: any = await d.team.rpc("get_booking", { p_id: s.id });
    must(saved.tracking_number, "tracking not saved");
    must(sent.some((m) => m.to === shipBuyer && m.text.includes(saved.tracking_number)), "tracking not sent to the buyer");
    return `tracking ${saved.tracking_number} saved and DMed`;
  });

  await check("7", "Two bookings for the last unit", async () => {
    const left = await qtyOf(it);
    must(left > 0, "no TEST stock left to test with");
    const first: any = await d.team.rpc("create_booking", { p: { date: day, payment_method: "cash", fulfillment: "pickup", is_test: true, customer: { name: `TEST last ${stamp}` },
      items: [{ item: it.item, color: it.color, size: it.size ?? "One Size", qty: left, unit_price: 50 }] } });
    let refused = "";
    try {
      await d.team.rpc("create_booking", { p: { date: day, payment_method: "cash", fulfillment: "pickup", is_test: true, customer: { name: `TEST second ${stamp}` },
        items: [{ item: it.item, color: it.color, size: it.size ?? "One Size", qty: 1, unit_price: 50 }] } });
    } catch (err) {
      refused = (err as Error).message;
    }
    must(refused, "the second booking wasn't refused");
    must((await qtyOf(it)) === 0, "stock isn't 0");
    await d.team.rpc("cancel_booking", { p_id: first.id, p_reason: "TEST" });
    return `second refused ("${refused}"), stock stayed at 0, never negative`;
  });

  await check("8", "Bad data / CRM down: nothing half-saved, logged, team alerted", async () => {
    const before = (await bookingsOn(day)).length;
    let error = "";
    try {
      await d.team.rpc("create_booking", { p: { date: day, payment_method: "cash", fulfillment: "pickup", is_test: true, customer: { name: "TEST bad" }, items: [{ item: it.item, qty: 1, unit_price: 50 }] } });
    } catch (err) {
      error = (err as Error).message;
    }
    must(/size/.test(error), `missing size wasn't refused clearly (${error})`);
    let unknown = "";
    try {
      await d.team.rpc("create_booking", { p: { date: day, payment_method: "cash", fulfillment: "pickup", is_test: true, customer: { name: "TEST bad" }, items: [{ item: "TEST No Such Item", size: "M", qty: 1, unit_price: 50 }] } });
    } catch (err) {
      unknown = (err as Error).message;
    }
    must(/isn't a FOR SALE item/.test(unknown), `unknown item wasn't refused clearly (${unknown})`);
    must((await bookingsOn(day)).length === before, "something was half-saved");
    // CRM unreachable: the bot still books for the buyer and alerts the team.
    const down = makeBot(crmClient("http://127.0.0.1:9", "x", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, 2000));
    const was = alerts.length;
    steps.push((t) => t.submitOrder!([line], "pickup", day, "6:00 PM", undefined, "cash_app"));
    await down.bot.handle({ object: "instagram", entry: [{ id: "own", messaging: [{ sender: { id: `e2e-test-${stamp}-3` }, recipient: { id: "own" }, message: { mid: `e2e-${stamp}-down`, text: "TEST" } }] }] });
    must((out.at(-1) as any)?.ok, "the order failed for the buyer when the CRM was down");
    must(alerts.slice(was).some((a) => a.reason.includes("NOT saved in the CRM")), "the team wasn't alerted");
    return `missing size: "${error}"; unknown item: "${unknown}"; nothing saved; CRM down -> order kept, team alerted`;
  });

  const cleanup = await d.api("POST", "/test-data/delete");
  return { results, cleanup };
}

export function reportText(r: { results: E2EResult[]; cleanup: unknown }): string {
  const passed = r.results.filter((x) => x.pass).length;
  return [
    `End-to-end tests: ${passed}/${r.results.length} passed`,
    ...r.results.map((x) => `${x.pass ? "PASS" : "FAIL"}  ${x.n}. ${x.name}: ${x.detail}`),
    `TEST data deleted: ${JSON.stringify(r.cleanup)}`,
  ].join("\n");
}
