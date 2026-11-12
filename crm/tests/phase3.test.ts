import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "./pg.js";

type Booking = { id: string; status: string; items: { item: string; qty: number; unit_cost: string | null; reserved: boolean }[] };
type Sync = { sheet_edits_applied: number; writes: { item: string; color: string | null; size: string | null; occurrence: number; qty: number; status: string | null }[]; add_rows: unknown[] };

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
beforeEach(async () => {
  await t.reset();
  await t.seedStock([
    { brand: "Chrome Hearts", item: "Chrome Hearts Hat", color: "Black", qty: 3, cost: 12 },
    { brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "M", qty: 1, cost: 25 },
    { brand: "Supreme", item: "Supreme Hoodie", color: "Black", size: "M", qty: 10, status: "incoming" },
  ]);
});

const order = (items: { item: string; color?: string; size?: string; qty: number }[], extra: Record<string, unknown> = {}) => ({
  date: "2026-11-14", time: "16:00", payment_method: "cash_app", fulfillment: "pickup", is_test: true,
  customer: { ig_handle: "TEST_buyer" }, items: items.map((i) => ({ size: "One Size", unit_price: 30, ...i })), ...extra,
});
const book = (items: Parameters<typeof order>[0], extra?: Record<string, unknown>) =>
  t.asService.rpc<Booking>("create_booking", { p: order(items, extra), p_actor: "Bot" });
const hats = (qty: number) => [{ item: "Chrome Hearts Hat", color: "Black", qty }];
const sync = (rows: Record<string, unknown>[], isTest = true) =>
  t.asService.rpc<Sync>("stock_sync", { p_rows: rows.map((r) => ({ status: "for_sale", ...r, qty: String(r.qty) })), p_is_test: isTest, p_actor: "Bot" });
const moves = async () => (await t.pg.query<{ delta: number; qty_after: number; reason: string; actor: string }>("select delta, qty_after, reason, actor from stock_moves order by id")).rows;

