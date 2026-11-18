-- Triangle Resells CRM v1: the team assistant (a chat in the CRM) and team notes for the DM bot.
-- The assistant acts AS the logged-in person (their login calls these functions), so everything it does is logged under
-- their name and can be undone like any other change.

-- Who's logged in (the assistant greets them and logs as them).
create or replace function whoami() returns text
language sql stable security definer set search_path = public as $$
  select name from team_members where user_id = auth.uid()
$$;

-- Things the team tells the DM bot ("the BAPE restock moved to Tuesday", "we're closed Thanksgiving").
-- The bot reads the active ones before every reply; they win over the knowledge base when they disagree.
create table if not exists bot_notes (
  id uuid primary key default gen_random_uuid(),
  note text not null check (length(trim(note)) between 1 and 1000),
  active boolean not null default true,
  expires_on date,                      -- optional: stops applying after this day (e.g. a holiday closure)
  created_by text not null default 'System',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists bot_notes_touch on bot_notes;
create trigger bot_notes_touch before update on bot_notes for each row execute function crm_touch();
drop trigger if exists bot_notes_log on bot_notes;
create trigger bot_notes_log after insert or update or delete on bot_notes for each row execute function crm_log_change();

create or replace function crm_undoable() returns text[] language sql immutable as $$
  select array['customers', 'bookings', 'booking_items', 'restocks', 'restock_items', 'bot_notes']
$$;

create or replace function add_bot_note(p_note text, p_expires_on date default null, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a text; n bot_notes;
begin
  a := crm_begin(p_actor);
  perform crm_begin(p_actor, a || ' told the bot: ' || left(trim(p_note), 120));
  insert into bot_notes (note, expires_on, created_by) values (trim(p_note), p_expires_on, a) returning * into n;
  return to_jsonb(n);
end $$;

create or replace function retire_bot_note(p_id uuid, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a text; n bot_notes;
begin
  a := crm_begin(p_actor);
  select * into n from bot_notes where id = p_id;
  if n.id is null then raise exception 'no note %', p_id using errcode = 'P0002'; end if;
  perform crm_begin(p_actor, a || ' retired a bot note: ' || left(n.note, 120));
  update bot_notes set active = false where id = p_id returning * into n;
  return to_jsonb(n);
end $$;

-- Active notes, newest first (expired ones drop off by themselves).
create or replace function bot_notes_active(p_today date default (now() at time zone 'America/New_York')::date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_team_or_service();
  return coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at desc) from bot_notes n
    where n.active and (n.expires_on is null or n.expires_on >= p_today)), '[]'::jsonb);
end $$;

alter table bot_notes enable row level security;
drop policy if exists team_read on bot_notes;
create policy team_read on bot_notes for select to authenticated using (is_team());
revoke all on bot_notes from anon, authenticated;
grant select on bot_notes to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function whoami(), add_bot_note(text, date, text), retire_bot_note(uuid, text), bot_notes_active(date) to authenticated, service_role;
