import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/api/handler.js";
import { testDb, type TestDb } from "./pg.js";

type Customer = { id: string; ig_user_id: string | null; ig_handle: string | null; name: string | null; phone: string | null; is_test: boolean };
type Activity = { id: number; actor: string; action: string; entity: string; entity_id: string; changes: Record<string, { from: unknown; to: unknown }> | null; undo_of: number | null; is_test: boolean };

const KEY = "test-bot-key-0123456789-abcdefghijklmnop";
let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
beforeEach(async () => {
  await t.reset();
});

const activity = async () => (await t.asService.rpc<Activity[]>("recent_activity", { p_limit: 100 })).reverse();

describe("phase 1: database, logins, activity log", () => {
  it("starts with the three team members and an empty log", async () => {
    const rows = await t.pg.query<{ name: string }>("select name from team_members order by name");
    expect(rows.rows.map((r) => r.name)).toEqual(["Chema", "Diego", "Josh"]);
    expect(await activity()).toEqual([]);
  });

  it("logs every bot change as Bot, with what changed, and never blanks a field", async () => {
    const c = await t.asService.rpc<Customer>("upsert_customer", { p: { ig_user_id: "ig1", ig_handle: "@TEST_buyer", name: "TEST Buyer", is_test: true }, p_actor: "Bot" });
    expect(c).toMatchObject({ ig_user_id: "ig1", ig_handle: "test_buyer", name: "TEST Buyer", is_test: true });
    // Second DM: same person by handle, now with a phone. Name not given: must stay.
    const again = await t.asService.rpc<Customer>("upsert_customer", { p: { ig_handle: "test_buyer", phone: "919-555-0100" }, p_actor: "Bot" });
    expect(again).toMatchObject({ id: c.id, name: "TEST Buyer", phone: "919-555-0100" });
    const log = await activity();
    expect(log.map((l) => [l.actor, l.action, l.entity])).toEqual([["Bot", "create", "customers"], ["Bot", "update", "customers"]]);
    expect(log[1].changes).toEqual({ phone: { from: null, to: "919-555-0100" } });
    expect(log.every((l) => l.is_test)).toBe(true);
  });

  it("logs a logged-in team member by their login, and they can't pretend to be the bot", async () => {
    const josh = await t.login("Josh");
    await t.asUser(josh).rpc("upsert_customer", { p: { ig_handle: "TEST_walkin", name: "TEST Walk-in", is_test: true }, p_actor: "Bot" });
    expect((await activity())[0].actor).toBe("Josh");
  });

  it("only the team can read or write: not anonymous visitors, not other logins", async () => {
    await t.asService.rpc("upsert_customer", { p: { ig_handle: "TEST_a", is_test: true }, p_actor: "Bot" });
    const chema = await t.login("Chema");
    expect(await t.selectAs(chema, "select ig_handle from customers")).toHaveLength(1);
    await expect(t.selectAs(null, "select * from customers")).rejects.toThrow(/permission denied/);
    const stranger = (await t.pg.query<{ id: string }>("insert into auth.users (email) values ('x@x.com') returning id")).rows[0].id;
    expect(await t.selectAs(stranger, "select * from customers")).toHaveLength(0);
    await expect(t.asUser(stranger).rpc("upsert_customer", { p: { ig_handle: "TEST_b" } })).rejects.toMatchObject({ status: 403 });
    await expect(t.selectAs(chema, "insert into customers (name) values ('sneaky')")).rejects.toThrow(/permission denied/);
  });

  it("undoes any change from its log line, logs the undo, and won't undo twice", async () => {
    const c = await t.asService.rpc<Customer>("upsert_customer", { p: { ig_handle: "TEST_c", name: "TEST Old", is_test: true }, p_actor: "Bot" });
    await t.asService.rpc("upsert_customer", { p: { ig_handle: "TEST_c", name: "TEST New" }, p_actor: "Bot" });
    const update = (await activity()).at(-1)!;
    const diego = await t.login("Diego");
    const undone = await t.asUser(diego).rpc<Activity>("undo_activity", { p_id: update.id });
    expect(undone).toMatchObject({ actor: "Diego", action: "update", undo_of: update.id });
    expect((await t.pg.query<Customer>("select * from customers where id = $1", [c.id])).rows[0].name).toBe("TEST Old");
    await expect(t.asUser(diego).rpc("undo_activity", { p_id: update.id })).rejects.toThrow(/already undone/);
    // Undo the create: the customer is gone, and that's logged too.
    const create = (await activity())[0];
    await t.asService.rpc("undo_activity", { p_id: create.id, p_actor: "Bot" });
    expect((await t.pg.query("select * from customers")).rows).toHaveLength(0);
    expect((await activity()).at(-1)).toMatchObject({ actor: "Bot", action: "delete", undo_of: create.id });
  });

  it("bad data saves nothing at all (no row, no log line)", async () => {
    await expect(t.asService.rpc("upsert_customer", { p: { ig_handle: "TEST_bad", is_test: "maybe" }, p_actor: "Bot" })).rejects.toMatchObject({ status: 400 });
    await expect(t.asService.rpc("upsert_customer", { p: { ig_handle: "TEST_bad" }, p_actor: "Hacker" })).rejects.toMatchObject({ status: 400 });
    expect((await t.pg.query("select * from customers")).rows).toHaveLength(0);
    expect(await activity()).toEqual([]);
  });
});

