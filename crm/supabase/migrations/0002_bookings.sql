-- Triangle Resells CRM v1, phase 2: bookings (sales) and their item lines.
-- Same rules as phase 1: every write is a function, saved with its activity-log line in one transaction.
-- Stock reservation (phase 3) hooks into create / cancel / no-show; revenue and profit (phase 4) read these tables.

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  time time,
  customer_id uuid references customers (id),
  status text not null default 'booked'
    check (status in ('booked', 'paid', 'paid_needs_check', 'done', 'no_show', 'cancelled')),
  payment_method text not null check (payment_method in ('cash', 'cash_app', 'zelle', 'stripe', 'apple_pay')),
  fulfillment text not null check (fulfillment in ('pickup', 'delivery', 'ship')),
  sale_price numeric(10, 2) not null check (sale_price >= 0),      -- item total = revenue (fees not included)
  delivery_fee numeric(10, 2) not null default 0 check (delivery_fee >= 0),  -- local delivery, NOT revenue
  shipping_fee numeric(10, 2) not null default 0 check (shipping_fee >= 0),  -- what the buyer paid for shipping
  label_cost numeric(10, 2) not null default 0 check (label_cost >= 0),      -- what we paid for the label
  location text,                       -- warehouse, meetup spot, or shipping address
  assignee text check (assignee in ('Josh', 'Chema', 'Diego')),
  source text not null default 'other' check (source in ('instagram', 'bot', 'in_person', 'text', 'referral', 'other')),
  source_account text check (source_account in ('Triangle Resells', 'Triangle Scales', 'Triangle Sales')),
  tracking_number text,
  notes text,
  status_reason text,                  -- why it was cancelled / no-show
  created_by text not null default 'System',
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (fulfillment = 'delivery' or delivery_fee = 0),
  check (fulfillment = 'ship' or (shipping_fee = 0 and tracking_number is null)),
  check (payment_method <> 'cash' or fulfillment = 'pickup')       -- cash is pickup only (delivery cash = Josh's call)
);
create index if not exists bookings_date_idx on bookings (date);
create index if not exists bookings_customer_idx on bookings (customer_id);

create table if not exists booking_items (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings (id) on delete cascade,
  brand text,
  item text not null check (length(trim(item)) > 0),
  color text,
  size text not null check (length(trim(size)) > 0),   -- "One Size" for bags, hats, fragrances
  qty integer not null check (qty > 0),
  unit_price numeric(10, 2) check (unit_price >= 0),
  unit_cost numeric(10, 2) check (unit_cost >= 0),     -- from the stock sheet's Cost column (phase 3)
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists booking_items_booking_idx on booking_items (booking_id);

drop trigger if exists bookings_log on bookings;
create trigger bookings_log after insert or update or delete on bookings for each row execute function crm_log_change();
drop trigger if exists bookings_touch on bookings;
create trigger bookings_touch before update on bookings for each row execute function crm_touch();
drop trigger if exists booking_items_log on booking_items;
create trigger booking_items_log after insert or update or delete on booking_items for each row execute function crm_log_change();

create or replace function crm_undoable() returns text[] language sql immutable as $$
  select array['customers', 'bookings', 'booking_items']
$$;

-- ---------- reading ----------
create or replace function booking_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(b) || jsonb_build_object(
    'customer', (select to_jsonb(c) from customers c where c.id = b.customer_id),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at, i.id) from booking_items i where i.booking_id = b.id), '[]'::jsonb)
  )
  from bookings b where b.id = p_id
$$;

create or replace function get_booking(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not is_team() then
    raise exception 'not a team member' using errcode = '42501';
  end if;
  r := booking_json(p_id);
  if r is null then raise exception 'no booking %', p_id using errcode = 'P0002'; end if;
  return r;
end $$;

-- Calendar: every booking between two dates (inclusive), with customer and items. Test data only when asked.
create or replace function bookings_between(p_from date, p_to date, p_include_test boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not is_team() then
    raise exception 'not a team member' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(booking_json(b.id) order by b.date, b.time nulls last, b.created_at)
    from bookings b where b.date between p_from and p_to and (p_include_test or not b.is_test)
  ), '[]'::jsonb);
end $$;

-- ---------- validation ----------
create or replace function crm_text(p jsonb, k text) returns text language sql immutable as $$
  select nullif(trim(p ->> k), '')
$$;

