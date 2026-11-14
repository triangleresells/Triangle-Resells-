# Triangle DM bot: status

Last updated: 2026-11-13 evening (Claude, Windows session, branch `crm-v1`). Kept current after every step; commits are
local until Josh says push. `crm-v1` is NOT live: Render runs `ai-dm-checkout-calendar` (any push there goes live).

## Live right now
- Render bot: up, `BOT_ENABLED=false` (sends nothing), old code (no CRM). Google key is on Render: /health shows
  `"stock": "sheet"`, 37 for sale (checked 2026-11-13).
- CRM site (Netlify, `crm-v1`): up. Bot API key works. Real stock in CRM: 0 rows (fills from BOT STOCK on the first
  sync once `crm-v1` runs on Render; checked: the first sync never overwrites the sheet). TEST stock: 82 rows.
- CRM database: stock is reserved when PAID (`crm_settings.reserve_on='paid'`, live since 2026-11-14 02:49Z, from
  migrations another session applied; not in this repo, which stops at 0009). **Josh's final call: keep it.**

## Josh's decisions (2026-11-13, final)
- Stock reserved when PAID. Two buyers can book the last piece; whoever pays first gets it. When a buyer says
  "I paid" and the piece is gone, Josh's alert says GONE / likely refund (`93f4d76`). Josh refunds by hand.
- Cash = pickup today only; any later day is paid first. Bot re-reads BOT STOCK right before locking in.
- Human takeover stays: team reply pauses the chat; bot takes it back after 5 min with no team reply.
- Daily wrap-up at 10 PM ET (`667159a`).
- Meetup reminders: Josh gets buzzed 1 hour before the bot's 24h DM window closes, and texts them himself (`74a473b`).
- Don't disturb the CRM while it's being built. New spec items come after go-live.
- From the CRM session: logged-in users can't call booking_json / find_customer / crm_stock_move (bot, assistant
  and CRM pages don't; the CRM API uses the service key, still allowed). New CRM tables/views `notifications`,
  `agent_events`, `crm_sales`, `crm_stock`: the bot creates none. TEST bookings get deleted: the bot ignores them.

## Done today
| Step | Result |
|---|---|
| Typecheck + bot tests / CRM tests | pass, 153/153 and 101/101 |
| Google key (local): BOT STOCK, BOT STOCK TEST, BOT PRICES, sales tracker | all readable |
| Fix: /admin buttons changed CRM orders without telling the CRM; "Clear ALL" logged no-shows as sales | `d116c59` |
| SHADOW_MODE (drafts on /admin/shadow, sends and books nothing) | `a7ea4fd` |
| Instructions: fixes for the retest's critical mistakes | `c46baa1` |
| Reserved when paid (bot side) + "I paid" sold-out catch | `2b98810`, `93f4d76`, `dc9d574` |
| Wrap-up at 10 PM / meetup reminder buzz | `667159a` / `74a473b` |
| Live end-to-end tests detect the CRM's mode (booked or paid) | `ef9d358`; 8/8 locally (booked mode). **Live run pending** |
| AI retest, Sonnet, 50 chats | stopped at 34/50 (PC low on memory). **Re-run after the fixes** |

## Test data in the shared database
- The CRM session deletes TEST bookings and their events. The bot ignores every `is_test` CRM event (`src/crmsync.ts`,
  only tests turn `includeTest` on) and the 10 PM wrap-up counts real bookings only (`src/team/wrapup.ts`). A deleted
  TEST booking is never treated as a real cancel. TEST notifications DO go to Discord, prefixed `[TEST]`, on purpose.

## Waiting on Josh
- [ ] Live end-to-end tests + AI retest: WAIT until the CRM session finishes (it's on step e, sheet stock sync). The live
      tests delete every TEST row in the shared database, and two sessions at once ran the PC out of memory. `.env` has
      E2E_EMAIL / E2E_PASSWORD already.
- [ ] One Claude session only, then: AI retest re-run (~$4) and live end-to-end tests.
- [ ] Confirm Render env from go-live step 4 (`CRM_API_URL`, `HANDOFF_WEBHOOK_URL`, Supabase keys...).

## AI retest critical mistakes (34 chats), fixed in the instructions (`c46baa1`), not yet re-tested
- Told 2 ready buyers the Cash App tag `$triangleresells` "wasn't confirmed" (one told to stop paying).
- Invented "you can look it over at pickup" before paying cash.
- Said "Today at 6 PM is open" without the schedule (time had passed).
- Promised "Josh will send the pics here".
- Invented what's in a Lululemon set; said Supreme can't be bought before it lands (deposits exist).
- Said "I put you down for one" without saving it.

## Go-live checklist (docs/go-live.md): where it stands
- Steps 1-4 DONE: Google key, BOT STOCK TEST tab, Supabase, Netlify (https://venerable-marigold-a0d29b.netlify.app).
- Live CRM test run (8/8) and the 18-step browser walkthrough passed earlier on 2026-11-13. That was BEFORE the
  reserve-at-paid change, so test 7 needs a re-run.
- **NEXT = step 5, Render env vars (by hand).** Run the clipboard helper in PowerShell and paste each value into
  Render > triangle-ai-dm > Environment:
  `powershell -ExecutionPolicy Bypass -File "C:\Users\kenta\AppData\Local\Temp\claude\9519414f725d5b3e\514abed5-3e8d-4adf-88c7-2250d3e901e8\scratchpad\render-env.ps1"`
  (if that temp file is gone, ask Claude to recreate it). Names: CRM_API_URL, CRM_BOT_API_KEY, CRM_ASSIGNEE (Chema),
  CRM_WEB_ORIGIN, SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, WAREHOUSE_SHEET_ID, TRACKER_SHEET_ID,
  plus HANDOFF_WEBHOOK_URL (Discord channel webhook, make it in Discord; empty in .env). Keep BOT_ENABLED=false.
- Then: AI retest (~$4, approved), merge crm-v1 into ai-dm-checkout-calendar (needs Josh), BOT_ENABLED=true,
  `npm run import-sales` preview, then `-- --commit` after Josh approves.
- **Repo gap:** 5 migrations applied straight to live Supabase via MCP (2026-11-14 02:30Z-02:51Z:
  crm_additive_1_tenancy_roles_settings, crm_additive_2_notifications, crm_behavior_changes, crm_rls_business_scope,
  crm_lock_internal_functions) are NOT in crm/supabase/migrations. Export them into the repo before anyone re-runs
  setup.sql, which would otherwise wipe them out.
- Small: the "Powered by Netlify" badge covers content on phones (check the Netlify site settings).

## Later (after go-live): new items from the upgrade spec
Save every DM in the database; which video each chat came from (+ asking new buyers once); per-video results
(chats, bookings, revenue); learning loop (bot proposes answers, team approves in the CRM); top questions of the week
for video ideas; a problems log (`agent_events`) that buzzes Josh; kill switch in the CRM; round-robin Chema/Diego.
Each needs new tables in the shared database: coordinate with the CRM session.
