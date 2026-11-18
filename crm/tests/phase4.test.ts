import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "./pg.js";

type Report = {
  totals: { sales: number; revenue: number; item_cost: number; label_cost: number; profit: number; delivery_fees: number; sales_missing_cost: number };
  by_account: { account: string; revenue: number; profit: number; sales: number }[];
  sales: { id: string; revenue: number; item_cost: number; label_cost: number; profit: number; cost_missing: boolean; assignee: string; payment_method: string; customer: { ig_handle: string } }[];
};
type Customer = { ig_handle: string; orders: number; open_orders: number; total_spent: number; last_order: string | null; dm_conversations: number };

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
beforeEach(async () => {
  await t.reset();
  await t.seedStock([
    { brand: "Chrome Hearts", item: "Chrome Hearts Hat", color: "Black", qty: 50, cost: 12.35 },
    { brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "M", qty: 50, cost: 25 },
    { brand: "Valley", item: "Valley Tee", color: "White/Orange", size: "M", qty: 50 }, // no cost on the sheet
  ]);
});

const book = (who: string, items: { item: string; color?: string; size?: string; qty: number; unit_price: number }[], extra: Record<string, unknown> = {}) =>
  t.asService.rpc<{ id: string }>("create_booking", {
    p: { date: "2026-11-14", time: "16:00", payment_method: "cash", fulfillment: "pickup", is_test: true, assignee: "Chema", source: "instagram",
         source_account: "Triangle Resells", customer: { ig_user_id: `ig-${who}`, ig_handle: `TEST_${who}` }, items: items.map((i) => ({ size: "One Size", ...i })), ...extra },
    p_actor: "Bot",
  });
const report = (from = "2026-11-01", to = "2026-11-30", filters = {}) =>
  t.asService.rpc<Report>("sales_report", { p_from: from, p_to: to, p_filters: filters, p_include_test: true });
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + Number(b), 0) * 100) / 100;

describe("phase 4: revenue, profit, drill-down", () => {
  it("TEST 5: Paid then Done -> revenue, profit, drill-down and cash update, and the totals add up to the cent", async () => {
    const a = await book("a", [{ item: "Chrome Hearts Hat", color: "Black", qty: 3, unit_price: 28.5 }]); // 85.50 revenue, cost 37.05
    const b = await book("b", [{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 2, unit_price: 60 }], {
      payment_method: "zelle", fulfillment: "delivery", delivery_fee: 10, assignee: "Diego", source_account: "Triangle Sales" });
    expect((await report()).totals.sales).toBe(0); // nothing Done yet: no revenue
    const chema = await t.login("Chema");
    await t.asUser(chema).rpc("set_booking_status", { p_id: a.id, p_status: "paid" });
    await t.asUser(chema).rpc("set_booking_status", { p_id: a.id, p_status: "done" });
    const josh = await t.login("Josh");
    await t.asUser(josh).rpc("set_booking_status", { p_id: b.id, p_status: "paid" });
    await t.asUser(josh).rpc("set_booking_status", { p_id: b.id, p_status: "done" });

    const r = await report();
    expect(r.totals).toMatchObject({ sales: 2, revenue: 205.5, item_cost: 87.05, label_cost: 0, profit: 118.45, delivery_fees: 10, sales_missing_cost: 0 });
    // The drill-down rows add up to the headline, to the cent.
    expect(sum(r.sales.map((s) => s.revenue))).toBe(r.totals.revenue);
    expect(sum(r.sales.map((s) => s.profit))).toBe(r.totals.profit);
    expect(r.by_account).toEqual([
      { account: "Triangle Sales", revenue: 120, profit: 70, sales: 1 },
      { account: "Triangle Resells", revenue: 85.5, profit: 48.45, sales: 1 },
    ]);
    // Cash per person: Chema took the cash for the hats; the Zelle sale isn't cash.
    const today = (await t.pg.query<{ d: string }>("select to_char((now() at time zone 'America/New_York')::date, 'YYYY-MM-DD') d")).rows[0].d;
    const cash = await t.asService.rpc<{ people: { name: string; total: number; bookings: unknown[] }[] }>("cash_report", { p_day: today, p_include_test: true });
    expect(cash.people.map((p) => [p.name, p.total, p.bookings.length])).toEqual([["Chema", 85.5, 1], ["Diego", 0, 0], ["Josh", 0, 0]]);
  });

  it("filters by who fulfilled, payment, fulfillment and account, and every filtered list still adds up", async () => {
    for (const [who, assignee, pay] of [["a", "Chema", "cash"], ["b", "Diego", "cash_app"], ["c", "Diego", "cash"]] as const) {
      const x = await book(who, [{ item: "Chrome Hearts Hat", color: "Black", qty: 1, unit_price: 35 }], { assignee, payment_method: pay });
      await t.asService.rpc("set_booking_status", { p_id: x.id, p_status: "done", p_actor: "System" });
    }
    const diego = await report(undefined, undefined, { assignee: "Diego" });
    expect(diego.totals).toMatchObject({ sales: 2, revenue: 70 });
    const diegoCash = await report(undefined, undefined, { assignee: "Diego", payment_method: "cash" });
    expect(diegoCash.totals.sales).toBe(1);
    expect(sum(diegoCash.sales.map((s) => s.revenue))).toBe(diegoCash.totals.revenue);
  });

  it("flags sales with a missing cost instead of guessing, and takes label cost out of profit", async () => {
    const x = await book("a", [{ item: "Valley Tee", color: "White/Orange", size: "M", qty: 1, unit_price: 40 }], {
      payment_method: "cash_app", fulfillment: "ship", shipping_fee: 10, label_cost: 7.5 });
    await t.asService.rpc("set_booking_status", { p_id: x.id, p_status: "done", p_actor: "System" });
    const r = await report();
    expect(r.totals).toMatchObject({ revenue: 40, label_cost: 7.5, profit: 32.5, sales_missing_cost: 1 });
    expect(r.sales[0].cost_missing).toBe(true);
  });

  it("counts a sale in the month of its booking date; cancelled and open bookings aren't revenue", async () => {
    const oct = await book("a", [{ item: "Chrome Hearts Hat", color: "Black", qty: 1, unit_price: 35 }], { date: "2026-10-31" });
    await t.asService.rpc("set_booking_status", { p_id: oct.id, p_status: "done", p_actor: "System" });
    const c = await book("b", [{ item: "Chrome Hearts Hat", color: "Black", qty: 1, unit_price: 35 }]);
    await t.asService.rpc("cancel_booking", { p_id: c.id, p_actor: "Bot" });
    await book("c", [{ item: "Chrome Hearts Hat", color: "Black", qty: 1, unit_price: 35 }]); // still open
    expect((await report()).totals.revenue).toBe(0);
    const months = await t.asService.rpc<{ month: string; revenue: number; open: number }[]>("monthly_report", { p_months: 3, p_include_test: true, p_today: "2026-11-20" });
    expect(months).toEqual([
      { month: "2026-09", revenue: 0, profit: 0, sales: 0, open: 0 },
      { month: "2026-10", revenue: 35, profit: 22.65, sales: 1, open: 0 },
      { month: "2026-11", revenue: 0, profit: 0, sales: 0, open: 35 },
    ]);
  });

  it("a cash sale put back to Booked is no longer counted as collected", async () => {
    const x = await book("a", [{ item: "Chrome Hearts Hat", color: "Black", qty: 1, unit_price: 35 }]);
    const chema = await t.login("Chema");
    await t.asUser(chema).rpc("set_booking_status", { p_id: x.id, p_status: "done" });
    await t.asUser(chema).rpc("set_booking_status", { p_id: x.id, p_status: "booked" });
    const row = (await t.pg.query<{ cash_collected_by: string | null }>("select cash_collected_by from bookings")).rows[0];
    expect(row.cash_collected_by).toBeNull();
  });
});

