import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "./pg.js";

type Note = { id: number; kind: string; text: string; actor: string; is_test: boolean };
type Day = { day: string; goals: Record<string, number>; ideas: { id: string; account: string; hook: string; status: string; posted_to: string[]; post_link: string | null; views: number | null; auto: boolean; meetup: boolean }[] };

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
beforeEach(async () => {
  await t.reset();
  await t.seedStock([
    { brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "M", qty: 3, cost: 25 },
    { brand: "Chrome Hearts", item: "Chrome Hearts Hat", color: "Black", qty: 1, cost: 12 },
  ]);
});

const notes = async () => (await t.asService.rpc<{ notifications: Note[] }>("notifications_after", { p_after: 0 })).notifications;
const booking = (extra: Record<string, unknown> = {}) => ({
  date: "2026-11-14", time: "16:00", payment_method: "cash", fulfillment: "pickup", assignee: "Diego", is_test: true,
  customer: { ig_handle: "TEST_buyer" }, items: [{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 2, unit_price: 60 }], ...extra,
});

describe("phase 5: team notifications", () => {
  it("a team member's booking, reschedule, cancel and no-show each post one plain-words notification", async () => {
    const chema = await t.login("Chema");
    const b = await t.asUser(chema).rpc<{ id: string }>("create_booking", { p: booking() });
    await t.asUser(chema).rpc("reschedule_booking", { p_id: b.id, p_date: "2026-11-15", p_time: "11:00" });
    await t.asUser(chema).rpc("cancel_booking", { p_id: b.id, p_reason: "buyer sick" });
    const c = await t.asUser(chema).rpc<{ id: string }>("create_booking", { p: booking({ customer: { ig_handle: "TEST_ghost" }, items: [{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 1, unit_price: 60 }] }) });
    await t.asUser(chema).rpc("set_booking_status", { p_id: c.id, p_status: "no_show" });
    expect((await notes()).map((n) => n.text)).toEqual([
      "[TEST] 📅 Chema booked a sale for Sat Nov 14 4:00 PM: @test_buyer, 2x Essentials Hoodie Black M, pickup, $120.00. Fulfilling: Diego.",
      "[TEST] 🔁 Chema rescheduled @test_buyer, 2x Essentials Hoodie Black M, pickup, $120.00 to Sun Nov 15 11:00 AM (was Sat Nov 14 4:00 PM).",
      "[TEST] ❌ Chema cancelled @test_buyer, 2x Essentials Hoodie Black M, pickup, $120.00 on Sun Nov 15 11:00 AM (buyer sick).",
      "[TEST] 📅 Chema booked a sale for Sat Nov 14 4:00 PM: @test_ghost, 1x Essentials Hoodie Black M, pickup, $60.00. Fulfilling: Diego.",
      "[TEST] 🚫 No-show (marked by Chema): @test_ghost, 1x Essentials Hoodie Black M, pickup, $60.00 on Sat Nov 14 4:00 PM.",
    ]);
  });

  it("the bot's own bookings don't post here (the bot already alerts for them)", async () => {
    await t.asService.rpc("create_booking", { p: booking(), p_actor: "Bot" });
    expect(await notes()).toEqual([]);
  });

  it("an item selling out posts an out-of-stock notification", async () => {
    await t.asService.rpc("create_booking", { p: booking({ items: [{ item: "Chrome Hearts Hat", color: "Black", size: "One Size", qty: 1, unit_price: 35 }] }), p_actor: "Bot" });
    expect((await notes()).map((n) => [n.kind, n.text])).toEqual([["out_of_stock", "[TEST] ⚠️ Out of stock: Chrome Hearts Hat Black. The bot won't sell it until it's restocked."]]);
  });

  it("the bot reads them in order and starts from now on its first read", async () => {
    const chema = await t.login("Chema");
    await t.asUser(chema).rpc("create_booking", { p: booking() });
    expect(await t.asService.rpc("notifications_after", { p_after: null })).toEqual({ notifications: [], latest: 1 });
    await t.asUser(chema).rpc("create_booking", { p: booking({ customer: { ig_handle: "TEST_two" }, items: [{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 1, unit_price: 60 }] }) });
    const r = await t.asService.rpc<{ notifications: Note[]; latest: number }>("notifications_after", { p_after: 1 });
    // The second booking took the last hoodie, so it also sold out.
    expect(r.notifications.map((n) => [n.id, n.kind])).toEqual([[2, "booked"], [3, "out_of_stock"]]);
    await expect(t.asUser(chema).rpc("notifications_after", { p_after: 0 })).rejects.toThrow();
  });
});

