import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "./pg.js";

type Restock = { id: string; name: string; status: string; received_at: string | null; items: { id: string; item: string; color: string; size: string; qty_expected: number; qty_received: number | null }[] };
type Row = { item: string; color: string | null; size: string | null; status: string; free: number; reserved: number; came_in: number; sold_since_restock: number; sold_all_time: number; restock: string | null; needs_sheet_row: boolean };
type Sync = { writes: { item: string; qty: number; status: string | null }[]; add_rows: { item: string; color: string; size: string; qty: number; status: string }[] };

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});

// The sheet as the bot reads it: Essentials hoodies are INCOMING (on the sheet, not sellable yet).
const sheetRows = (essentialsQty = 0, essentialsStatus = "incoming", extra: Record<string, unknown>[] = []) => [
  { brand: "Chrome Hearts", item: "Chrome Hearts Hat", color: "Black", qty: 10, cost: 12 },
  { brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "XS", qty: essentialsQty, status: essentialsStatus, cost: 25 },
  ...extra,
];
const sync = (rows: Record<string, unknown>[]) =>
  t.asService.rpc<Sync>("stock_sync", { p_rows: rows.map((r) => ({ status: "for_sale", ...r, qty: String(r.qty), cost: r.cost == null ? "" : String(r.cost) })), p_is_test: true, p_actor: "Bot" });
const overview = async () => t.asService.rpc<Row[]>("stock_overview", { p_is_test: true });
const row = async (item: string, color: string, size?: string) => (await overview()).find((r) => r.item === item && r.color === color && (size === undefined || r.size === size))!;

beforeEach(async () => {
  await t.reset();
  await sync(sheetRows());
});

const incoming = {
  name: "TEST Nov 16-17 restock", expected_date: "2026-11-16", is_test: true,
  items: [
    { brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "XS", qty_expected: 20, unit_cost: 25 },
    { brand: "Supreme", item: "Supreme Hoodie", color: "Red", size: "M", qty_expected: 5, unit_cost: 30, price_list: "SUPREME HOODIES" },
  ],
};

