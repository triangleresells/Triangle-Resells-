import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/api/handler.js";
import { testDb, type TestDb } from "./pg.js";

type Item = { brand: string | null; item: string; color: string | null; size: string; qty: number; unit_price: string | null };
type Booking = {
  id: string; date: string; time: string | null; status: string; payment_method: string; fulfillment: string; sale_price: string;
  delivery_fee: string; location: string | null; assignee: string | null; source: string; source_account: string | null;
  tracking_number: string | null; notes: string | null; status_reason: string | null; created_by: string; is_test: boolean;
  customer: { id: string; ig_handle: string; name: string } | null; items: Item[];
};
type Activity = { id: number; actor: string; action: string; entity: string; summary: string | null; changes: Record<string, { from: unknown; to: unknown }> | null };

const KEY = "test-bot-key-0123456789-abcdefghijklmnop";
let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
beforeEach(async () => {
  await t.reset();
  // TEST stock (the copy of BOT STOCK): test bookings only ever touch this.
  await t.seedStock([
    { brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "M", qty: 20, cost: 25 },
    { brand: "Spider", item: "Spider Hoodie", color: "Black/Pink", size: "S", qty: 5, cost: 28 },
  ]);
});

const log = async () => (await t.asService.rpc<Activity[]>("recent_activity", { p_limit: 200 })).reverse();
const count = async (table: string) => Number((await t.pg.query<{ n: string }>(`select count(*) n from ${table}`)).rows[0].n);

/** What the bot sends after a DM like "2 black essentials hoodies M, pickup sat 4pm, cash app". */
const pickup = {
  date: "2026-11-14", time: "16:00", payment_method: "cash_app", fulfillment: "pickup", location: "Warehouse",
  assignee: "Chema", source: "instagram", source_account: "Triangle Resells", notes: "TEST order", is_test: true,
  customer: { ig_user_id: "ig-test-1", ig_handle: "@TEST_buyer", name: "TEST Buyer", phone: "919-555-0100" },
  items: [{ brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "M", qty: 2, unit_price: 60 }],
};

