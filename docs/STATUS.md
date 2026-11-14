# Triangle DM bot: status

Last updated: 2026-11-13 (Claude, Windows session, branch `crm-v1`). Kept current after every step; commits are local
until Josh says push. `crm-v1` is NOT live: Render runs `ai-dm-checkout-calendar` (any push there goes live).

## Live right now
- Render bot: up, `BOT_ENABLED=false` (sends nothing), old code (no CRM). Reads the **snapshot**, not the sheet:
  the Google key isn't on Render yet.
- CRM site (Netlify, `crm-v1`): up. Bot API key works. Real stock in CRM: 0 rows (fills from BOT STOCK on the first
  sync once `crm-v1` runs on Render; checked: the first sync never overwrites the sheet). TEST stock: 82 rows.

## Done today
| Step | Result |
|---|---|
| Typecheck + bot tests | pass, 151/151 |
| CRM tests (incl. 8 end-to-end scenarios on a local database) | pass, 101/101 (before the reservation migration) |
| Google key (local): BOT STOCK, BOT STOCK TEST, BOT PRICES, sales tracker | all readable |
| Fix: /admin buttons changed CRM orders without telling the CRM (stuck reservations, double tracker rows) | fixed, `d116c59` |
| Fix: "Clear ALL labels" logged unpaid no-shows as sales | fixed, `d116c59` |
| Reservation moves to "when paid" (bot side) | done, `a7ea4fd` |
| SHADOW_MODE (drafts on /admin/shadow, sends and books nothing) | done, `a7ea4fd` |
| AI retest, Sonnet, 50 chats | **stopped at 34/50** (PC ran low on memory). 27/34 had no critical mistake (79%; last time 92%) |

## Reservation at payment: what in the bot depended on reservation at booking
1. Last-unit protection: the CRM refused a booking for a piece already reserved. Now the bot re-reads BOT STOCK
   (no cache) right before locking in. Gap: the sheet trails the CRM by up to ~1 min (sync interval), and two unpaid
   bookings for the last piece are possible; whoever pays first gets it. A buyer who pays for a piece that sold in the
   meantime needs a refund by hand (depends on what the CRM does on Paid with no stock: not known yet).
2. CRM-down fallback took stock off the sheet at booking: now at paid / done.
3. Instructions said "locked in = off the sheet": changed.
4. Cash on a later day was booked unpaid: now cash = pickup today only; later days pay first.
5. `scripts/e2e/run.ts` live tests 1, 3, 4, 7 assume reservation at booking: **to update once the CRM migration is
   in this repo** (not here yet; newest is 0009).

## Waiting on Josh
- [ ] Google key on Render (`GOOGLE_SERVICE_ACCOUNT_JSON`), then /health should say `"stock": "sheet"`.
- [ ] `E2E_EMAIL` / `E2E_PASSWORD` in `.env` (a CRM login) for the live end-to-end tests.
- [ ] OK to fix the AI retest's critical mistakes in `config/agent-instructions.md` (below), then re-run (~$4) with
      only one Claude session open.
- [ ] Confirm Render env from go-live step 4 (`CRM_API_URL`, `HANDOFF_WEBHOOK_URL`, Supabase keys...).
- [ ] Decide on the upgrade spec (below).

## AI retest critical mistakes (34 chats)
- Told 2 ready buyers the Cash App tag `$triangleresells` "wasn't confirmed" (one told to stop paying).
- Invented "you can look it over at pickup" before paying cash.
- Said "Today at 6 PM is open" without the schedule (time had passed).
- Promised "Josh will send the pics here".
- Invented what's in a Lululemon set; said Supreme can't be bought before it lands (deposits exist).
- Said "I put you down for one" without saving it.

## Upgrade spec (pasted 2026-11-13): what exists vs. new
The spec was written for a ManyChat bot. This bot talks to Meta's Instagram API directly (no ManyChat). Where it
conflicts with current rules, the current rule stays (the spec says so) until Josh decides.

| Spec item | Today | Plan |
|---|---|---|
| Kill switch | `BOT_ENABLED` on Render (restart ~1 min). No ManyChat | Could add a CRM toggle; needs a CRM-session table |
| Human takeover | Team reply pauses the chat 12h; bot takes back after 5 min of no team reply | **Conflict** (spec: 24h, no takeover). Kept current |
| SHADOW_MODE | **Built** | Run it on Render before going live |
| No inventing / injection / no Stripe | In instructions; Stripe off | Retest found invention slips: fix instructions |
| Booking into CRM | Bot writes `bookings` (dollars) via the CRM API | Spec's `sales` table with cents would duplicate it. Kept `bookings` |
| Fulfiller | `CRM_ASSIGNEE=Chema` | Round-robin is new |
| Meetup reminders | None | Instagram only lets the bot DM within 24h of the buyer's last message: a day-before reminder often can't be sent |
| Notifications | CRM `team_notifications` → bot posts to Discord | **Conflict** (spec: CRM owns push). Kept |
| Stock writes | CRM owns counts; the bot process writes them to the sheet | **Conflict** (spec: bot only reads) |
| Daily digest | 10:30 PM wrap-up | **Conflict** (spec: 8 PM). Kept |
| Conversations/messages in Supabase, attribution, learning loop, agent_events, top_questions | New | Each needs new tables on the shared database: coordinate with the CRM session |