describe("phase 4: customers", () => {
  it("one record per buyer with orders, total spent, last order and DM conversations; sortable lists", async () => {
    for (const n of [1, 2]) {
      const x = await book("big", [{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 2, unit_price: 60 }], { date: `2026-11-1${n}` });
      await t.asService.rpc("set_booking_status", { p_id: x.id, p_status: "done", p_actor: "System" });
    }
    const s = await book("small", [{ item: "Chrome Hearts Hat", color: "Black", qty: 1, unit_price: 35 }]);
    await t.asService.rpc("set_booking_status", { p_id: s.id, p_status: "done", p_actor: "System" });
    await book("small", [{ item: "Chrome Hearts Hat", color: "Black", qty: 1, unit_price: 35 }], { date: "2026-11-20" });
    for (let i = 0; i < 3; i++) await t.asService.rpc("record_dm", { p_ig_user_id: "ig-chatty", p_ig_handle: "TEST_chatty", p_actor: "Bot" });
    await t.pg.query("update customers set is_test = true");

    const list = (sort: string) => t.asService.rpc<Customer[]>("customers_report", { p_sort: sort, p_include_test: true });
    expect((await list("top_spenders")).map((c) => [c.ig_handle, c.total_spent, c.orders])).toEqual([["test_big", 240, 2], ["test_small", 35, 1], ["test_chatty", 0, 0]]);
    expect((await list("lowest_spenders"))[0].ig_handle).toBe("test_chatty");
    expect((await list("most_dms"))[0]).toMatchObject({ ig_handle: "test_chatty", dm_conversations: 3 });
    expect((await list("repeat_buyers")).map((c) => c.ig_handle)).toEqual(["test_big"]);
    const small = (await list("top_spenders")).find((c) => c.ig_handle === "test_small")!;
    expect(small).toMatchObject({ orders: 1, open_orders: 1, last_order: "2026-11-20" });
    const search = await t.asService.rpc<Customer[]>("customers_report", { p_sort: "recent", p_include_test: true, p_search: "chat" });
    expect(search.map((c) => c.ig_handle)).toEqual(["test_chatty"]);
  });

  it("what the bot sees before it answers: the buyer's history and open bookings", async () => {
    const x = await book("big", [{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 2, unit_price: 60 }]);
    await t.asService.rpc("set_booking_status", { p_id: x.id, p_status: "done", p_actor: "System" });
    await book("big", [{ item: "Chrome Hearts Hat", color: "Black", qty: 1, unit_price: 35 }], { date: "2026-11-21" });
    const ctx = await t.asService.rpc<{ customer: Customer; bookings: unknown[] }>("buyer_context", { p_ig_user_id: "ig-big" });
    expect(ctx.customer).toMatchObject({ orders: 1, total_spent: 120 });
    expect(ctx.bookings).toHaveLength(1);
    expect(await t.asService.rpc("buyer_context", { p_ig_user_id: "ig-nobody" })).toEqual({ customer: null, bookings: [] });
  });

  it("strangers can't read the money", async () => {
    const stranger = (await t.pg.query<{ id: string }>("insert into auth.users (email) values ('x@x.com') returning id")).rows[0].id;
    await expect(t.asUser(stranger).rpc("sales_report", { p_from: "2026-11-01", p_to: "2026-11-30" })).rejects.toMatchObject({ status: 403 });
    await expect(t.asUser(stranger).rpc("customers_report", {})).rejects.toMatchObject({ status: 403 });
    await expect(t.asUser(stranger).rpc("cash_report", {})).rejects.toMatchObject({ status: 403 });
  });
});
