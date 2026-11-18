-- Triangle Resells CRM v1, phase 1: team, customers, activity log, undo.
-- Every write goes through a function below, so the change and its activity-log line happen in ONE transaction:
-- if anything fails, nothing is half-saved.
--
-- Who did it ("actor"):
--   * Josh / Chema / Diego logged in to the CRM: taken from their Supabase login (auth.uid() -> team_members).
--   * The bot (and server scripts) call with the service-role key and pass p_actor ('Bot', 'System'...).
--     Only the service role may name an actor; a logged-in person can never pretend to be someone else.

-- ---------- team ----------
create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique,               -- the person's Supabase login (auth.users.id), linked once they sign up
  name text not null unique check (name in ('Josh', 'Chema', 'Diego')),
  email text unique,
  created_at timestamptz not null default now()
);
insert into team_members (name) values ('Josh'), ('Chema'), ('Diego') on conflict (name) do nothing;

-- ---------- customers ----------
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  ig_user_id text unique,            -- Instagram's id for the buyer (what the bot sees)
  ig_handle text,                    -- stored without "@", lowercase
  name text,
  phone text,
  dm_conversations integer not null default 0,
  notes text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists customers_ig_handle_key on customers (ig_handle) where ig_handle is not null;
create index if not exists customers_phone_idx on customers (phone) where phone is not null;

-- ---------- activity log ----------
create table if not exists activity_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,               -- Josh / Chema / Diego / Bot / System
  action text not null check (action in ('create', 'update', 'delete')),
  entity text not null,              -- table name, e.g. customers, bookings
  entity_id text,
  summary text,                      -- short human line, e.g. "Bot rescheduled TEST buyer to 11/20/2026"
  before jsonb,
  after jsonb,
  changes jsonb,                     -- {field: {from, to}} for updates
  undo_of bigint references activity_log (id),
  is_test boolean not null default false
);
create index if not exists activity_log_at_idx on activity_log (at desc);
create index if not exists activity_log_entity_idx on activity_log (entity, entity_id);

-- ---------- who is acting ----------
create or replace function crm_actor() returns text
language plpgsql stable security definer set search_path = public as $$
declare a text;
begin
  a := nullif(current_setting('crm.actor', true), '');
  if a is not null then return a; end if;
  select name into a from team_members where user_id = auth.uid();
  return coalesce(a, 'System');
end $$;

-- Called at the start of every write function. Only the service role (bot / server) may name the actor.
create or replace function crm_begin(p_actor text, p_summary text default null) returns text
language plpgsql security definer set search_path = public as $$
declare a text;
begin
  if coalesce(auth.role(), '') = 'service_role' and p_actor is not null then
    if p_actor not in ('Bot', 'System', 'Josh', 'Chema', 'Diego') then
      raise exception 'unknown actor %', p_actor using errcode = '22023';
    end if;
    perform set_config('crm.actor', p_actor, true);
  else
    -- A logged-in person: must be on the team.
    if not exists (select 1 from team_members where user_id = auth.uid()) then
      raise exception 'not a team member' using errcode = '42501';
    end if;
    perform set_config('crm.actor', '', true);
  end if;
  perform set_config('crm.summary', coalesce(p_summary, ''), true);
  a := crm_actor();
  return a;
end $$;

-- Generic trigger: one activity-log line per insert / update / delete, with before, after and the changed fields.
create or replace function crm_log_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb; ch jsonb;
begin
  if tg_op = 'INSERT' then
    n := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    o := to_jsonb(old); n := to_jsonb(new);
    select jsonb_object_agg(key, jsonb_build_object('from', o -> key, 'to', value)) into ch
      from jsonb_each(n) where key <> 'updated_at' and (o -> key) is distinct from value;
    if ch is null then return new; end if;     -- nothing really changed: no log line
  else
    o := to_jsonb(old);
  end if;
  insert into activity_log (actor, action, entity, entity_id, summary, before, after, changes, undo_of, is_test)
  values (
    crm_actor(), case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end, tg_table_name, coalesce(n ->> 'id', o ->> 'id'),
    nullif(current_setting('crm.summary', true), ''), o, n, ch,
    nullif(current_setting('crm.undo_of', true), '')::bigint,
    coalesce((coalesce(n, o) ->> 'is_test')::boolean, false)
  );
  return coalesce(new, old);
end $$;

create or replace function crm_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists customers_log on customers;
create trigger customers_log after insert or update or delete on customers for each row execute function crm_log_change();
drop trigger if exists customers_touch on customers;
create trigger customers_touch before update on customers for each row execute function crm_touch();

-- ---------- customers API ----------
create or replace function crm_norm_handle(h text) returns text language sql immutable as $$
  select nullif(lower(regexp_replace(trim(coalesce(h, '')), '^@+', '')), '')
$$;

