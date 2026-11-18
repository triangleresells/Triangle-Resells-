/** The live end-to-end runner (scripts/e2e/run.ts), proven here against the local database before it ever runs live. */
import { beforeAll, describe, expect, it } from "vitest";
import { runE2E, reportText } from "../../scripts/e2e/run.js";
import { loadPricing } from "../../src/config.js";
import { crmClient } from "../../src/crm.js";
import { createApi } from "../src/api/handler.js";
import { testDb, type TestDb } from "./pg.js";

const KEY = "test-bot-key-0123456789-abcdefghijklmnop";
let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});

describe("the brief's 8 end-to-end tests (local run of the live runner)", () => {
  it("all pass, with TEST data only, and every TEST row is deleted at the end", async () => {
    await t.reset();
    // Real stock must stay exactly as it is; TEST stock (BOT STOCK TEST) is what gets used.
    const hat = { brand: "Chrome Hearts", item: "Chrome Hearts Hat", color: "Black", qty: 10, price_list: "CHROME HEARTS HATS", cost: 12 };
    await t.seedStock([hat], false);
    await t.seedStock([hat], true);
    const josh = await t.login("Josh");
    const handle = createApi({ db: t.asService, botApiKey: KEY });
    const fetchFn = ((i: RequestInfo | URL, init?: RequestInit) => handle(new Request(String(i), init))) as typeof fetch;
    const api = async (method: string, path: string, body?: unknown) =>
      (await fetchFn(`https://crm.test/api${path}`, { method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
    const r = await runE2E({ crm: crmClient("https://crm.test", KEY, fetchFn), api, team: t.asUser(josh), teamName: "Josh", pricing: loadPricing(), now: new Date("2026-11-12T15:00:00Z") });
    const report = reportText(r);
    expect(r.results.filter((x) => !x.pass), report).toEqual([]);
    expect(r.results.map((x) => x.n)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    // Nothing TEST is left, and real stock never moved.
    expect((await t.pg.query("select * from bookings")).rows).toHaveLength(0);
    expect((await t.pg.query("select * from stock_items where is_test")).rows).toHaveLength(0);
    expect(await t.qty("Chrome Hearts Hat", "Black", null, false)).toBe(10);
  });
});
