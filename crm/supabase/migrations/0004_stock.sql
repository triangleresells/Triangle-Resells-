-- Triangle Resells CRM v1, phase 3: stock.
-- The CRM keeps the live count and reserves pieces in the SAME transaction as the booking, so two buyers can never get
-- the same last piece and qty never goes below 0. BOT STOCK (the Google Sheet) stays the list people edit: the bot
-- syncs it every minute (stock_sync below): edits made on the sheet (a restock, a fix) flow in, the CRM's counts flow out.
-- TEST bookings only ever touch TEST stock (a copy of the tab), never real stock.

create table if not exists stock_items (
  id uuid primary key default gen_random_uuid(),
  key text not null,                 -- item|color|size, normalized (#2, #3 for repeated rows)
  category text,
  brand text,
  item text not null,
  color text,
  size text,
  price_list text,
  status text not null default 'for_sale' check (status in ('for_sale', 'freebie', 'not_for_sale', 'incoming', 'other')),
  notes text,
  cost numeric(10, 2),
  qty integer not null default 0 check (qty >= 0),       -- live count (what's really left)
  sheet_qty integer not null default 0,                   -- what the sheet showed / was last confirmed to show
  pending_sheet_qty integer,                              -- what the bot was asked to write, not seen on the sheet yet
  on_sheet boolean not null default true,                 -- row was removed from the sheet -> not sellable
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (is_test, key)
);

-- Every stock change, with why: booked, cancelled, no-show, items edited, someone edited the sheet.
create table if not exists stock_moves (
  id bigserial primary key,
  at timestamptz not null default now(),
  stock_item_id uuid not null references stock_items (id),
  delta integer not null,
  qty_after integer not null,
  reason text not null,
  booking_id uuid,
  actor text not null,
  is_test boolean not null default false
);
create index if not exists stock_moves_item_idx on stock_moves (stock_item_id, id desc);

alter table booking_items add column if not exists stock_item_id uuid references stock_items (id);
alter table booking_items add column if not exists reserved boolean not null default false;

drop trigger if exists stock_items_touch on stock_items;
create trigger stock_items_touch before update on stock_items for each row execute function crm_touch();

-- Same log trigger as before, but the sync's own bookkeeping (sheet_qty, pending_sheet_qty) and the reservation flags
-- don't make log lines on their own. Real changes (qty, status, price...) still do.
create or replace function crm_log_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb; ch jsonb;
begin
  if tg_op = 'INSERT' then
    n := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    o := to_jsonb(old); n := to_jsonb(new);
    select jsonb_object_agg(key, jsonb_build_object('from', o -> key, 'to', value)) into ch
      from jsonb_each(n)
      where key not in ('updated_at', 'sheet_qty', 'pending_sheet_qty', 'reserved', 'stock_item_id', 'on_sheet')
        and (tg_table_name <> 'stock_items' or key <> 'qty')     -- stock counts have their own log: stock_moves
        and (o -> key) is distinct from value;
    if ch is null then return new; end if;
  else
    o := to_jsonb(old);
  end if;
  insert into activity_log (actor, action, entity, entity_id, summary, before, after, changes, undo_of, is_test)
  values (
    crm_actor(), case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end, tg_table_name,
    coalesce(n ->> 'id', o ->> 'id'), nullif(current_setting('crm.summary', true), ''), o, n, ch,
    nullif(current_setting('crm.undo_of', true), '')::bigint,
    coalesce((coalesce(n, o) ->> 'is_test')::boolean, false)
  );
  return coalesce(new, old);
end $$;

drop trigger if exists stock_items_log on stock_items;
create trigger stock_items_log after update on stock_items for each row execute function crm_log_change();

-- ---------- matching a booking line to a stock row ----------
create or replace function crm_norm(s text) returns text language sql immutable as $$
  select trim(regexp_replace(lower(coalesce(s, '')), '[^a-z0-9]+', ' ', 'g'))
$$;
create or replace function crm_size_key(s text) returns text language sql immutable as $$
  select case when crm_norm(s) in ('', 'one size', 'os') then '' else crm_norm(s) end
$$;
create or replace function crm_stock_key(p_item text, p_color text, p_size text) returns text language sql immutable as $$
  select crm_norm(p_item) || '|' || crm_norm(p_color) || '|' || crm_size_key(p_size)
$$;

-- The FOR SALE row for a line: exact item + color + size; if the line left color or size blank, the one row that fits.
create or replace function crm_find_stock(p_item text, p_color text, p_size text, p_test boolean) returns stock_items
language plpgsql stable security definer set search_path = public as $$
declare r stock_items; n integer;
begin
  select * into r from stock_items
   where is_test = p_test and on_sheet and status = 'for_sale' and split_part(key, '#', 1) = crm_stock_key(p_item, p_color, p_size)
   order by qty desc, key limit 1;
  if r.id is not null then return r; end if;
  select count(*) into n from stock_items
   where is_test = p_test and on_sheet and status = 'for_sale' and crm_norm(item) = crm_norm(p_item)
     and (crm_norm(p_color) = '' or crm_norm(color) = crm_norm(p_color))
     and (crm_size_key(p_size) = '' or crm_size_key(size) = crm_size_key(p_size));
  if n = 1 then
    select * into r from stock_items
     where is_test = p_test and on_sheet and status = 'for_sale' and crm_norm(item) = crm_norm(p_item)
       and (crm_norm(p_color) = '' or crm_norm(color) = crm_norm(p_color))
       and (crm_size_key(p_size) = '' or crm_size_key(size) = crm_size_key(p_size));
  end if;
  return r;
end $$;

create or replace function crm_line_name(i booking_items) returns text language sql immutable as $$
  select concat_ws(' ', i.item, nullif(i.color, ''), case when crm_size_key(i.size) = '' then null else i.size end)
$$;

create or replace function crm_stock_move(p_stock uuid, p_delta integer, p_reason text, p_booking uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare q integer; t boolean;
begin
  update stock_items set qty = qty + p_delta where id = p_stock returning qty, is_test into q, t;
  insert into stock_moves (stock_item_id, delta, qty_after, reason, booking_id, actor, is_test)
  values (p_stock, p_delta, q, p_reason, p_booking, crm_actor(), t);
  return q;
end $$;

-- ---------- reserving: lines take stock when they're on an open booking, give it back when they're not ----------
create or replace function crm_booking_open(p_status text) returns boolean language sql immutable as $$
  select p_status not in ('cancelled', 'no_show')
$$;

-- A new line on an open booking takes its pieces. Not enough -> the whole booking (or edit) is refused.
create or replace function crm_reserve_line() returns trigger
language plpgsql security definer set search_path = public as $$
declare s stock_items; st text;
begin
  select status into st from bookings where id = new.booking_id;
  if st is null or not crm_booking_open(st) then return new; end if;
  s := crm_find_stock(new.item, new.color, new.size, new.is_test);
  if s.id is null then
    raise exception '% isn''t a FOR SALE item on BOT STOCK%', crm_line_name(new),
      case when new.is_test then ' (TEST stock)' else '' end using errcode = '22023';
  end if;
  if s.qty < new.qty then
    raise exception 'only % left of % (asked for %)', s.qty, crm_line_name(new), new.qty using errcode = 'TR409';
  end if;
  perform crm_stock_move(s.id, -new.qty, 'booked', new.booking_id);
  new.stock_item_id := s.id;
  new.reserved := true;
  if new.unit_cost is null then new.unit_cost := s.cost; end if;   -- cost from the sheet, for profit
  return new;
end $$;
drop trigger if exists booking_items_reserve on booking_items;
create trigger booking_items_reserve before insert on booking_items for each row execute function crm_reserve_line();

-- A removed line (items edited, booking deleted / undone) gives its pieces back.
create or replace function crm_release_line() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.reserved and old.stock_item_id is not null then
    perform crm_stock_move(old.stock_item_id, old.qty, 'items edited or booking removed', old.booking_id);
  end if;
  return old;
end $$;
drop trigger if exists booking_items_release on booking_items;
create trigger booking_items_release before delete on booking_items for each row execute function crm_release_line();

-- Cancelled / No-show gives the pieces back; reopening takes them again (refused if they're gone meanwhile).
create or replace function crm_status_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare i booking_items; s stock_items;
begin
  if crm_booking_open(old.status) = crm_booking_open(new.status) then return new; end if;
  for i in select * from booking_items where booking_id = new.id order by created_at, id loop
    if not crm_booking_open(new.status) then
      if i.reserved then
        perform crm_stock_move(i.stock_item_id, i.qty, case new.status when 'no_show' then 'no-show' else 'cancelled' end, new.id);
        update booking_items set reserved = false where id = i.id;
      end if;
    else
      s := crm_find_stock(i.item, i.color, i.size, i.is_test);
      if s.id is null then raise exception '% isn''t a FOR SALE item on BOT STOCK', crm_line_name(i) using errcode = '22023'; end if;
      if s.qty < i.qty then raise exception 'only % left of % (asked for %)', s.qty, crm_line_name(i), i.qty using errcode = 'TR409'; end if;
      perform crm_stock_move(s.id, -i.qty, 'reopened', new.id);
      update booking_items set reserved = true, stock_item_id = s.id where id = i.id;
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists bookings_status_stock on bookings;
create trigger bookings_status_stock after update of status on bookings for each row execute function crm_status_stock();

-- ---------- sheet <-> CRM sync (the bot runs this every minute) ----------
-- p_rows: the BOT STOCK rows as read [{category, brand, item, color, size, qty, price_list, status, notes, cost}].
-- Returns the counts the bot must write back to the sheet: [{item, color, size, occurrence, qty}].
create or replace function stock_sync(p_rows jsonb, p_is_test boolean default false, p_actor text default 'Bot') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; k text; base text; seen text[] := '{}'; occ integer; e stock_items; s integer; d integer; changed integer := 0;
begin
  perform crm_begin(p_actor, 'Stock sync with BOT STOCK');
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'bot only' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be a list' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    continue when nullif(trim(r ->> 'item'), '') is null;
    base := crm_stock_key(r ->> 'item', r ->> 'color', r ->> 'size');
    occ := (select count(*) from unnest(seen) x where x = base) + 1;
    seen := seen || base;
    k := base || case when occ > 1 then '#' || occ else '' end;
    s := greatest(coalesce((regexp_match(coalesce(r ->> 'qty', ''), '\d+'))[1]::integer, 0), 0);
    select * into e from stock_items where is_test = p_is_test and key = k for update;
    if e.id is null then
      insert into stock_items (key, category, brand, item, color, size, price_list, status, notes, cost, qty, sheet_qty, is_test)
      values (k, nullif(r ->> 'category', ''), nullif(r ->> 'brand', ''), r ->> 'item', nullif(r ->> 'color', ''), nullif(r ->> 'size', ''),
              nullif(r ->> 'price_list', ''), coalesce(nullif(r ->> 'status', ''), 'other'), nullif(r ->> 'notes', ''),
              nullif(r ->> 'cost', '')::numeric, s, s, p_is_test);
      continue;
    end if;
    if e.pending_sheet_qty is not null and s = e.pending_sheet_qty then
      update stock_items set sheet_qty = s, pending_sheet_qty = null where id = e.id;      -- our write landed
    elsif s <> coalesce(e.pending_sheet_qty, e.sheet_qty) and not (e.pending_sheet_qty is not null and s = e.sheet_qty) then
      -- Someone changed the number on the sheet (restock, count fix): apply the same change to the live count.
      d := s - coalesce(e.pending_sheet_qty, e.sheet_qty);
      d := greatest(d, -e.qty);
      if d <> 0 then perform crm_stock_move(e.id, d, 'BOT STOCK edited on the sheet', null); changed := changed + 1; end if;
      update stock_items set sheet_qty = s, pending_sheet_qty = null where id = e.id;
    end if;
    update stock_items set
      category = nullif(r ->> 'category', ''), brand = nullif(r ->> 'brand', ''), item = r ->> 'item',
      color = nullif(r ->> 'color', ''), size = nullif(r ->> 'size', ''), price_list = nullif(r ->> 'price_list', ''),
      status = coalesce(nullif(r ->> 'status', ''), 'other'), notes = nullif(r ->> 'notes', ''),
      cost = nullif(r ->> 'cost', '')::numeric, on_sheet = true
    where id = e.id;
  end loop;
  -- Rows taken off the sheet can't be sold anymore.
  update stock_items si set on_sheet = false where si.is_test = p_is_test and si.on_sheet and si.key <> all (
    select b || case when n > 1 then '#' || n else '' end from (
      select b, row_number() over (partition by b) n from unnest(seen) b) x);
  -- What the sheet should show now.
  update stock_items set pending_sheet_qty = qty
   where is_test = p_is_test and on_sheet and qty <> coalesce(pending_sheet_qty, sheet_qty);
  return jsonb_build_object(
    'sheet_edits_applied', changed,
    'writes', coalesce((select jsonb_agg(jsonb_build_object('item', item, 'color', color, 'size', size,
        'occurrence', coalesce(nullif(split_part(key, '#', 2), '')::integer, 1), 'qty', pending_sheet_qty) order by key)
      from stock_items where is_test = p_is_test and on_sheet and pending_sheet_qty is not null), '[]'::jsonb));
end $$;

-- ---------- reading ----------
create or replace function stock_list(p_is_test boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not is_team() then raise exception 'not a team member' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(s) order by s.qty = 0 desc, s.brand, s.item, s.color, s.size)
    from stock_items s where s.is_test = p_is_test and s.on_sheet), '[]'::jsonb);
end $$;

create or replace function stock_history(p_stock uuid, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not is_team() then raise exception 'not a team member' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(m) order by m.id desc) from (
    select * from stock_moves where stock_item_id = p_stock order by id desc limit least(greatest(p_limit, 1), 500)) m), '[]'::jsonb);
end $$;

alter table stock_items enable row level security;
alter table stock_moves enable row level security;
drop policy if exists team_read on stock_items;
create policy team_read on stock_items for select to authenticated using (is_team());
drop policy if exists team_read on stock_moves;
create policy team_read on stock_moves for select to authenticated using (is_team());
revoke all on stock_items, stock_moves from anon, authenticated;
grant select on stock_items, stock_moves to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function stock_sync(jsonb, boolean, text) to service_role;
grant execute on function stock_list(boolean), stock_history(uuid, integer) to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table stock_items;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
