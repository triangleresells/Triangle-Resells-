/**
 * Local Postgres for tests (PGlite: real Postgres in-process, no Docker). Mimics the Supabase pieces the migrations
 * use: the anon / authenticated / service_role roles and auth.uid() / auth.role() read from the request's JWT claims.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { DbError, statusFor, type Db } from "../src/api/db.js";

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
`;

export interface TestDb {
  pg: PGlite;
  /** Calls a database function as the bot / server (service role), like the Netlify API does. */
  asService: Db;
  /** Calls a database function as a logged-in person (their Supabase login id). */
  asUser(userId: string): Db;
  /** Creates a login for a team member and links it, returns its id. */
  login(name: "Josh" | "Chema" | "Diego"): Promise<string>;
  /** Wipes all data (keeps the schema and the three team members, unlinked). Call between tests. */
  reset(): Promise<void>;
  /** Plain SELECT as a logged-in person (row level security applies). */
  selectAs<T>(userId: string | null, sql: string): Promise<T[]>;
}

function toParam(v: unknown): unknown {
  return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
}

async function callAs(tx: Transaction, role: string, sub: string | null, fn: string, args: Record<string, unknown>) {
  await tx.query(`set local role ${role}`);
  await tx.query(`select set_config('request.jwt.claim.role', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [role, sub ?? ""]);
  const keys = Object.keys(args);
  const call = `select to_jsonb(${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})) as r`;
  const res = await tx.query<{ r: unknown }>(call, keys.map((k) => toParam(args[k])));
  return res.rows[0]?.r ?? null;
}

function dbFor(pg: PGlite, role: string, sub: string | null): Db {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      try {
        return (await pg.transaction((tx) => callAs(tx, role, sub, fn, args))) as T;
      } catch (err) {
        const code = (err as { code?: string }).code;
        throw new DbError((err as Error).message, statusFor(code), code);
      }
    },
  };
}

export async function testDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUB);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(path.join(MIGRATIONS, f), "utf8"));
  }
  return {
    pg,
    async reset() {
      await pg.exec(`truncate activity_log, customers restart identity cascade; update team_members set user_id = null, email = null; delete from auth.users;`);
    },
    asService: dbFor(pg, "service_role", null),
    asUser: (userId) => dbFor(pg, "authenticated", userId),
    async login(name) {
      const u = await pg.query<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [`${name.toLowerCase()}@test.local`]);
      await pg.query(`update team_members set user_id = $1, email = $2 where name = $3`, [u.rows[0].id, `${name.toLowerCase()}@test.local`, name]);
      return u.rows[0].id;
    },
    async selectAs<T>(userId: string | null, sql: string) {
      return pg.transaction(async (tx) => {
        await tx.query(`set local role ${userId ? "authenticated" : "anon"}`);
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? ""]);
        return (await tx.query<T>(sql)).rows;
      });
    },
  };
}