describe("phase 3: stock reserved with the booking", () => {
  it("a booking takes its pieces, logs why and who, and fills in the cost from the sheet", async () => {
    const b = await book(hats(2));
    expect(await t.qty("Chrome Hearts Hat", "Black", null)).toBe(1);
    expect(b.items[0]).toMatchObject({ reserved: true, unit_cost: 12 });
    expect(await moves()).toEqual([{ delta: -2, qty_after: 1, reason: "booked", actor: "Bot" }]);
  });

  it("TEST 3 (stock): cancel and no-show put the pieces back; reopening takes them again", async () => {
    const b = await book(hats(2));
    await t.asService.rpc("cancel_booking", { p_id: b.id, p_reason: "TEST", p_actor: "Bot" });
    expect(await t.qty("Chrome Hearts Hat", "Black", null)).toBe(3);
    const josh = await t.login("Josh");
    await t.asUser(josh).rpc("set_booking_status", { p_id: b.id, p_status: "booked" });
    expect(await t.qty("Chrome Hearts Hat", "Black", null)).toBe(1);
    await t.asUser(josh).rpc("set_booking_status", { p_id: b.id, p_status: "no_show" });
    expect(await t.qty("Chrome Hearts Hat", "Black", null)).toBe(3);
    expect((await moves()).map((m) => m.reason)).toEqual(["booked", "cancelled", "reopened", "no-show"]);
    // Paid and Done keep the pieces taken (they're sold).
    await t.asUser(josh).rpc("set_booking_status", { p_id: b.id, p_status: "booked" });
    await t.asUser(josh).rpc("set_booking_status", { p_id: b.id, p_status: "done" });
    expect(await t.qty("Chrome Hearts Hat", "Black", null)).toBe(1);
  });

  it("TEST 7: two bookings for the last unit: the second is refused, nothing of it saved, stock never negative", async () => {
    await book([{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 1 }]);
    await expect(book([{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 1 }], { customer: { ig_handle: "TEST_second" } }))
      .rejects.toMatchObject({ status: 409, message: "only 0 left of Essentials Hoodie Black M (asked for 1)" });
    expect(await t.qty("Essentials Hoodie", "Black", "M")).toBe(0);
    expect((await t.pg.query("select * from bookings")).rows).toHaveLength(1);
    expect((await t.pg.query("select * from customers where ig_handle = 'test_second'")).rows).toHaveLength(0);
    // A cancel frees it, and then the second buyer can have it.
    const [first] = (await t.pg.query<{ id: string }>("select id from bookings")).rows;
    await t.asService.rpc("cancel_booking", { p_id: first.id, p_actor: "Bot" });
    await book([{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 1 }], { customer: { ig_handle: "TEST_second" } });
    expect(await t.qty("Essentials Hoodie", "Black", "M")).toBe(0);
  });

  it("reopening a cancelled booking is refused if the piece was sold meanwhile", async () => {
    const a = await book([{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 1 }]);
    await t.asService.rpc("cancel_booking", { p_id: a.id, p_actor: "Bot" });
    await book([{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 1 }], { customer: { ig_handle: "TEST_b" } });
    await expect(t.asService.rpc("set_booking_status", { p_id: a.id, p_status: "booked", p_actor: "Bot" })).rejects.toMatchObject({ status: 409 });
    expect((await t.asService.rpc<Booking>("get_booking", { p_id: a.id })).status).toBe("cancelled");
  });

  it("TEST 8 (stock): an unknown, INCOMING or not-test item is refused with a clear message and nothing saved", async () => {
    await expect(book([{ item: "Nike Tech Fleece", color: "Black", size: "L", qty: 1 }])).rejects.toMatchObject({ status: 400, message: "Nike Tech Fleece Black L isn't a FOR SALE item on BOT STOCK (TEST stock)" });
    await expect(book([{ item: "Supreme Hoodie", color: "Black", size: "M", qty: 1 }])).rejects.toMatchObject({ status: 400 });
    // Real bookings only see real stock (none seeded here), test bookings only test stock.
    await expect(book(hats(1), { is_test: false })).rejects.toMatchObject({ status: 400 });
    expect((await t.pg.query("select * from bookings")).rows).toHaveLength(0);
    expect(await moves()).toEqual([]);
  });

  it("editing items gives the old pieces back and takes the new ones; undoing a booking gives everything back", async () => {
    const b = await book(hats(2));
    await t.asService.rpc("update_booking", { p_id: b.id, p: { items: [{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 1, unit_price: 60 }] }, p_actor: "Bot" });
    expect(await t.qty("Chrome Hearts Hat", "Black", null)).toBe(3);
    expect(await t.qty("Essentials Hoodie", "Black", "M")).toBe(0);
    const created = (await t.pg.query<{ id: number }>("select id from activity_log where entity = 'bookings' and action = 'create'")).rows[0];
    await t.asService.rpc("undo_activity", { p_id: created.id, p_actor: "Bot" });
    expect(await t.qty("Essentials Hoodie", "Black", "M")).toBe(1);
  });

  it("an edit that needs more than what's left is refused and the old items stay", async () => {
    const b = await book(hats(1));
    const five = [{ item: "Chrome Hearts Hat", color: "Black", size: "One Size", qty: 5, unit_price: 30 }];
    await expect(t.asService.rpc("update_booking", { p_id: b.id, p: { items: five }, p_actor: "Bot" })).rejects.toMatchObject({ status: 409 });
    expect((await t.asService.rpc<Booking>("get_booking", { p_id: b.id })).items[0].qty).toBe(1);
    expect(await t.qty("Chrome Hearts Hat", "Black", null)).toBe(2);
  });
});

