# Shared Supabase schema: who owns what

One Supabase project (`xhfosuglqvjpfhvouvbh`) is shared by **the bot** (this repo), **the phone CRM**
(triangle-crm-q08b, another repo) and **the video editor** (later). Read this before creating a table, so two
windows never create the same thing twice.

**Rules**
- Migrations are additive only. Never drop, rename or alter an existing CRM table or view.
- Every schema change gets written here first, then the migration (bot migrations: `crm/supabase/migrations/`).
- The bot writes with the service key (server-side only). Team logins read through RLS (`is_team()`).
- Test rows have `is_test = true` and never count in reports.

## Tables the bot owns (created from this repo)

| Table / function | Migration | What it's for |
|---|---|---|
| `conversations`, `messages`, `knowledge_base` | 0010 | Chats + Knowledge tabs: every DM, Take over, approved answers |
| `app_conversation_silence()`, `app_knowledge_review()` | 0010 | Take over / Release, Approve / Reject from the app |
| `bot_send_log` | 0011 | Every Instagram send that failed, outage start/end, "Sorry for the wait!" catch-ups |
| `bot_daily_health(day, tz, account)` | 0011 | Numbers for the bot's daily health push (service key only) |

### `bot_send_log` (0011, Nov 17 2026)
| Column | Type | Notes |
|---|---|---|
| id | bigserial | |
| business_id | uuid | default Triangle |
| account | text | which Instagram account (`triangleresells`, `trianglescales`, `trianglesales`) |
| kind | text | `send_failed`, `recipient_rejected`, `outage_started`, `outage_ended`, `catch_up_sent` |
| ig_user_id | text | the buyer, when there is one |
| error | text | Instagram's error message (never the token) |
| is_test | boolean | |
| created_at | timestamptz | |

`send_failed` = Instagram rejected the bot (token, permissions, Instagram down): it counts toward an outage.
`recipient_rejected` = rejected for one buyer only (outside the 24h window, blocked): logged, no alert.

### `bot_daily_health(p_day date, p_tz text, p_account text)` returns jsonb
`{ day, messages_handled, buyers, failed_sends, outages, handoffs }`. Section 10 adds hot buyers, payments and
conversion to it later (`create or replace`, same name).

## Tables the CRM owns (the bot only reads or writes through them)

| Table | Bot uses it for |
|---|---|
| `notifications` | Phone pushes to Josh, Chema and Diego (bot inserts; `dedupe_key` is unique, repeats are dropped) |
| `bookings`, `customers`, `bot_events` (booking history log) | Orders through the CRM API (`CRM_API_URL`) |
| `bot_notes` | TEAM NOTES the bot reads before every reply |
| `deposits` | Deposits (section 4: the bot will record them here) |
| `restocks`, `restock_items` | Incoming stock (section 5: the bot will read these; already exist, empty) |
| `agent_events` | CRM app errors/warnings |

`bot_events` is the CRM's booking history log, not a bot log. Bot reliability goes in `bot_send_log`.
