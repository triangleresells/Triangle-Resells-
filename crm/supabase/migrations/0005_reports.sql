-- Triangle Resells CRM v1, phase 4: revenue, profit, drill-down, customers, cash per person, DM counts.
-- Revenue = sale_price of DONE bookings, in the month of the booking date. Delivery fees and shipping charged are NOT
-- revenue. Profit = revenue - item cost - label cost. A sale with an item that has no cost is flagged, never guessed.

-- ---------- cash accountability ----------
alter table bookings add column if not exists cash_collected_by text check (cash_collected_by in ('Josh', 'Chema', 'Diego'));
alter table bookings add column if not exists cash_collected_at timestamptz;

-- Cash marked Paid or Done: who collected it (the person who tapped it, or who was fulfilling if the bot did) and when.
create or replace function crm_cash_collect() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text := crm_actor();
begin
  if tg_op = 'INSERT' then
    if new.payment_method = 'cash' and new.status in ('paid', 'done') then
      new.cash_collected_at := now();
      new.cash_collected_by := coalesce(new.cash_collected_by, case when a in ('Josh', 'Chema', 'Diego') then a end, new.assignee);
    end if;
    return new;
  end if;
  if new.payment_method = 'cash' and new.status in ('paid', 'done') and new.cash_collected_at is null then
    new.cash_collected_at := now();
    new.cash_collected_by := coalesce(new.cash_collected_by, case when a in ('Josh', 'Chema', 'Diego') then a end, new.assignee);
  elsif new.status not in ('paid', 'done') and old.status in ('paid', 'done') and new.payment_method = 'cash' then
    new.cash_collected_at := null;   -- un-marked (or cancelled after all): not collected
    new.cash_collected_by := null;
  end if;
  return new;
end $$;
drop trigger if exists bookings_cash on bookings;
create trigger bookings_cash before insert or update of status on bookings for each row execute function crm_cash_collect();

-- ---------- one row per sale, with its cost and profit ----------
create or replace function crm_sale_row(b bookings) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', b.id, 'date', b.date, 'time', b.time, 'status', b.status,
    'customer', (select jsonb_build_object('id', c.id, 'ig_handle', c.ig_handle, 'name', c.name, 'phone', c.phone) from customers c where c.id = b.customer_id),
    'items', coalesce((select jsonb_agg(jsonb_build_object('brand', i.brand, 'item', i.item, 'color', i.color, 'size', i.size, 'qty', i.qty,
        'unit_price', i.unit_price, 'unit_cost', i.unit_cost) order by i.created_at, i.id) from booking_items i where i.booking_id = b.id), '[]'::jsonb),
    'revenue', b.sale_price,
    'item_cost', coalesce((select sum(i.qty * i.unit_cost) from booking_items i where i.booking_id = b.id), 0),
    'label_cost', b.label_cost,
    'cost_missing', exists (select 1 from booking_items i where i.booking_id = b.id and i.unit_cost is null),
    'profit', b.sale_price - coalesce((select sum(i.qty * i.unit_cost) from booking_items i where i.booking_id = b.id), 0) - b.label_cost,
    'delivery_fee', b.delivery_fee, 'shipping_fee', b.shipping_fee,
    'payment_method', b.payment_method, 'fulfillment', b.fulfillment, 'location', b.location,
    'assignee', b.assignee, 'source', b.source, 'source_account', b.source_account, 'tracking_number', b.tracking_number,
    'cash_collected_by', b.cash_collected_by, 'is_test', b.is_test)
$$;

-- Filters: {assignee, payment_method, fulfillment, source, source_account}. Blank = all.
create or replace function crm_sale_matches(b bookings, f jsonb) returns boolean language sql immutable as $$
  select (nullif(f ->> 'assignee', '') is null or b.assignee = f ->> 'assignee')
     and (nullif(f ->> 'payment_method', '') is null or b.payment_method = f ->> 'payment_method')
     and (nullif(f ->> 'fulfillment', '') is null or b.fulfillment = f ->> 'fulfillment')
     and (nullif(f ->> 'source', '') is null or b.source = f ->> 'source')
     and (nullif(f ->> 'source_account', '') is null or coalesce(b.source_account, 'none') = f ->> 'source_account')