-- Checks item lines; raises a clear error (nothing gets saved) on the first problem.
create or replace function crm_check_items(p_items jsonb) returns void language plpgsql immutable as $$
declare it jsonb; n integer := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'a booking needs at least one item' using errcode = '22023';
  end if;
  for it in select * from jsonb_array_elements(p_items) loop
    n := n + 1;
    if crm_text(it, 'item') is null then raise exception 'item % has no name', n using errcode = '22023'; end if;
    if crm_text(it, 'size') is null then
      raise exception 'item % (%) has no size (use "One Size" if it has none)', n, it ->> 'item' using errcode = '22023';
    end if;
    if coalesce((it ->> 'qty')::integer, 0) < 1 then raise exception 'item % (%) needs a quantity of 1 or more', n, it ->> 'item' using errcode = '22023'; end if;
  end loop;
end $$;

create or replace function crm_insert_items(p_booking uuid, p_items jsonb, p_test boolean) returns void
language sql security definer set search_path = public as $$
  insert into booking_items (booking_id, brand, item, color, size, qty, unit_price, unit_cost, is_test)
  select p_booking, crm_text(i, 'brand'), crm_text(i, 'item'), crm_text(i, 'color'), crm_text(i, 'size'), (i ->> 'qty')::integer,
         (i ->> 'unit_price')::numeric, (i ->> 'unit_cost')::numeric, p_test
  from jsonb_array_elements(p_items) i
$$;

-- Item total from the lines' unit prices; null if any line has no price.
create or replace function crm_items_total(p_items jsonb) returns numeric language sql immutable as $$
  select case when bool_and(i ? 'unit_price' and (i ->> 'unit_price') is not null)
              then sum((i ->> 'qty')::integer * (i ->> 'unit_price')::numeric) end
  from jsonb_array_elements(p_items) i
$$;

-- Paid rule (Josh): only a Stripe payment can be marked Paid by the bot; Zelle / Cash App / cash from the bot
-- become "Paid - needs check" until a team member confirms.
create or replace function crm_paid_status(p_status text, p_payment text, p_actor text) returns text language sql immutable as $$
  select case when p_status = 'paid' and p_actor = 'Bot' and p_payment <> 'stripe' then 'paid_needs_check' else p_status end
$$;

