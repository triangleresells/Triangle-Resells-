-- Triangle Resells CRM v1: CRM -> bot. Every booking change a PERSON makes (not the bot itself) lands in an outbox the
-- bot reads every few seconds, so the bot's order, the Google Calendar event and the stock follow the CRM.
-- The bot's own changes are skipped (it already did them), so nothing loops.

create table if not exists bot_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  booking_id uuid not null,
  kind text not null check (kind in ('created', 'updated', 'deleted')),
  actor text not null,
  booking jsonb not null,            -- the booking as it is now (with customer and items); for 'deleted', as it was
  previous jsonb,                    -- the booking row before the change (no items), for 'updated'
  is_test boolean not null default false
);
create index if not exists bot_events_booking_idx on bot_events (booking_id);

-- Runs at COMMIT (deferred), so the snapshot has the final items even when items were replaced in the same edit.
create or replace function crm_bot_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text := crm_actor(); snap jsonb;
begin
  if a = 'Bot' then return null; end if;
  if tg_op = 'DELETE' then
    insert into bot_events (booking_id, kind, actor, booking, is_test) values (old.id, 'deleted', a, to_jsonb(old), old.is_test);
    return null;
  end if;
  snap := booking_json(new.id);
  if snap is null then return null; end if;      -- deleted again later in the same transaction
  insert into bot_events (booking_id, kind, actor, booking, previous, is_test)
  values (new.id, case when tg_op = 'INSERT' then 'created' else 'updated' end, a, snap,
          case when tg_op = 'UPDATE' then to_jsonb(old) end, new.is_test);
  return null;
end $$;

drop trigger if exists bookings_bot_event on bookings;
create constraint trigger bookings_bot_event after insert or update on bookings
  deferrable initially deferred for each row execute function crm_bot_event();
drop trigger if exists bookings_bot_event_delete on bookings;
create trigger bookings_bot_event_delete after delete on bookings for each row execute function crm_bot_event();

-- The bot asks: "what changed after event N?" First call with p_after = null just returns the newest id to start from.
create or replace function bot_events_after(p_after bigint, p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'bot only' using errcode = '42501'; end if;
  if p_after is null then
    return jsonb_build_object('events', '[]'::jsonb, 'latest', coalesce((select max(id) from bot_events), 0));
  end if;
  return jsonb_build_object(
    'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from (
      select * from bot_events where id > p_after order by id limit least(greatest(p_limit, 1), 500)) e), '[]'::jsonb),
    'latest', coalesce((select max(id) from bot_events), 0));
end $$;

-- What the AI sees before it answers a buyer: their bookings that aren't finished (CRM is the source of truth).
create or replace function open_bookings_for(p_ig_user_id text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not is_team() then
    raise exception 'not a team member' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(booking_json(b.id) order by b.date, b.time nulls last)
    from bookings b join customers c on c.id = b.customer_id
    where c.ig_user_id = p_ig_user_id and b.status in ('booked', 'paid', 'paid_needs_check')
  ), '[]'::jsonb);
end $$;

alter table bot_events enable row level security;
revoke all on bot_events from anon, authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function bot_events_after(bigint, integer) to service_role;
grant execute on function open_bookings_for(text) to authenticated, service_role;
