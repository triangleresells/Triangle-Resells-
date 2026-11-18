-- Bot reliability (Nov 2026: Instagram rejected the bot's replies for ~15 hours and nobody knew).
-- ADDITIVE ONLY: one new table + one new read function. No existing table, view or function is changed.
-- Documented in docs/schema.md.

-- Every Instagram send the bot could NOT deliver, plus where an outage started/ended and the catch-up replies after it.
create table if not exists bot_send_log (
  id bigserial primary key,
  business_id uuid not null default '7a1a0000-0000-4000-8000-000000000001',
  account text not null,                       -- which Instagram account sent it (triangleresells, trianglescales, ...)
  kind text not null check (kind in (
    'send_failed',          -- Instagram rejected a send (token, permissions, Instagram down): counts toward an outage
    'recipient_rejected',   -- rejected for this one buyer only (outside the 24h window, blocked, gone): not an outage
    'outage_started',       -- first failed send after a working one: the team got ONE push
    'outage_ended',         -- first successful send after an outage
    'catch_up_sent'         -- after an outage: a "Sorry for the wait!" reply to a buyer still inside the 24h window
  )),
  ig_user_id text,
  error text,                                  -- Instagram's error message (never contains the token)
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists bot_send_log_created_idx on bot_send_log (created_at desc);
create index if not exists bot_send_log_kind_idx on bot_send_log (account, kind, created_at desc);

alter table bot_send_log enable row level security;
drop policy if exists team_read on bot_send_log;
create policy team_read on bot_send_log for select to authenticated using (is_team());
grant select on bot_send_log to authenticated;
grant all on bot_send_log to service_role;
grant usage, select on sequence bot_send_log_id_seq to service_role;

-- The numbers for the bot's daily health push (one local day in p_tz). Test data never counts.
-- Section 10 (hot buyers, payments, conversion) adds its numbers to this function later.
create or replace function bot_daily_health(p_day date, p_tz text default 'America/New_York', p_account text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with b as (select (p_day::timestamp at time zone p_tz) as s, ((p_day + 1)::timestamp at time zone p_tz) as e)
  select jsonb_build_object(
    'day', p_day,
    'messages_handled', (select count(*) from messages m, b where m.role = 'customer' and not m.is_test and m.created_at >= b.s and m.created_at < b.e),
    'buyers', (select count(distinct m.conversation_id) from messages m, b where m.role = 'customer' and not m.is_test and m.created_at >= b.s and m.created_at < b.e),
    'failed_sends', (select count(*) from bot_send_log l, b where l.kind in ('send_failed', 'recipient_rejected') and not l.is_test
                       and (p_account is null or l.account = p_account) and l.created_at >= b.s and l.created_at < b.e),
    'outages', (select count(*) from bot_send_log l, b where l.kind = 'outage_started' and not l.is_test
                  and (p_account is null or l.account = p_account) and l.created_at >= b.s and l.created_at < b.e),
    'handoffs', (select count(*) from notifications n, b where n.type = 'needs_human' and not coalesce(n.is_test, false)
                   and n.created_at >= b.s and n.created_at < b.e)
  ) from b;
$$;
revoke all on function bot_daily_health(date, text, text) from public, anon, authenticated;
grant execute on function bot_daily_health(date, text, text) to service_role;