$$;

create or replace function crm_team_or_service() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not is_team() then raise exception 'not a team member' using errcode = '42501'; end if;
end $$;

-- The drill-down: every Done sale in [p_from, p_to] with totals computed from those same rows, so they always add up.
create or replace function sales_report(p_from date, p_to date, p_filters jsonb default '{}', p_include_test boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rows jsonb;
begin
  perform crm_team_or_service();
  select coalesce(jsonb_agg(crm_sale_row(b) order by b.date, b.time nulls last, b.created_at), '[]'::jsonb) into rows
    from bookings b
   where b.status = 'done' and b.date between p_from and p_to and (p_include_test or not b.is_test)
     and crm_sale_matches(b, coalesce(p_filters, '{}'));
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'totals', (select jsonb_build_object(
        'sales', count(*),
        'revenue', coalesce(sum((r ->> 'revenue')::numeric), 0),
        'item_cost', coalesce(sum((r ->> 'item_cost')::numeric), 0),
        'label_cost', coalesce(sum((r ->> 'label_cost')::numeric), 0),
        'profit', coalesce(sum((r ->> 'profit')::numeric), 0),
        'delivery_fees', coalesce(sum((r ->> 'delivery_fee')::numeric), 0),
        'sales_missing_cost', count(*) filter (where (r ->> 'cost_missing')::boolean))
      from jsonb_array_elements(rows) r),
    'by_account', coalesce((select jsonb_agg(jsonb_build_object('account', acct, 'revenue', rev, 'profit', prof, 'sales', n) order by rev desc) from (
        select coalesce(r ->> 'source_account', 'In person / other') acct, sum((r ->> 'revenue')::numeric) rev, sum((r ->> 'profit')::numeric) prof, count(*) n
          from jsonb_array_elements(rows) r group by 1) x), '[]'::jsonb),
    'sales', rows);
end $$;

-- The chart: Done revenue and profit for each of the last p_months months (oldest first), plus what's still open.
create or replace function monthly_report(p_months integer default 12, p_filters jsonb default '{}', p_include_test boolean default false,
                                          p_today date default (now() at time zone 'America/New_York')::date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_team_or_service();
  return (select jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
      'revenue', coalesce(x.rev, 0), 'profit', coalesce(x.prof, 0), 'sales', coalesce(x.n, 0), 'open', coalesce(o.open, 0)) order by m)
    from generate_series(date_trunc('month', p_today) - make_interval(months => least(greatest(p_months, 1), 60) - 1), date_trunc('month', p_today), interval '1 month') m
    left join (
      select date_trunc('month', b.date) mon, sum(b.sale_price) rev,
             sum(b.sale_price - coalesce((select sum(i.qty * i.unit_cost) from booking_items i where i.booking_id = b.id), 0) - b.label_cost) prof, count(*) n
        from bookings b where b.status = 'done' and (p_include_test or not b.is_test) and crm_sale_matches(b, coalesce(p_filters, '{}'))
       group by 1) x on x.mon = m
    left join (
      select date_trunc('month', b.date) mon, sum(b.sale_price) open
        from bookings b where b.status in ('booked', 'paid', 'paid_needs_check') and (p_include_test or not b.is_test) and crm_sale_matches(b, coalesce(p_filters, '{}'))
       group by 1) o on o.mon = m);
end $$;

-- ---------- customers ----------
create or replace function crm_customer_row(c customers) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(c) || jsonb_build_object(
    'orders', (select count(*) from bookings b where b.customer_id = c.id and b.status = 'done'),
    'open_orders', (select count(*) from bookings b where b.customer_id = c.id and b.status in ('booked', 'paid', 'paid_needs_check')),
    'total_spent', coalesce((select sum(b.sale_price) from bookings b where b.customer_id = c.id and b.status = 'done'), 0),
    'last_order', (select max(b.date) from bookings b where b.customer_id = c.id and b.status not in ('cancelled', 'no_show')),
    'no_shows', (select count(*) from bookings b where b.customer_id = c.id and b.status = 'no_show'))