describe("restocks", () => {
  it("logging an incoming restock changes nothing in stock until it's received", async () => {
    const josh = await t.login("Josh");
    const r = await t.asUser(josh).rpc<Restock>("create_restock", { p: incoming });
    expect(r).toMatchObject({ status: "incoming", items: [{ item: "Essentials Hoodie", qty_expected: 20 }, { item: "Supreme Hoodie", qty_expected: 5 }] });
    expect((await row("Essentials Hoodie", "Black")).free).toBe(0);
    expect(await t.qty("Supreme Hoodie", "Red", "M")).toBe(-1); // not in stock at all yet
  });

  it("receiving adds the pieces, turns INCOMING into FOR SALE, and asks the bot to add rows for new items", async () => {
    const josh = await t.login("Josh");
    const r = await t.asUser(josh).rpc<Restock>("create_restock", { p: incoming });
    // Only 18 of the 20 Essentials showed up.
    const ess = r.items.find((i) => i.item === "Essentials Hoodie")!;
    const got = await t.asUser(josh).rpc<Restock>("receive_restock", { p_id: r.id, p_received: [{ id: ess.id, qty_received: 18 }] });
    expect(got.status).toBe("received");
    expect(got.items.map((i) => [i.item, i.qty_received])).toEqual([["Essentials Hoodie", 18], ["Supreme Hoodie", 5]]);
    expect(await t.qty("Essentials Hoodie", "Black", "XS")).toBe(18);
    expect(await t.qty("Supreme Hoodie", "Red", "M")).toBe(5);
    // Sellable right away.
    await t.asService.rpc("create_booking", { p: { date: "2026-11-18", payment_method: "cash", fulfillment: "pickup", is_test: true, customer: { ig_handle: "TEST_r" },
      items: [{ item: "Supreme Hoodie", color: "Red", size: "M", qty: 1, unit_price: 100 }] }, p_actor: "Bot" });
    // Next sync (the sheet still says INCOMING and 0): the CRM keeps FOR SALE / 18 and asks the bot to write them, and to add the Supreme row.
    const s = await sync(sheetRows(0, "incoming"));
    expect(s.writes).toContainEqual(expect.objectContaining({ item: "Essentials Hoodie", qty: 18, status: "for_sale" }));
    expect(s.add_rows).toEqual([expect.objectContaining({ item: "Supreme Hoodie", color: "Red", size: "M", qty: 4, status: "for_sale" })]);
    expect((await row("Essentials Hoodie", "Black")).status).toBe("for_sale");
    // The bot did its writes: the sheet now shows them. Everything settles, nothing double-counted.
    const after = await sync(sheetRows(18, "for_sale", [{ brand: "Supreme", item: "Supreme Hoodie", color: "Red", size: "M", qty: 4, cost: 30 }]));
    expect(after).toMatchObject({ writes: [], add_rows: [] });
    expect(await t.qty("Supreme Hoodie", "Red", "M")).toBe(4);
    expect(await t.qty("Essentials Hoodie", "Black", "XS")).toBe(18);
    // Receiving twice is refused.
    await expect(t.asUser(josh).rpc("receive_restock", { p_id: r.id })).rejects.toMatchObject({ status: 400 });
  });

  it("the stock view: came in, sold since the restock, reserved, free to sell", async () => {
    const josh = await t.login("Josh");
    const r = await t.asUser(josh).rpc<Restock>("create_restock", { p: incoming });
    await t.asUser(josh).rpc("receive_restock", { p_id: r.id });
    const book = async (qty: number, status: string) => {
      const b = await t.asService.rpc<{ id: string }>("create_booking", { p: { date: "2026-12-01", payment_method: "cash", fulfillment: "pickup", is_test: true,
        customer: { ig_handle: `TEST_${qty}_${status}` }, items: [{ item: "Essentials Hoodie", color: "Black", size: "XS", qty, unit_price: 60 }] }, p_actor: "Bot" });
      if (status !== "booked") await t.asService.rpc("set_booking_status", { p_id: b.id, p_status: status, p_actor: "System" });
    };
    await book(3, "done");
    await book(2, "booked");
    await book(1, "cancelled");
    expect(await row("Essentials Hoodie", "Black")).toMatchObject({
      restock: "TEST Nov 16-17 restock", came_in: 20, sold_since_restock: 3, reserved: 2, free: 15, sold_all_time: 3, status: "for_sale",
    });
  });

  it("an incoming restock can be edited; bad lines are refused; strangers can't see it", async () => {
    const josh = await t.login("Josh");
    const r = await t.asUser(josh).rpc<Restock>("create_restock", { p: incoming });
    const e = await t.asUser(josh).rpc<Restock>("update_restock", { p_id: r.id, p: { items: [{ item: "Essentials Hoodie", color: "Black", size: "XS", qty_expected: 30 }] } });
    expect(e.items).toHaveLength(1);
    await expect(t.asUser(josh).rpc("create_restock", { p: { name: "x", items: [{ item: "", qty_expected: 1 }] } })).rejects.toMatchObject({ status: 400 });
    await expect(t.asUser(josh).rpc("create_restock", { p: { name: "x", items: [] } })).rejects.toMatchObject({ status: 400 });
    const stranger = (await t.pg.query<{ id: string }>("insert into auth.users (email) values ('x@x.com') returning id")).rows[0].id;
    await expect(t.asUser(stranger).rpc("restocks_list", {})).rejects.toMatchObject({ status: 403 });
    await expect(t.asUser(stranger).rpc("stock_overview", {})).rejects.toMatchObject({ status: 403 });
  });

  it("logged with who did it, and undoable while it's still incoming", async () => {
    const chema = await t.login("Chema");
    const r = await t.asUser(chema).rpc<Restock>("create_restock", { p: incoming });
    const log = (await t.pg.query<{ id: number; actor: string; summary: string }>("select id, actor, summary from activity_log where entity = 'restocks'")).rows;
    expect(log[0]).toMatchObject({ actor: "Chema", summary: "Chema logged an incoming restock: TEST Nov 16-17 restock" });
    await t.asUser(chema).rpc("undo_activity", { p_id: log[0].id });
    expect((await t.pg.query("select * from restocks where id = $1", [r.id])).rows).toHaveLength(0);
  });
});
