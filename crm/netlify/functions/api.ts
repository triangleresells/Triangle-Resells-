/**
 * Netlify Function: https://<crm-site>/api/* -> the CRM API (src/api/handler.ts).
 * Env (Netlify site settings, never committed): SUPABASE_URL, SUPABASE_ANON_KEY (public), SUPABASE_SERVICE_ROLE_KEY,
 * CRM_BOT_API_KEY.
 */
import { supabaseDb } from "../../src/api/db.js";
import { createApi } from "../../src/api/handler.js";

const url = process.env.SUPABASE_URL ?? "";
const anonKey = process.env.SUPABASE_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const botKey = process.env.CRM_BOT_API_KEY ?? "";

const handle = createApi({ db: supabaseDb(url, serviceKey), botApiKey: botKey, publicConfig: { supabaseUrl: url, anonKey } });

export default async (req: Request) => {
  if (!url || !serviceKey || !botKey || !anonKey) {
    console.error("[crm-api] missing SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY or CRM_BOT_API_KEY");
    return new Response(JSON.stringify({ error: "server not configured" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  return handle(req);
};

export const config = { path: "/api/*" };