$$;

-- p_sort: top_spenders | lowest_spenders | most_dms | repeat_buyers | recent
create or replace function customers_report(p_sort text default 'top_spenders', p_limit integer default 100, p_include_test boolean default false, p_search text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_team_or_service();
  return coalesce((select jsonb_agg(r order by n) from (
    select r, row_number() over (order by
        case when p_sort = 'top_spenders' then -(r ->> 'total_spent')::numeric when p_sort = 'lowest_spenders' then (r ->> 'total_spent')::numeric end nulls last,
        case when p_sort = 'most_dms' then -(r ->> 'dm_conversations')::integer when p_sort = 'repeat_buyers' then -(r ->> 'orders')::integer end nulls last,
        r ->> 'last_order' desc nulls last, r ->> 'created_at' desc) n
      from (
        select crm_customer_row(c) r from customers c
         where (p_include_test or not c.is_test)
           and (nullif(trim(p_search), '') is null or c.ig_handle ilike '%' || trim(p_search) || '%'
                or c.name ilike '%' || trim(p_search) || '%' or c.phone ilike '%' || trim(p_search) || '%')
      ) x
     where p_sort <> 'repeat_buyers' or (r ->> 'orders')::integer >= 2
     order by n
     limit least(greatest(p_limit, 1), 1000)) y), '[]'::jsonb);
end $$;

-- Every order a customer has, newest first.
create or replace function customer_orders(p_customer uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_team_or_service();
  return jsonb_build_object(
    'customer', (select crm_customer_row(c) from customers c where c.id = p_customer),
    'orders', coalesce((select jsonb_agg(crm_sale_row(b) order by b.date desc, b.time desc nulls last) from bookings b where b.customer_id = p_customer), '[]'::jsonb));
end $$;

-- A new DM conversation started (the bot calls this): counts toward "most active in DMs".
create or replace function record_dm(p_ig_user_id text, p_ig_handle text default null, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb;
begin
  c := upsert_customer(jsonb_build_object('ig_user_id', p_ig_user_id, 'ig_handle', p_ig_handle), p_actor);
  perform crm_begin(p_actor, 'New DM conversation');
  update customers set dm_conversations = dm_conversations + 1 where id = (c ->> 'id')::uuid;
  return (select crm_customer_row(x) from customers x where x.id = (c ->> 'id')::uuid);
end $$;

-- What the bot reads before it answers: the buyer's history and their open bookings.
create or replace function buyer_context(p_ig_user_id text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_team_or_service();
  return jsonb_build_object(
    'customer', (select crm_customer_row(c) from customers c where c.ig_user_id = p_ig_user_id),
    'bookings', open_bookings_for(p_ig_user_id));
end $$;

-- ---------- cash per person per day ----------
create or replace function cash_report(p_day date default (now() at time zone 'America/New_York')::date, p_include_test boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_team_or_service();
  return jsonb_build_object('day', p_day, 'people', (
    select jsonb_agg(jsonb_build_object('name', t.name,
        'total', coalesce((select sum(b.sale_price) from bookings b where b.cash_collected_by = t.name
                            and (b.cash_collected_at at time zone 'America/New_York')::date = p_day and (p_include_test or not b.is_test)), 0),
        'bookings', coalesce((select jsonb_agg(crm_sale_row(b) || jsonb_build_object('cash_collected_at', b.cash_collected_at) order by b.cash_collected_at)
                                from bookings b where b.cash_collected_by = t.name
                                 and (b.cash_collected_at at time zone 'America/New_York')::date = p_day and (p_include_test or not b.is_test)), '[]'::jsonb))
      order by t.name)
    from team_members t));
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function sales_report(date, date, jsonb, boolean), monthly_report(integer, jsonb, boolean, date),
  customers_report(text, integer, boolean, text), customer_orders(uuid), cash_report(date, boolean), buyer_context(text)
  to authenticated, service_role;
grant execute on function record_dm(text, text, text) to service_role;