describe("phase 2: bookings in the database", () => {
  it("TEST 1: the bot books a pickup; every field is saved, the customer is created, all logged as Bot", async () => {
    const b = await t.asService.rpc<Booking>("create_booking", { p: pickup, p_actor: "Bot" });
    expect(b).toMatchObject({
      date: "2026-11-14", time: "16:00:00", status: "booked", payment_method: "cash_app", fulfillment: "pickup", sale_price: 120,
      location: "Warehouse", assignee: "Chema", source: "instagram", source_account: "Triangle Resells", created_by: "Bot", is_test: true,
      customer: { ig_handle: "test_buyer", name: "TEST Buyer" },
      items: [{ brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "M", qty: 2, unit_price: 60 }],
    });
    const day = await t.asService.rpc<Booking[]>("bookings_between", { p_from: "2026-11-14", p_to: "2026-11-14", p_include_test: true });
    expect(day.map((d) => d.id)).toEqual([b.id]);
    const l = await log();
    expect(l.every((x) => x.actor === "Bot")).toBe(true);
    expect(l.map((x) => x.entity)).toEqual(["customers", "bookings", "booking_items"]);
    expect(l[1].summary).toBe("Bot booked TEST Buyer for 2026-11-14 16:00");
  });

  it("keeps test bookings off the real calendar unless asked", async () => {
    await t.asService.rpc("create_booking", { p: pickup, p_actor: "Bot" });
    expect(await t.asService.rpc("bookings_between", { p_from: "2026-11-01", p_to: "2026-11-30" })).toEqual([]);
  });

  it("TEST 2: the bot reschedules; the booking moves and the log says 'Bot rescheduled', and it can be undone", async () => {
    const b = await t.asService.rpc<Booking>("create_booking", { p: pickup, p_actor: "Bot" });
    const moved = await t.asService.rpc<Booking>("reschedule_booking", { p_id: b.id, p_date: "2026-11-20", p_time: "11:00", p_actor: "Bot" });
    expect(moved).toMatchObject({ date: "2026-11-20", time: "11:00:00" });
    expect(await t.asService.rpc("bookings_between", { p_from: "2026-11-14", p_to: "2026-11-14", p_include_test: true })).toEqual([]);
    const last = (await log()).at(-1)!;
    expect(last).toMatchObject({ actor: "Bot", action: "update", summary: "Bot rescheduled to 2026-11-20 11:00" });
    expect(last.changes).toMatchObject({ date: { from: "2026-11-14", to: "2026-11-20" }, time: { from: "16:00:00", to: "11:00:00" } });
    await t.asService.rpc("undo_activity", { p_id: last.id, p_actor: "Bot" });
    expect(await t.asService.rpc("get_booking", { p_id: b.id })).toMatchObject({ date: "2026-11-14", time: "16:00:00" });
  });

  it("TEST 3: the bot cancels; status Cancelled with the reason, logged", async () => {
    const b = await t.asService.rpc<Booking>("create_booking", { p: pickup, p_actor: "Bot" });
    const c = await t.asService.rpc<Booking>("cancel_booking", { p_id: b.id, p_reason: "buyer changed their mind", p_actor: "Bot" });
    expect(c).toMatchObject({ status: "cancelled", status_reason: "buyer changed their mind" });
    expect((await log()).at(-1)!.summary).toBe("Bot marked it Cancelled: buyer changed their mind");
  });

  it("TEST 4: a team member adds an in-person sale by hand; same checks, logged as them", async () => {
    const diego = await t.login("Diego");
    const b = await t.asUser(diego).rpc<Booking>("create_booking", {
      p: { ...pickup, source: "in_person", source_account: null, payment_method: "cash", assignee: "Diego", customer: { name: "TEST Walk-in", phone: "919-555-0199" }, sale_price: 100 },
    });
    expect(b).toMatchObject({ created_by: "Diego", source: "in_person", payment_method: "cash", sale_price: 100, customer: { name: "TEST Walk-in" } });
    expect((await log()).every((x) => x.actor === "Diego")).toBe(true);
  });

  it("Paid rule: the bot can mark Paid only for Stripe; Zelle / Cash App become 'Paid - needs check'; a person confirms", async () => {
    const b = await t.asService.rpc<Booking>("create_booking", { p: pickup, p_actor: "Bot" });
    expect(await t.asService.rpc("set_booking_status", { p_id: b.id, p_status: "paid", p_actor: "Bot" })).toMatchObject({ status: "paid_needs_check" });
    const josh = await t.login("Josh");
    expect(await t.asUser(josh).rpc("set_booking_status", { p_id: b.id, p_status: "paid" })).toMatchObject({ status: "paid" });
    const s = await t.asService.rpc<Booking>("create_booking", { p: { ...pickup, payment_method: "stripe" }, p_actor: "Bot" });
    expect(await t.asService.rpc("set_booking_status", { p_id: s.id, p_status: "paid", p_actor: "Bot" })).toMatchObject({ status: "paid" });
    // Even creating a booking straight as "paid" follows the rule.
    const z = await t.asService.rpc<Booking>("create_booking", { p: { ...pickup, payment_method: "zelle", status: "paid" }, p_actor: "Bot" });
    expect(z.status).toBe("paid_needs_check");
  });

  it("TEST 8 (bad data): missing size, unknown status, cash delivery: a clear error and NOTHING saved, not even the customer", async () => {
    const noSize = { ...pickup, items: [{ item: "Essentials Hoodie", color: "Black", qty: 1, unit_price: 60 }] };
    await expect(t.asService.rpc("create_booking", { p: noSize, p_actor: "Bot" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no size/) });
    await expect(t.asService.rpc("create_booking", { p: { ...pickup, payment_method: "cash", fulfillment: "delivery" }, p_actor: "Bot" })).rejects.toMatchObject({ status: 400 });
    await expect(t.asService.rpc("create_booking", { p: { ...pickup, items: [] }, p_actor: "Bot" })).rejects.toMatchObject({ status: 400 });
    expect(await count("customers")).toBe(0);
    expect(await count("bookings")).toBe(0);
    expect(await count("activity_log")).toBe(0);
    const b = await t.asService.rpc<Booking>("create_booking", { p: pickup, p_actor: "Bot" });
    await expect(t.asService.rpc("set_booking_status", { p_id: b.id, p_status: "lost", p_actor: "Bot" })).rejects.toMatchObject({ status: 400 });
    expect((await t.asService.rpc<Booking>("get_booking", { p_id: b.id })).status).toBe("booked");
  });

  it("edits replace the items and recompute the total; strangers can't read or write bookings", async () => {
    const b = await t.asService.rpc<Booking>("create_booking", { p: pickup, p_actor: "Bot" });
    const e = await t.asService.rpc<Booking>("update_booking", {
      p_id: b.id, p: { items: [{ item: "Spider Hoodie", color: "Black/Pink", size: "S", qty: 1, unit_price: 80 }], assignee: "Diego" }, p_actor: "Bot",
    });
    expect(e).toMatchObject({ sale_price: 80, assignee: "Diego", items: [{ item: "Spider Hoodie", qty: 1 }] });
    const stranger = (await t.pg.query<{ id: string }>("insert into auth.users (email) values ('x@x.com') returning id")).rows[0].id;
    await expect(t.asUser(stranger).rpc("bookings_between", { p_from: "2026-11-01", p_to: "2026-11-30", p_include_test: true })).rejects.toMatchObject({ status: 403 });
    await expect(t.asUser(stranger).rpc("create_booking", { p: pickup })).rejects.toMatchObject({ status: 403 });
    expect(await t.selectAs(stranger, "select * from bookings")).toHaveLength(0);
  });
});

describe("phase 2: the bot's booking API", () => {
  const api = () => createApi({ db: t.asService, botApiKey: KEY });
  const call = (path: string, method = "GET", body?: unknown) =>
    api()(new Request(`https://crm.test/api${path}`, { method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));

  it("create, list, reschedule, mark paid, cancel: all over HTTP", async () => {
    const made = await call("/bookings", "POST", pickup);
    expect(made.status).toBe(200);
    const { booking } = await made.json();
    const list = await (await call("/bookings?from=2026-11-14&to=2026-11-14&include_test=true")).json();
    expect(list.bookings).toHaveLength(1);
    expect((await (await call(`/bookings/${booking.id}/reschedule`, "POST", { date: "2026-11-20", time: "11:00" })).json()).booking.date).toBe("2026-11-20");
    expect((await (await call(`/bookings/${booking.id}/status`, "POST", { status: "paid" })).json()).booking.status).toBe("paid_needs_check");
    expect((await (await call(`/bookings/${booking.id}/cancel`, "POST", { reason: "TEST" })).json()).booking.status).toBe("cancelled");
    expect((await call(`/bookings/${booking.id}`)).status).toBe(200);
  });

  it("rejects bad requests clearly", async () => {
    expect((await call("/bookings?from=nope")).status).toBe(400);
    expect((await call("/bookings/00000000-0000-0000-0000-000000000000")).status).toBe(404);
    const bad = await call("/bookings", "POST", { ...pickup, items: [{ item: "Hoodie", qty: 1 }] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/no size/);
  });
});