describe("phase 5: video ideas", () => {
  it("daily ideas per account with goals; status, posted-to, link and views; auto ideas notify the team", async () => {
    const day = await t.asService.rpc<Day>("add_video_ideas", { p_day: "2026-11-13", p_ideas: [
      { account: "resells", hook: "How I turned $200 into $2,000 in 2 weeks" },
      { account: "sales", hook: "Meetup run: 6 orders in one night", meetup: true },
    ], p_auto: true, p_actor: "Bot", p_is_test: true });
    expect(day.goals).toEqual({ resells: 3, scales: 2, sales: 6 });
    expect(day.ideas.map((i) => [i.account, i.auto, i.meetup])).toEqual([["resells", true, false], ["sales", true, true]]);
    expect((await notes()).map((n) => n.text)).toEqual(["[TEST] 🎬 2 new video ideas for Fri Nov 13 are in the CRM."]);
    const diego = await t.login("Diego");
    const id = day.ideas[0].id;
    await t.asUser(diego).rpc("update_video_idea", { p_id: id, p: { status: "posted", posted_to: ["resells", "sales"], post_link: "https://instagram.com/reel/TEST", views: 1200 } });
    const after = await t.asUser(diego).rpc<Day>("videos_for_day", { p_day: "2026-11-13", p_is_test: true });
    expect(after.ideas[0]).toMatchObject({ status: "posted", posted_to: ["resells", "sales"], post_link: "https://instagram.com/reel/TEST", views: 1200 });
    expect(await t.asUser(diego).rpc("videos_between", { p_from: "2026-11-01", p_to: "2026-11-30", p_is_test: true })).toEqual({ "2026-11-13": { ideas: 2, posted: 1 } });
    await expect(t.asUser(diego).rpc("update_video_idea", { p_id: id, p: { posted_to: ["tiktok"] } })).rejects.toMatchObject({ status: 400 });
  });

  it("removing an idea is logged and can be undone; strangers can't see ideas", async () => {
    const josh = await t.login("Josh");
    const day = await t.asUser(josh).rpc<Day>("add_video_ideas", { p_day: "2026-11-13", p_ideas: [{ account: "scales", hook: "3 vendors I'd never use again" }], p_is_test: true });
    await t.asUser(josh).rpc("delete_video_idea", { p_id: day.ideas[0].id });
    const del = (await t.pg.query<{ id: number }>("select id from activity_log where entity = 'video_ideas' and action = 'delete'")).rows[0];
    await t.asUser(josh).rpc("undo_activity", { p_id: del.id });
    expect((await t.asUser(josh).rpc<Day>("videos_for_day", { p_day: "2026-11-13", p_is_test: true })).ideas).toHaveLength(1);
    const stranger = (await t.pg.query<{ id: string }>("insert into auth.users (email) values ('x@x.com') returning id")).rows[0].id;
    await expect(t.asUser(stranger).rpc("videos_for_day", { p_day: "2026-11-13" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("phase 5: old sales import", () => {
  const rows = [
    { key: "Nov 2026!A6", date: "2026-11-03", channel: "Instagram", handle: "@old_buyer", products: "2x Alo Hoodie Gray M", cost: "50", total: "110",
      platform_fee: "3.50", label_cost: "8", payment: "Cash App", fulfillment: "ship", tracking: "1ZOLD", items: [{ item: "Alo Hoodie", color: "Gray", size: "M", qty: 2 }] },
    { key: "Nov 2026!AD6", date: "2026-11-05", channel: "Meetup", closer: "Chema", buyer_name: "Marcus", products: "Bleu de Chanel", cost: "30", total: "60", payment: "cash", fulfillment: "pickup" },
    { key: "Nov 2026!AD7", date: "", total: "40", products: "no date" },
  ];

  it("preview first: counts what it would import and writes nothing", async () => {
    const r = await t.asService.rpc("import_sales", { p_rows: rows, p_commit: false });
    expect(r).toEqual({ committed: false, would_import: 2, already_imported: 0, problems: [{ key: "Nov 2026!AD7", problem: "no date or no total" }] });
    expect((await t.pg.query("select * from bookings")).rows).toHaveLength(0);
    expect((await t.pg.query("select * from customers")).rows).toHaveLength(0);
  });

  it("commit: Done sales in revenue and profit (fee and label taken off), no stock touched, no cash, no notifications; never twice", async () => {
    const r = await t.asService.rpc("import_sales", { p_rows: rows, p_commit: true });
    expect(r).toMatchObject({ committed: true, imported: 2, already_imported: 0 });
    const rep = await t.asService.rpc<{ totals: { sales: number; revenue: number; profit: number }; sales: { imported: boolean; profit: number }[] }>("sales_report", { p_from: "2026-11-01", p_to: "2026-11-30" });
    expect(rep.totals).toMatchObject({ sales: 2, revenue: 170, profit: 78.5 }); // (110-50-3.50-8) + (60-30)
    expect(rep.sales.every((s) => s.imported)).toBe(true);
    expect(await t.qty("Essentials Hoodie", "Black", "M")).toBe(3);
    expect((await t.pg.query("select * from stock_moves")).rows).toHaveLength(0);
    expect((await t.pg.query("select * from bookings where cash_collected_by is not null")).rows).toHaveLength(0);
    expect(await notes()).toEqual([]);
    const b = (await t.pg.query<{ assignee: string; source: string; tracking_number: string }>("select assignee, source, tracking_number from bookings order by date")).rows;
    expect(b).toEqual([{ assignee: null, source: "instagram", tracking_number: "1ZOLD" }, { assignee: "Chema", source: "in_person", tracking_number: null }]);
    expect(await t.asService.rpc("import_sales", { p_rows: rows, p_commit: true })).toMatchObject({ imported: 0, already_imported: 2 });
    // The buyers are customers now, with their spend.
    const top = await t.asService.rpc<{ ig_handle: string | null; name: string | null; total_spent: number }[]>("customers_report", { p_sort: "top_spenders" });
    expect(top.map((c) => [c.ig_handle ?? c.name, c.total_spent])).toEqual([["old_buyer", 110], ["Marcus", 60]]);
  });
});