-- ---------- writing ----------
-- p: {date, time, customer: {ig_user_id, ig_handle, name, phone}, items: [{brand, item, color, size, qty, unit_price, unit_cost}],
--     payment_method, fulfillment, sale_price?, delivery_fee?, shipping_fee?, label_cost?, location, assignee, source,
--     source_account, tracking_number, notes, status?, is_test}
create or replace function create_booking(p jsonb, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a text; cust jsonb; b bookings; total numeric; test boolean := coalesce((p ->> 'is_test')::boolean, false);
begin
  a := crm_begin(p_actor);
  if crm_text(p, 'date') is null then raise exception 'a booking needs a date' using errcode = '22023'; end if;
  perform crm_check_items(p -> 'items');
  total := coalesce((p ->> 'sale_price')::numeric, crm_items_total(p -> 'items'));
  if total is null then raise exception 'a booking needs a sale price (or a unit price on every item)' using errcode = '22023'; end if;
  if p ? 'customer' and jsonb_typeof(p -> 'customer') = 'object' then
    cust := upsert_customer((p -> 'customer') || jsonb_build_object('is_test', test), p_actor);
  end if;
  perform crm_begin(p_actor, a || ' booked ' || coalesce(cust ->> 'name', '@' || (cust ->> 'ig_handle'), 'a sale') || ' for ' || (p ->> 'date')
    || coalesce(' ' || crm_text(p, 'time'), ''));
  insert into bookings (date, time, customer_id, status, payment_method, fulfillment, sale_price, delivery_fee, shipping_fee,
                        label_cost, location, assignee, source, source_account, tracking_number, notes, created_by, is_test)
  values ((p ->> 'date')::date, crm_text(p, 'time')::time, (cust ->> 'id')::uuid,
          crm_paid_status(coalesce(crm_text(p, 'status'), 'booked'), p ->> 'payment_method', a),
          p ->> 'payment_method', p ->> 'fulfillment', total,
          coalesce((p ->> 'delivery_fee')::numeric, 0), coalesce((p ->> 'shipping_fee')::numeric, 0), coalesce((p ->> 'label_cost')::numeric, 0),
          crm_text(p, 'location'), crm_text(p, 'assignee'), coalesce(crm_text(p, 'source'), case when a = 'Bot' then 'bot' else 'other' end),
          crm_text(p, 'source_account'), crm_text(p, 'tracking_number'), crm_text(p, 'notes'), a, test)
  returning * into b;
  perform crm_insert_items(b.id, p -> 'items', test);
  return booking_json(b.id);
end $$;

-- Edit any fields. Items, if given, replace all lines. Date/time changes are logged as a reschedule.
create or replace function update_booking(p_id uuid, p jsonb, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a text; b bookings; total numeric; what text;
begin
  a := crm_begin(p_actor);
  select * into b from bookings where id = p_id for update;
  if b is null then raise exception 'no booking %', p_id using errcode = 'P0002'; end if;
  if p ? 'items' then perform crm_check_items(p -> 'items'); end if;
  what := case
    when (p ? 'date' and (p ->> 'date')::date is distinct from b.date) or (p ? 'time' and crm_text(p, 'time')::time is distinct from b.time)
      then a || ' rescheduled to ' || coalesce(p ->> 'date', b.date::text) || coalesce(' ' || coalesce(crm_text(p, 'time'), b.time::text), '')
    else a || ' edited the booking' end;
  perform crm_begin(p_actor, what);
  total := case when p ? 'sale_price' then (p ->> 'sale_price')::numeric
                when p ? 'items' then coalesce(crm_items_total(p -> 'items'), b.sale_price) else b.sale_price end;
  update bookings set
    date = coalesce((p ->> 'date')::date, date),
    time = case when p ? 'time' then crm_text(p, 'time')::time else time end,
    payment_method = coalesce(crm_text(p, 'payment_method'), payment_method),
    fulfillment = coalesce(crm_text(p, 'fulfillment'), fulfillment),
    sale_price = total,
    delivery_fee = coalesce((p ->> 'delivery_fee')::numeric, delivery_fee),
    shipping_fee = coalesce((p ->> 'shipping_fee')::numeric, shipping_fee),
    label_cost = coalesce((p ->> 'label_cost')::numeric, label_cost),
    location = case when p ? 'location' then crm_text(p, 'location') else location end,
    assignee = case when p ? 'assignee' then crm_text(p, 'assignee') else assignee end,
    source = coalesce(crm_text(p, 'source'), source),
    source_account = case when p ? 'source_account' then crm_text(p, 'source_account') else source_account end,
    tracking_number = case when p ? 'tracking_number' then crm_text(p, 'tracking_number') else tracking_number end,
    notes = case when p ? 'notes' then crm_text(p, 'notes') else notes end
  where id = p_id;
  if p ? 'items' then
    delete from booking_items where booking_id = p_id;
    perform crm_insert_items(p_id, p -> 'items', b.is_test);
  end if;
  return booking_json(p_id);
end $$;

create or replace function reschedule_booking(p_id uuid, p_date date, p_time text default null, p_actor text default null) returns jsonb
language sql security definer set search_path = public as $$
  select update_booking(p_id, jsonb_build_object('date', p_date) || case when p_time is null then '{}'::jsonb else jsonb_build_object('time', p_time) end, p_actor)
$$;

-- Booked -> Paid -> Done, plus No-show and Cancelled (with a reason). The bot's "paid" follows the Paid rule above.
create or replace function set_booking_status(p_id uuid, p_status text, p_reason text default null, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a text; b bookings; s text; label text;
begin
  a := crm_begin(p_actor);
  select * into b from bookings where id = p_id for update;
  if b is null then raise exception 'no booking %', p_id using errcode = 'P0002'; end if;
  s := crm_paid_status(p_status, b.payment_method, a);
  label := case s when 'booked' then 'Booked' when 'paid' then 'Paid' when 'paid_needs_check' then 'Paid - needs check'
                  when 'done' then 'Done' when 'no_show' then 'No-show' when 'cancelled' then 'Cancelled' else s end;
  perform crm_begin(p_actor, a || ' marked it ' || label || coalesce(': ' || nullif(trim(p_reason), ''), ''));
  update bookings set status = s,
    status_reason = case when s in ('cancelled', 'no_show') then nullif(trim(p_reason), '') else null end
  where id = p_id;
  return booking_json(p_id);
end $$;

create or replace function cancel_booking(p_id uuid, p_reason text default null, p_actor text default null) returns jsonb
language sql security definer set search_path = public as $$
  select set_booking_status(p_id, 'cancelled', p_reason, p_actor)
$$;

-- ---------- access ----------
alter table bookings enable row level security;
alter table booking_items enable row level security;
drop policy if exists team_read on bookings;
create policy team_read on bookings for select to authenticated using (is_team());
drop policy if exists team_read on booking_items;
create policy team_read on booking_items for select to authenticated using (is_team());
revoke all on bookings, booking_items from anon, authenticated;
grant select on bookings, booking_items to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function get_booking(uuid), bookings_between(date, date, boolean), create_booking(jsonb, text),
  update_booking(uuid, jsonb, text), reschedule_booking(uuid, date, text, text), set_booking_status(uuid, text, text, text),
  cancel_booking(uuid, text, text) to authenticated, service_role;

-- Live updates: the CRM screens refresh when a booking changes (Supabase realtime). Skipped where it doesn't exist.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table bookings, booking_items;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