describe("phase 1: the bot's API", () => {
  const req = (path: string, init: RequestInit & { key?: string | null } = {}) =>
    new Request(`https://crm.test/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.key === null ? {} : { Authorization: `Bearer ${init.key ?? KEY}` }) },
    });

  it("refuses requests without the right key, and never runs with a weak key", async () => {
    const lines: string[] = [];
    const api = createApi({ db: t.asService, botApiKey: KEY, log: (l) => lines.push(l) });
    expect((await api(req("/health", { key: null }))).status).toBe(200);
    expect((await api(req("/activity", { key: null }))).status).toBe(401);
    expect((await api(req("/activity", { key: KEY.slice(0, -1) + "X" }))).status).toBe(401);
    const weak = createApi({ db: t.asService, botApiKey: "short" });
    expect((await weak(req("/activity", { key: "short" }))).status).toBe(401);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("looks up a buyer, records them as Bot, and lists and undoes activity", async () => {
    const api = createApi({ db: t.asService, botApiKey: KEY });
    expect((await api(req("/customers/lookup?ig_user_id=ig9"))).status).toBe(404);
    const made = await api(req("/customers", { method: "POST", body: JSON.stringify({ ig_user_id: "ig9", ig_handle: "TEST_api", is_test: true }) }));
    expect(made.status).toBe(200);
    const found = await (await api(req("/customers/lookup?ig_handle=@test_api"))).json();
    expect(found.customer).toMatchObject({ ig_user_id: "ig9", ig_handle: "test_api" });
    const log = await (await api(req("/activity?limit=5"))).json();
    expect(log.activity[0]).toMatchObject({ actor: "Bot", action: "create", entity: "customers" });
    const undo = await api(req(`/activity/${log.activity[0].id}/undo`, { method: "POST" }));
    expect(undo.status).toBe(200);
    expect((await api(req("/customers/lookup?ig_user_id=ig9"))).status).toBe(404);
  });

  it("answers bad input with a clear 400 and saves nothing", async () => {
    const api = createApi({ db: t.asService, botApiKey: KEY });
    expect((await api(req("/customers", { method: "POST", body: "not json" }))).status).toBe(400);
    const bad = await api(req("/customers", { method: "POST", body: JSON.stringify({ ig_handle: "TEST_x", is_test: "maybe" }) }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/boolean/);
    expect((await t.pg.query("select * from customers")).rows).toHaveLength(0);
  });
});

describe("phase 2: public config for the screens", () => {
  it("serves only the public Supabase address and anon key, without needing the bot key", async () => {
    const api = createApi({ db: t.asService, botApiKey: KEY, publicConfig: { supabaseUrl: "https://x.supabase.co", anonKey: "anon-public" } });
    const r = await api(new Request("https://crm.test/api/config"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ supabaseUrl: "https://x.supabase.co", anonKey: "anon-public" });
  });
});

describe("Supabase connection", () => {
  it("sends a new-style secret key only as apikey, and a legacy key as apikey + Bearer", async () => {
    const { supabaseDb } = await import("../src/api/db.js");
    const seen: Record<string, string>[] = [];
    const fake = (async (_u: unknown, init?: RequestInit) => {
      seen.push(init!.headers as Record<string, string>);
      return new Response("null", { status: 200 });
    }) as typeof fetch;
    await supabaseDb("https://x.supabase.co", "sb_secret_abc", fake).rpc("find_customer", {});
    await supabaseDb("https://x.supabase.co", "eyJhbGciOiJIUzI1NiJ9.legacy", fake).rpc("find_customer", {});
    expect(seen[0]).toMatchObject({ apikey: "sb_secret_abc" });
    expect(seen[0]).not.toHaveProperty("Authorization");
    expect(seen[1]).toMatchObject({ apikey: "eyJhbGciOiJIUzI1NiJ9.legacy", Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.legacy" });
  });
});

describe("one-paste setup (supabase/setup.sql)", () => {
  it("is up to date with the migrations, and builds the same database from scratch (twice, safely)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { PGlite } = await import("@electric-sql/pglite");
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase");
    const setup = readFileSync(path.join(root, "setup.sql"), "utf8");
    for (const f of readdirSync(path.join(root, "migrations")).filter((x) => x.endsWith(".sql"))) {
      expect(setup, `${f} is missing from setup.sql: run npm run bundle-sql`).toContain(readFileSync(path.join(root, "migrations", f), "utf8").replace(/\r\n/g, "\n").trim());
    }
    const pg = new PGlite();
    await pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create function auth.role() returns text language sql stable as $$ select null::text $$;`);
    await pg.exec(setup);
    await pg.exec(setup); // pasting it again must not break anything
    const tables = (await pg.query<{ n: string }>("select count(*) n from information_schema.tables where table_schema = 'public'")).rows[0].n;
    // team_members, customers, activity_log, bookings, booking_items, bot_events, stock_items, stock_moves, restocks,
    // restock_items, bot_notes, team_notifications, video_ideas
    expect(Number(tables)).toBe(13);
    expect((await pg.query<{ name: string }>("select name from team_members order by name")).rows.map((r) => r.name)).toEqual(["Chema", "Diego", "Josh"]);
    await pg.close();
  });
});