describe("phase 3: BOT STOCK sync", () => {
  const sheet = (hatQty: number, extra: Record<string, unknown>[] = []) => [
    { brand: "Chrome Hearts", item: "Chrome Hearts Hat", color: "Black", qty: hatQty, cost: 12 },
    { brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "M", qty: 1, cost: 25 },
    { brand: "Supreme", item: "Supreme Hoodie", color: "Black", size: "M", qty: 10, status: "incoming" },
    ...extra,
  ];

  it("after a booking, tells the bot what to write on the sheet, and doesn't double-count once it's written", async () => {
    await book(hats(2));
    const first = await sync(sheet(3));
    expect(first).toEqual({ sheet_edits_applied: 0, add_rows: [], writes: [{ item: "Chrome Hearts Hat", color: "Black", size: null, occurrence: 1, qty: 1, status: null }] });
    // Next minute: the sheet now shows 1 (our write landed). Nothing more to do.
    expect(await sync(sheet(1))).toEqual({ sheet_edits_applied: 0, add_rows: [], writes: [] });
    expect(await t.qty("Chrome Hearts Hat", "Black", null)).toBe(1);
  });

  it("if the write didn't land, it asks again (and doesn't mistake the old number for an edit)", async () => {
    await book(hats(2));
    await sync(sheet(3));
    const again = await sync(sheet(3)); // the sheet still shows 3
    expect(again.writes).toEqual([{ item: "Chrome Hearts Hat", color: "Black", size: null, occurrence: 1, qty: 1, status: null }]);
    expect(await t.qty("Chrome Hearts Hat", "Black", null)).toBe(1);
  });

  it("a restock typed on the sheet adds to the live count, even with pieces reserved", async () => {
    await book(hats(2)); // live 1, sheet still 3
    await sync(sheet(3)); // asks to write 1
    await sync(sheet(1)); // landed
    await sync(sheet(11)); // Josh adds 10 on the sheet
    expect(await t.qty("Chrome Hearts Hat", "Black", null)).toBe(11);
    expect((await moves()).at(-1)).toMatchObject({ delta: 10, qty_after: 11, reason: "BOT STOCK edited on the sheet", actor: "Bot" });
    // A count fix down to 0 on the sheet can't push the live count below 0.
    await sync(sheet(0));
    expect(await t.qty("Chrome Hearts Hat", "Black", null)).toBe(0);
  });

  it("new rows come in, removed rows stop being sellable, status and cost follow the sheet", async () => {
    await sync(sheet(3, [{ brand: "BAPE", item: "BAPE Tee", color: "Black", size: "L", qty: 6, cost: 9 }]));
    expect(await t.qty("BAPE Tee", "Black", "L")).toBe(6);
    await book([{ item: "BAPE Tee", color: "Black", size: "L", qty: 1 }]);
    await sync(sheet(3)); // BAPE row deleted from the sheet
    await expect(book([{ item: "BAPE Tee", color: "Black", size: "L", qty: 1 }])).rejects.toMatchObject({ status: 400 });
    await sync(sheet(3).map((r) => (r.item === "Supreme Hoodie" ? { ...r, status: "for_sale" } : r))); // Supreme landed
    await book([{ item: "Supreme Hoodie", color: "Black", size: "M", qty: 2 }]);
    expect(await t.qty("Supreme Hoodie", "Black", "M")).toBe(8);
  });

  it("only the bot's server key can run the sync", async () => {
    const josh = await t.login("Josh");
    await expect(t.asUser(josh).rpc("stock_sync", { p_rows: [], p_is_test: true })).rejects.toThrow();
  });
});

describe("the bot and the database match stock rows the same way", () => {
  it("stockKey (bot) === crm_stock_key (database) for tricky names", async () => {
    const { stockKey } = await import("../../src/desk.js");
    const cases: [string, string | null, string | null][] = [
      ["Chrome Hearts Hat", "Black", null], ["Chrome Hearts Hat", "Black", "One Size"], ["Chrome Hearts Hat", "black", "OS"],
      ["Spider Hoodie", "Black/Pink", "S"], ["  Valley  Tee ", "White/Orange", " M "], ["Sp5der OG Web Hoodie", "Black/Gold", "XL"],
      ["Bleu de Chanel EDP", "", ""], ["Amiri Button-Up", "Black & White", "L"],
    ];
    for (const [item, color, size] of cases) {
      const db = (await t.pg.query<{ k: string }>("select crm_stock_key($1, $2, $3) k", [item, color, size])).rows[0].k;
      expect(stockKey(item, color, size)).toBe(db);
    }
  });
});
