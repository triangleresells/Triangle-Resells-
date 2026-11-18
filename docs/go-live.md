# Triangle Resells: going live (DM bot + CRM)

Everything below is on the `crm-v1` branch. The live bot (Render, branch `ai-dm-checkout-calendar`) doesn't have it yet.
Do the steps in order. Never paste a key into a chat; keys go only into the dashboards below (and your local `.env`).

## 1. Google (stock sync, sales tracker, old sales import)
- [ ] Service account key created (Google Cloud, project `triangle-bot`; turn off the org policy
      `iam.disableServiceAccountKeyCreation` for that project only if key creation is blocked).
- [ ] Key saved with the `set-google-key.ps1` helper Claude gave you (puts it in `.env`, copies it for Render).
- [ ] Both sheets shared with the service account email as **Editor**: TRIANGLERESELLS WAREHOUSE STOCK and Triangle_Resells_Sales_Tracker.
- [ ] A copy of the BOT STOCK tab named exactly **`BOT STOCK TEST`** (test bookings only ever use this).
- [ ] Calendar script (`scripts/google-calendar.gs`) pasted as a **New version** of the existing deployment (same URL).

## 2. Supabase (the CRM database)
- [ ] Project `triangle-crm`, Free plan, region East US.
- [ ] SQL Editor → New query → paste **all of `crm/supabase/setup.sql`** → Run. (One paste; safe to run again.)
- [ ] Authentication → Sign In / Providers: Email on, **"Allow new users to sign up" off**.
- [ ] Authentication → Users → Add user (auto confirm) for Josh, Chema, Diego; then link them (SQL Editor):
  ```sql
  update team_members t set user_id = u.id, email = u.email from auth.users u
  where (t.name = 'Josh' and lower(u.email) = lower('JOSH_EMAIL'))
     or (t.name = 'Chema' and lower(u.email) = lower('CHEMA_EMAIL'))
     or (t.name = 'Diego' and lower(u.email) = lower('DIEGO_EMAIL'));
  select name, email, user_id is not null as linked from team_members;
  ```
- [ ] From Project Settings → API keys, you'll need: the **Project URL**, the **publishable / anon** key (public) and the
      **secret / service_role** key (secret). Either the new `sb_...` keys or the legacy ones work.

## 3. Netlify (the CRM website + its API)
- [ ] New site from GitHub `triangleresells/triangle-resells-`, branch `crm-v1` (later: the live branch),
      **Base directory `crm`** (the rest comes from `crm/netlify.toml`).
- [ ] Site settings → Environment variables:

| Name | Value | Secret? |
|---|---|---|
| `SUPABASE_URL` | Supabase Project URL | no |
| `SUPABASE_ANON_KEY` | publishable / anon key | no (public by design) |
| `SUPABASE_SERVICE_ROLE_KEY` | secret / service_role key | **yes** |
| `CRM_BOT_API_KEY` | a long random string you make up (40+ characters) | **yes** |
| `BOT_ASSISTANT_URL` | the bot's Render address, e.g. `https://triangle-ai-dm.onrender.com` | no |

- [ ] Supabase → Authentication → URL Configuration → Site URL = the Netlify site address.

## 4. Render (the DM bot)
Environment → add:

| Name | Value |
|---|---|
| `CRM_API_URL` | the Netlify site address |
| `CRM_BOT_API_KEY` | the same long random string as on Netlify |
| `CRM_ASSIGNEE` | `Chema` (who bot bookings go to) |
| `SUPABASE_URL` | Supabase Project URL (for the assistant) |
| `SUPABASE_ANON_KEY` | publishable / anon key (for the assistant) |
| `CRM_WEB_ORIGIN` | the Netlify site address (only that site may use the assistant) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | from `set-google-key.ps1` |
| `HANDOFF_WEBHOOK_URL` | Discord / Slack webhook (alerts, notifications, 10:30 PM wrap-up) |

Already set: `CLAUDE_MODEL=claude-sonnet-5-5`, `IG_APP_SECRET` (32 characters), `FREEBIES_ENABLED=false`, `TAKEOVER_MINUTES=5`.
Keep `BOT_ENABLED=false` until step 6.

## 5. Checks (Claude runs these; nothing real is changed)
- [ ] `https://<bot>/health` shows `"stock": "sheet"` (Google key works).
- [ ] CRM site: log in as each of Josh, Chema, Diego. A non-team login is refused.
- [ ] Sonnet AI retest of the bot (about $4 of API credit).
- [ ] Live end-to-end tests from the brief, with TEST data only (BOT STOCK TEST, buyers named "TEST..."):
  1. bot books a pickup → in the calendar, customer made, test stock reserved, notification posted
  2. bot reschedules → moved, log says "Bot rescheduled"
  3. bot cancels → bright red, test stock back
  4. team adds an in-person sale → same checks
  5. Paid then Done (with "yes") → revenue, profit, drill-down, cash per person add up to the cent
  6. shipped order → tracking saved and DMed to the buyer
  7. two bookings for the last unit → second refused, never negative
  8. CRM down / bad data → nothing half-saved, error logged, team alerted
- [ ] Delete all TEST data (`delete_test_data`), then a short report: passed / failed / fixed.
- [ ] Old sales: `npm run import-sales` (preview) → Josh checks it → `npm run import-sales -- --commit`.

## 6. Go live
- [ ] Merge `crm-v1` into `ai-dm-checkout-calendar` (Render redeploys), Netlify switched to the same branch.
- [ ] `BOT_ENABLED=true` on Render.

## Waiting after go-live
- Phase 6 (AI video editor + Reel posting): `docs/phase6-video-editor.md`. Starts only once everything above is done.