-- Find a customer by Instagram id, then handle, then phone. Returns null when unknown.
create or replace function find_customer(p_ig_user_id text default null, p_ig_handle text default null, p_phone text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(c) from customers c
  where (p_ig_user_id is not null and c.ig_user_id = p_ig_user_id)
     or (crm_norm_handle(p_ig_handle) is not null and c.ig_handle = crm_norm_handle(p_ig_handle))
     or (nullif(trim(p_phone), '') is not null and c.phone = trim(p_phone))
  order by (c.ig_user_id = p_ig_user_id) desc nulls last, (c.ig_handle = crm_norm_handle(p_ig_handle)) desc nulls last
  limit 1
$$;

-- Create the customer, or fill in what's new on the existing one. Never blanks out a field that's already set.
create or replace function upsert_customer(p jsonb, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare found jsonb; c customers; h text := crm_norm_handle(p ->> 'ig_handle');
begin
  perform crm_begin(p_actor);
  found := find_customer(p ->> 'ig_user_id', h, p ->> 'phone');
  if found is null then
    insert into customers (ig_user_id, ig_handle, name, phone, notes, is_test)
    values (nullif(p ->> 'ig_user_id', ''), h, nullif(trim(p ->> 'name'), ''), nullif(trim(p ->> 'phone'), ''),
            nullif(trim(p ->> 'notes'), ''), coalesce((p ->> 'is_test')::boolean, false))
    returning * into c;
  else
    update customers set
      ig_user_id = coalesce(ig_user_id, nullif(p ->> 'ig_user_id', '')),
      ig_handle  = coalesce(h, ig_handle),
      name       = coalesce(nullif(trim(p ->> 'name'), ''), name),
      phone      = coalesce(nullif(trim(p ->> 'phone'), ''), phone),
      notes      = coalesce(nullif(trim(p ->> 'notes'), ''), notes)
    where id = (found ->> 'id')::uuid
    returning * into c;
  end if;
  return to_jsonb(c);
end $$;

-- ---------- undo ----------
-- Reverses one activity-log line: a create is deleted, a delete is put back, an update is set back to "before".
-- The undo is itself logged (undo_of = the line it reversed). Only tables listed here can be undone.
create or replace function undo_activity(p_id bigint, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l activity_log; cols text;
begin
  select * into l from activity_log where id = p_id;
  if l is null then raise exception 'no activity %', p_id using errcode = 'P0002'; end if;
  if not (l.entity = any (crm_undoable())) then
    raise exception 'cannot undo changes to %', l.entity using errcode = '22023';
  end if;
  if exists (select 1 from activity_log where undo_of = p_id) then
    raise exception 'activity % was already undone', p_id using errcode = '22023';
  end if;
  perform crm_begin(p_actor, 'Undo of #' || p_id);
  perform set_config('crm.undo_of', p_id::text, true);
  if l.action = 'create' then
    execute format('delete from %I where id = $1::uuid', l.entity) using l.entity_id;
  elsif l.action = 'delete' then
    execute format('insert into %I select * from jsonb_populate_record(null::%I, $1)', l.entity, l.entity) using l.before;
  else
    select string_agg(format('%I = r.%I', key, key), ', ') into cols
      from jsonb_object_keys(l.changes) key;
    execute format('update %I t set %s from jsonb_populate_record(null::%I, $1) r where t.id = $2::uuid', l.entity, cols, l.entity)
      using l.before, l.entity_id;
  end if;
  perform set_config('crm.undo_of', '', true);
  return (select to_jsonb(a) from activity_log a where undo_of = p_id order by id desc limit 1);
end $$;

-- Later phases add their tables here (bookings, booking_items, ...).
create or replace function crm_undoable() returns text[] language sql immutable as $$ select array['customers'] $$;

create or replace function recent_activity(p_limit integer default 50, p_entity text default null, p_entity_id text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id desc), '[]'::jsonb) from (
    select * from activity_log
    where (p_entity is null or entity = p_entity) and (p_entity_id is null or entity_id = p_entity_id)
    order by id desc limit least(greatest(p_limit, 1), 500)
  ) a
$$;

-- ---------- access ----------
-- Row level security: only the three team members (logged in) can read; writes only through the functions above.
-- The bot uses the service-role key on the server, which bypasses RLS; it never reaches the browser.
alter table team_members enable row level security;
alter table customers enable row level security;
alter table activity_log enable row level security;

create or replace function is_team() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where user_id = auth.uid())
$$;

drop policy if exists team_read on team_members;
create policy team_read on team_members for select to authenticated using (is_team());
drop policy if exists team_read on customers;
create policy team_read on customers for select to authenticated using (is_team());
drop policy if exists team_read on activity_log;
create policy team_read on activity_log for select to authenticated using (is_team());

revoke all on team_members, customers, activity_log from anon, authenticated;
grant select on team_members, customers, activity_log to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function find_customer(text, text, text), upsert_customer(jsonb, text), undo_activity(bigint, text),
  recent_activity(integer, text, text), is_team(), crm_actor() to authenticated, service_role;
