-- Triangle Resells CRM v1: restocks and the team's stock view.
-- A restock is logged while it's coming (from a screenshot or by hand), then marked received: the pieces are added to
-- the live count, INCOMING rows become FOR SALE, and items that aren't on BOT STOCK yet get a row added by the bot.
-- "Sold this restock" = Done sales of the item dated on or after the day the restock landed.

create table if not exists restocks (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),        -- e.g. "Nov 16-17 restock"
  status text not null default 'incoming' check (status in ('incoming', 'received')),
  expected_date date,
  received_at timestamptz,
  notes text,
  created_by text not null default 'System',
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists restock_items (
  id uuid primary key default gen_random_uuid(),
  restock_id uuid not null references restocks (id) on delete cascade,
  category text,
  brand text,
  item text not null check (length(trim(item)) > 0),
  color text,
  size text,
  qty_expected integer not null check (qty_expected >= 0),
  qty_received integer check (qty_received >= 0),
  price_list text,
  unit_cost numeric(10, 2) check (unit_cost >= 0),
  stock_item_id uuid references stock_items (id),
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists restock_items_restock_idx on restock_items (restock_id);

-- Stock rows the CRM made (a new item in a restock) wait for the bot to add them to BOT STOCK;
-- a status the CRM changed (INCOMING -> FOR SALE) waits for the bot to write it, and the sync keeps the CRM's value meanwhile.
alter table stock_items add column if not exists needs_sheet_row boolean not null default false;
alter table stock_items add column if not exists pending_sheet_status text;

drop trigger if exists restocks_touch on restocks;
create trigger restocks_touch before update on restocks for each row execute function crm_touch();
drop trigger if exists restocks_log on restocks;
create trigger restocks_log after insert or update or delete on restocks for each row execute function crm_log_change();
drop trigger if exists restock_items_log on restock_items;
create trigger restock_items_log after insert or update or delete on restock_items for each row execute function crm_log_change();

create or replace function crm_undoable() returns text[] language sql immutable as $$
  select array['customers', 'bookings', 'booking_items', 'restocks', 'restock_items']
$$;

create or replace function restock_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(r) || jsonb_build_object('items', coalesce((
    select jsonb_agg(to_jsonb(i) order by i.brand nulls last, i.item, i.color, i.size, i.created_at) from restock_items i where i.restock_id = r.id), '[]'::jsonb))
  from restocks r where r.id = p_id
$$;

create or replace function crm_check_restock_items(p_items jsonb) returns void language plpgsql immutable as $$
declare it jsonb; n integer := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'a restock needs at least one item' using errcode = '22023';
  end if;
  for it in select * from jsonb_array_elements(p_items) loop
    n := n + 1;
    if nullif(trim(it ->> 'item'), '') is null then raise exception 'restock item % has no name', n using errcode = '22023'; end if;
    if coalesce((it ->> 'qty_expected')::integer, -1) < 0 then raise exception 'restock item % (%) needs a quantity', n, it ->> 'item' using errcode = '22023'; end if;
  end loop;
end $$;

create or replace function crm_insert_restock_items(p_restock uuid, p_items jsonb, p_test boolean) returns void
language sql security definer set search_path = public as $$
  insert into restock_items (restock_id, category, brand, item, color, size, qty_expected, price_list, unit_cost, is_test)
  select p_restock, crm_text(i, 'category'), crm_text(i, 'brand'), crm_text(i, 'item'), crm_text(i, 'color'), crm_text(i, 'size'),
         (i ->> 'qty_expected')::integer, crm_text(i, 'price_list'), (i ->> 'unit_cost')::numeric, p_test
  from jsonb_array_elements(p_items) i
$$;

-- p: {name, expected_date, notes, is_test, items: [{category, brand, item, color, size, qty_expected, price_list, unit_cost}]}
create or replace function create_restock(p jsonb, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a text; r restocks; test boolean := coalesce((p ->> 'is_test')::boolean, false);
begin
  a := crm_begin(p_actor);
  perform crm_check_restock_items(p -> 'items');
  perform crm_begin(p_actor, a || ' logged an incoming restock: ' || coalesce(crm_text(p, 'name'), '?'));
  insert into restocks (name, expected_date, notes, created_by, is_test)
  values (coalesce(crm_text(p, 'name'), 'Restock'), (p ->> 'expected_date')::date, crm_text(p, 'notes'), a, test)
  returning * into r;
  perform crm_insert_restock_items(r.id, p -> 'items', test);
  return restock_json(r.id);
end $$;

-- Edit while it's still coming (name, date, notes; items replace all lines).
create or replace function update_restock(p_id uuid, p jsonb, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a text; r restocks;
begin
  a := crm_begin(p_actor);
  select * into r from restocks where id = p_id for update;
  if r is null then raise exception 'no restock %', p_id using errcode = 'P0002'; end if;
  if r.status = 'received' then raise exception 'this restock was already received' using errcode = '22023'; end if;
  if p ? 'items' then perform crm_check_restock_items(p -> 'items'); end if;
  perform crm_begin(p_actor, a || ' edited the incoming restock ' || r.name);
  update restocks set name = coalesce(crm_text(p, 'name'), name),
    expected_date = case when p ? 'expected_date' then (p ->> 'expected_date')::date else expected_date end,
    notes = case when p ? 'notes' then crm_text(p, 'notes') else notes end
  where id = p_id;
  if p ? 'items' then
    delete from restock_items where restock_id = p_id;
    perform crm_insert_restock_items(p_id, p -> 'items', r.is_test);
  end if;
  return restock_json(p_id);
end $$;

-- It landed. p_received: optional [{id, qty_received}] when the count differs from what was expected.
create or replace function receive_restock(p_id uuid, p_received jsonb default '[]', p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a text; r restocks; i restock_items; got integer; s stock_items; k text;
begin
  a := crm_begin(p_actor);
  select * into r from restocks where id = p_id for update;
  if r is null then raise exception 'no restock %', p_id using errcode = 'P0002'; end if;
  if r.status = 'received' then raise exception 'this restock was already received' using errcode = '22023'; end if;
  perform crm_begin(p_actor, a || ' received the restock ' || r.name);
  for i in select * from restock_items where restock_id = p_id order by created_at, id loop
    got := coalesce((select (x ->> 'qty_received')::integer from jsonb_array_elements(coalesce(p_received, '[]')) x where x ->> 'id' = i.id::text), i.qty_expected);
    if got < 0 then raise exception 'received count for % can''t be negative', i.item using errcode = '22023'; end if;
    k := crm_stock_key(i.item, i.color, i.size);
    select * into s from stock_items where is_test = i.is_test and split_part(key, '#', 1) = k order by key limit 1 for update;
    if s.id is null then
      -- A new item: the CRM makes the stock row now; the bot adds it to BOT STOCK on its next sync.
      insert into stock_items (key, category, brand, item, color, size, price_list, status, cost, qty, sheet_qty, needs_sheet_row, is_test)
      values (k, i.category, i.brand, i.item, i.color, i.size, i.price_list, 'for_sale', i.unit_cost, 0, 0, true, i.is_test)
      returning * into s;
    elsif s.status <> 'for_sale' or not s.on_sheet then
      update stock_items set status = 'for_sale', pending_sheet_status = 'for_sale', on_sheet = true,
        cost = coalesce(i.unit_cost, cost), price_list = coalesce(i.price_list, price_list)
      where id = s.id;
    elsif i.unit_cost is not null and s.cost is distinct from i.unit_cost then
      update stock_items set cost = i.unit_cost where id = s.id;
    end if;
    if got > 0 then perform crm_stock_move(s.id, got, 'restock: ' || r.name, null); end if;
    update restock_items set qty_received = got, stock_item_id = s.id where id = i.id;
  end loop;
  update restocks set status = 'received', received_at = now() where id = p_id;
  return restock_json(p_id);
end $$;

create or replace function restocks_list(p_include_test boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_team_or_service();
  return coalesce((select jsonb_agg(restock_json(r.id) order by r.status = 'received', coalesce(r.received_at, r.created_at) desc)
    from restocks r where p_include_test or not r.is_test), '[]'::jsonb);
end $$;

-- ---------- the team's stock view ----------
-- Per item: free to sell, reserved (booked, not done yet), sold (Done) since the latest restock of it landed,
-- what that restock brought in, and all-time sold.
create or replace function stock_overview(p_is_test boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_team_or_service();
  return coalesce((select jsonb_agg(x order by (x ->> 'free')::integer = 0 and x ->> 'status' = 'for_sale' desc, x ->> 'brand', x ->> 'item', x ->> 'color', x ->> 'size') from (
    select jsonb_build_object(
      'id', s.id, 'brand', s.brand, 'item', s.item, 'color', s.color, 'size', s.size, 'status', s.status, 'price_list', s.price_list, 'cost', s.cost,
      'free', s.qty,
      'reserved', coalesce((select sum(bi.qty) from booking_items bi join bookings b on b.id = bi.booking_id
                             where bi.stock_item_id = s.id and bi.reserved and b.status in ('booked', 'paid', 'paid_needs_check')), 0),
      'restock', lr.name, 'restock_received', lr.received_at, 'came_in', coalesce(lr.qty_received, 0),
      'sold_since_restock', coalesce((select sum(bi.qty) from booking_items bi join bookings b on b.id = bi.booking_id
                             where bi.stock_item_id = s.id and b.status = 'done'
                               and (lr.received_at is null or b.date >= (lr.received_at at time zone 'America/New_York')::date)), 0),
      'sold_all_time', coalesce((select sum(bi.qty) from booking_items bi join bookings b on b.id = bi.booking_id
                             where bi.stock_item_id = s.id and b.status = 'done'), 0),
      'needs_sheet_row', s.needs_sheet_row) x
    from stock_items s
    left join lateral (
      select r.name, r.received_at, ri.qty_received from restock_items ri join restocks r on r.id = ri.restock_id
       where ri.stock_item_id = s.id and r.status = 'received' order by r.received_at desc limit 1) lr on true
    where s.is_test = p_is_test and (s.on_sheet or s.needs_sheet_row)) y), '[]'::jsonb);
end $$;

-- ---------- sheet sync, now with added rows and status changes ----------
create or replace function stock_sync(p_rows jsonb, p_is_test boolean default false, p_actor text default 'Bot') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; k text; base text; seen text[] := '{}'; occ integer; e stock_items; s integer; d integer; changed integer := 0; st text;
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
    st := coalesce(nullif(r ->> 'status', ''), 'other');
    select * into e from stock_items where is_test = p_is_test and key = k for update;
    if e.id is null then
      insert into stock_items (key, category, brand, item, color, size, price_list, status, notes, cost, qty, sheet_qty, is_test)
      values (k, nullif(r ->> 'category', ''), nullif(r ->> 'brand', ''), r ->> 'item', nullif(r ->> 'color', ''), nullif(r ->> 'size', ''),
              nullif(r ->> 'price_list', ''), st, nullif(r ->> 'notes', ''), nullif(r ->> 'cost', '')::numeric, s, s, p_is_test);
      continue;
    end if;
    if e.needs_sheet_row then
      -- The row the bot added for a restock is on the sheet now: from here it syncs like any other row.
      update stock_items set needs_sheet_row = false, sheet_qty = s, pending_sheet_qty = case when s = qty then null else qty end where id = e.id;
    elsif e.pending_sheet_qty is not null and s = e.pending_sheet_qty then
      update stock_items set sheet_qty = s, pending_sheet_qty = null where id = e.id;
    elsif s <> coalesce(e.pending_sheet_qty, e.sheet_qty) and not (e.pending_sheet_qty is not null and s = e.sheet_qty) then
      d := s - coalesce(e.pending_sheet_qty, e.sheet_qty);
      d := greatest(d, -e.qty);
      if d <> 0 then perform crm_stock_move(e.id, d, 'BOT STOCK edited on the sheet', null); changed := changed + 1; end if;
      update stock_items set sheet_qty = s, pending_sheet_qty = null where id = e.id;
    end if;
    update stock_items set
      category = nullif(r ->> 'category', ''), brand = nullif(r ->> 'brand', ''), item = r ->> 'item',
      color = nullif(r ->> 'color', ''), size = nullif(r ->> 'size', ''), price_list = coalesce(nullif(r ->> 'price_list', ''), price_list),
      -- A status the CRM changed (restock received) wins until the sheet shows it.
      status = case when pending_sheet_status is null or pending_sheet_status = st then st else pending_sheet_status end,
      pending_sheet_status = case when pending_sheet_status = st then null else pending_sheet_status end,
      notes = nullif(r ->> 'notes', ''), cost = coalesce(nullif(r ->> 'cost', '')::numeric, cost), on_sheet = true
    where id = e.id;
  end loop;
  -- Rows taken off the sheet can't be sold anymore (rows still waiting to be added are kept).
  update stock_items si set on_sheet = false where si.is_test = p_is_test and si.on_sheet and not si.needs_sheet_row and si.key <> all (
    select b || case when n > 1 then '#' || n else '' end from (
      select b, row_number() over (partition by b) n from unnest(seen) b) x);
  update stock_items set pending_sheet_qty = qty
   where is_test = p_is_test and on_sheet and not needs_sheet_row and qty <> coalesce(pending_sheet_qty, sheet_qty);
  return jsonb_build_object(
    'sheet_edits_applied', changed,
    'writes', coalesce((select jsonb_agg(jsonb_build_object('item', item, 'color', color, 'size', size,
        'occurrence', coalesce(nullif(split_part(key, '#', 2), '')::integer, 1), 'qty', coalesce(pending_sheet_qty, qty),
        'status', pending_sheet_status) order by key)
      from stock_items where is_test = p_is_test and on_sheet and not needs_sheet_row
        and (pending_sheet_qty is not null or pending_sheet_status is not null)), '[]'::jsonb),
    'add_rows', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'brand', brand, 'item', item, 'color', color, 'size', size,
        'qty', qty, 'price_list', price_list, 'status', status, 'cost', cost) order by created_at)
      from stock_items where is_test = p_is_test and needs_sheet_row), '[]'::jsonb));
end $$;

alter table restocks enable row level security;
alter table restock_items enable row level security;
drop policy if exists team_read on restocks;
create policy team_read on restocks for select to authenticated using (is_team());
drop policy if exists team_read on restock_items;
create policy team_read on restock_items for select to authenticated using (is_team());
revoke all on restocks, restock_items from anon, authenticated;
grant select on restocks, restock_items to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function create_restock(jsonb, text), update_restock(uuid, jsonb, text), receive_restock(uuid, jsonb, text),
  restocks_list(boolean), stock_overview(boolean) to authenticated, service_role;
grant execute on function stock_sync(jsonb, boolean, text) to service_role;
