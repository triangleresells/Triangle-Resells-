/**
 * The CRM's server API, used by the AI DM bot (and later the CRM's own server tasks).
 * Plain Request -> Response, so it runs as a Netlify Function and in tests unchanged.
 *
 * Auth: `Authorization: Bearer <BOT_API_KEY>`. The key is compared in constant time and never logged or echoed.
 * Everything the bot does is logged as actor "Bot".
 */
import { timingSafeEqual } from "node:crypto";
import { DbError, type Db } from "./db.js";

export interface ApiDeps {
  db: Db;
  botApiKey: string;
  /** Where errors go (default console.error). Never given keys or request bodies. */
  log?: (line: string) => void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function keyMatches(given: string, expected: string): boolean {
  if (!expected || expected.length < 32) return false; // refuse to run with a missing or weak key
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new DbError("body must be a JSON object", 400);
}

export function createApi(deps: ApiDeps) {
  const log = deps.log ?? ((l: string) => console.error(l));
  const actor = "Bot";

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)/, "") || "/";

    if (req.method === "GET" && path === "/health") return json(200, { ok: true });

    const auth = req.headers.get("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!keyMatches(given, deps.botApiKey)) return json(401, { error: "unauthorized" });

    try {
      // Customers: the bot looks a buyer up when they DM, and records who they are.
      if (req.method === "GET" && path === "/customers/lookup") {
        const c = await deps.db.rpc("find_customer", {
          p_ig_user_id: url.searchParams.get("ig_user_id"),
          p_ig_handle: url.searchParams.get("ig_handle"),
          p_phone: url.searchParams.get("phone"),
        });
        return c ? json(200, { customer: c }) : json(404, { error: "no such customer" });
      }
      if (req.method === "POST" && path === "/customers") {
        const c = await deps.db.rpc("upsert_customer", { p: await body(req), p_actor: actor });
        return json(200, { customer: c });
      }

      // Activity log: review and undo anything.
      if (req.method === "GET" && path === "/activity") {
        const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
        const rows = await deps.db.rpc("recent_activity", {
          p_limit: limit,
          p_entity: url.searchParams.get("entity"),
          p_entity_id: url.searchParams.get("entity_id"),
        });
        return json(200, { activity: rows });
      }
      const undo = path.match(/^\/activity\/(\d+)\/undo$/);
      if (req.method === "POST" && undo) {
        const row = await deps.db.rpc("undo_activity", { p_id: Number(undo[1]), p_actor: actor });
        return json(200, { undone: row });
      }

      return json(404, { error: "not found" });
    } catch (err) {
      if (err instanceof DbError) {
        if (err.status >= 500) log(`[crm-api] ${req.method} ${path} failed: ${err.message}`);
        return json(err.status, { error: err.message });
      }
      log(`[crm-api] ${req.method} ${path} crashed: ${String(err).slice(0, 300)}`);
      return json(500, { error: "server error" });
    }
  };
}
