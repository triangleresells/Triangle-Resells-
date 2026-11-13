/**
 * The brief's 8 end-to-end tests against the LIVE CRM (Supabase + Netlify), TEST data only, then every TEST row is
 * deleted and a short report is printed. Run it once everything in docs/go-live.md steps 1-4 is set up:
 *
 *   npm run e2e-live
 *
 * Needs in .env: CRM_API_URL, CRM_BOT_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, and a team login to act as:
 * E2E_EMAIL / E2E_PASSWORD (Josh's, Chema's or Diego's CRM login). The BOT STOCK TEST tab must be synced.
 */
import { existsSync } from "node:fs";
import { loadPricing } from "../src/config.js";
import { crmClient } from "../src/crm.js";
import { supabaseUserDb } from "../src/team/assistant.js";
import { reportText, runE2E } from "./e2e/run.js";

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const need = ["CRM_API_URL", "CRM_BOT_API_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY", "E2E_EMAIL", "E2E_PASSWORD"];
  const missing = need.filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(", ")}. Nothing was run.`);
    process.exit(1);
  }
  const env = (k: string) => process.env[k]!.trim();
  // Log in as a team member (their real CRM login) for the team's side of the tests.
  const login = await fetch(`${env("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env("SUPABASE_ANON_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ email: env("E2E_EMAIL"), password: env("E2E_PASSWORD") }),
  });
  const session = (await login.json()) as { access_token?: string; error_description?: string };
  if (!session.access_token) {
    console.error(`Couldn't log in as ${env("E2E_EMAIL")}: ${session.error_description ?? login.status}`);
    process.exit(1);
  }
  const team = supabaseUserDb(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), session.access_token);
  const teamName = await team.rpc<string | null>("whoami", {});
  if (!teamName) {
    console.error("That login isn't linked to Josh, Chema or Diego in the CRM (see docs/go-live.md step 2).");
    process.exit(1);
  }
  const base = env("CRM_API_URL").replace(/\/+$/, "");
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${env("CRM_BOT_API_KEY")}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };
  console.log(`Running the end-to-end tests as ${teamName} against ${base} (TEST data only)...\n`);
  const r = await runE2E({ crm: crmClient(base, env("CRM_BOT_API_KEY")), api, team, teamName, pricing: loadPricing(), now: new Date() });
  console.log(reportText(r));
  process.exit(r.results.every((x) => x.pass) ? 0 : 1);
}

main().catch((err) => {
  console.error("The end-to-end run crashed:", (err as Error).message ?? err);
  process.exit(1);
});
