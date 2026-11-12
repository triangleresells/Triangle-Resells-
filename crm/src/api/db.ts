/**
 * The one door to the database. Every write is a Postgres function (see supabase/migrations), so a change and its
 * activity-log line are saved together or not at all.
 *
 * Production: Supabase's REST endpoint (/rest/v1/rpc/<fn>) with the service-role key, server-side only.
 * Tests: PGlite (real Postgres in-process), see tests/pg.ts.
 */
export interface Db {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
}

/** A database error with a safe message (never a key, never a stack). `status` is the HTTP status to answer with. */
export class DbError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Postgres error code -> HTTP status. */
export function statusFor(code: string | undefined): number {
  if (!code) return 500;
  if (code === "42501") return 403; // not allowed
  if (code === "P0002") return 404; // not found
  if (code === "23505") return 409; // duplicate
  if (code === "TR409") return 409; // not enough stock
  if (code.startsWith("22") || code.startsWith("23")) return 400; // bad data
  return 500;
}

export function supabaseDb(url: string, serviceRoleKey: string, fetchFn: typeof fetch = fetch): Db {
  const base = url.replace(/\/+$/, "");
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new DbError(`bad function name`, 400);
      const res = await fetchFn(`${base}/rest/v1/rpc/${fn}`, {
        method: "POST",
        // New-style secret keys (sb_secret_...) go in `apikey` only; legacy service_role JWTs also as the Bearer token.
        headers: {
          apikey: serviceRoleKey,
          ...(serviceRoleKey.startsWith("sb_") ? {} : { Authorization: `Bearer ${serviceRoleKey}` }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const code = body?.code as string | undefined;
        throw new DbError(String(body?.message ?? `database error ${res.status}`).slice(0, 300), statusFor(code), code);
      }
      return body as T;
    },
  };
}
