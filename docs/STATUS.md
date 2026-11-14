# Triangle DM bot: status

Last updated: 2026-11-13 evening (Claude, Windows session, branch `crm-v1`). Kept current after every step; commits are
local until Josh says push. `crm-v1` is NOT live: Render runs `ai-dm-checkout-calendar` (any push there goes live).

## Live right now
- Render bot: up, `BOT_ENABLED=false` (sends nothing), old code (no CRM). Reads the **snapshot**, not the sheet:
  the Google key isn't on Render yet.
- CRM site (Netlify, `crm-v1`): up. Bot API key works. Real stock in CRM: 0 rows (fills from BOT STOCK on the first
  sync once `crm-v1` runs on Render; checked: the first sync never overwrites the sheet). TEST stock: 82 rows.
- **CRM database: stock is reserved when PAID right now** (`crm_settings.reserve_on='paid'`, set 2026-11-14 02:49Z by
  migrations applied from another session, not in this repo). So the CRM does NOT refuse a 2nd booking for the last
  piece. Josh decided: back to reserved at booking. Fix = `reserve_on='booked'` (CRM session, waiting on Josh's OK),
  plus checking unpaid bookings made since 02:49Z (they hold no stock).

**Open conflict:** a later FYI relayed from the CRM session says "reservation changed to reserved when paid, re-run
your booking tests". That contradicts Josh's decision below. The bot stays on reserved-at-booking until Josh confirms
which one he wants. Same FYI: logged-in users can't call booking_json / find_customer / crm_stock_move anymore
(checked: the bot, the team assistant and the CRM pages don't; the CRM API calls find_customer with the service key,
still allowed); new CRM tables/views `notifications`, `agent_events`, `crm_sales`, `crm_stock` (the bot creates none).

## Josh's decisions (2026-11-13)
- Stock reserved at BOOKING (never two buyers paying for the last piece). Bot side: `b2a6ac6`.
- Cash = pickup today only; any later day is paid first. Bot re-reads BOT STOCK right before locking in.
- Human takeover stays: team reply pauses the chat; bot takes it back after 5 min with no team reply.
- Daily wrap-up at 10 PM ET (`667159a`).
- Meetup reminders: Josh gets buzzed 1 hour before the bot's 24h DM window closes, and texts them himself (`74a473b`).
- New spec items (conversation logging, attribution, learning loop...) come later, after go-live.

## Done today
| Step | Result |
|---|---|
| Typecheck + bot tests | pass, 152/152 |
| CRM tests (incl. 8 end-to-end scenarios on a local database) | pass, 101/101 |
| Google key (local): BOT STOCK, BOT STOCK TEST, BOT PRICES, sales tracker | all readable |
| Fix: /admin buttons changed CRM orders without telling the CRM; "Clear ALL" logged no-shows as sales | `d116c59` |
| SHADOW_MODE (drafts on /admin/shadow, sends and books nothing) | `a7ea4fd` |
| Instructions: fixes for the retest's critical mistakes | `c46baa1` |
| Back to reserved-at-booking (bot side) | `b2a6ac6` |
| Wrap-up at 10 PM | `667159a` |
| Meetup reminder buzz | `74a473b` |
| AI retest, Sonnet, 50 chats | stopped at 34/50 (PC low on memory). 27/34 no critical mistake. **Re-run after the fixes** |

## Test data in the shared database
- The CRM session deletes TEST bookings and their events. The bot ignores every `is_test` CRM event (`src/crmsync.ts`,
  only tests turn `includeTest` on) and the 10 PM wrap-up counts real bookings only (`src/team/wrapup.ts`). A deleted
  TEST booking is never treated as a real cancel. TEST notifications DO go to Discord, prefixed `[TEST]`, on purpose.

## Waiting on Josh
- [ ] OK the CRM session to set `reserve_on='booked'` (live end-to-end test 7 fails until then).
- [ ] Google key on Render (`GOOGLE_SERVICE_ACCOUNT_JSON`), then /health should say `"stock": "sheet"`.
- [ ] `E2E_EMAIL` / `E2E_PASSWORD` in `.env` (a CRM login) for the live end-to-end tests.
- [ ] One Claude session only, then: AI retest re-run (~$4) and live end-to-end tests.
- [ ] Confirm Render env from go-live step 4 (`CRM_API_URL`, `HANDOFF_WEBHOOK_URL`, Supabase keys...).

## AI retest critical mistakes (34 chats), fixed in the instructions (`c46baa1`), not yet re-tested
- Told 2 ready buyers the Cash App tag `$triangleresells` "wasn't confirmed" (one told to stop paying).
- Invented "you can look it over at pickup" before paying cash.
- Said "Today at 6 PM is open" without the schedule (time had passed).
- Promised "Josh will send the pics here".
- Invented what's in a Lululemon set; said Supreme can't be bought before it lands (deposits exist).
- Said "I put you down for one" without saving it.

## Later (after go-live): new items from the upgrade spec
Save every DM in the database; which video each chat came from (+ asking new buyers once); per-video results
(chats, bookings, revenue); learning loop (bot proposes answers, team approves in the CRM); top questions of the week
for video ideas; a problems log (`agent_events`) that buzzes Josh; kill switch in the CRM; round-robin Chema/Diego.
Each needs new tables in the shared database: coordinate with the CRM session.
