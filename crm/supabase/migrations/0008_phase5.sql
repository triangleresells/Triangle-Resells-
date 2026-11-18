-- Triangle Resells CRM v1, phase 5: team notifications, video ideas, old sales import.

-- ======================================================================================
-- Notifications: an outbox the bot posts to the team's Discord / Slack channel.
-- The bot's own bookings, reschedules and cancels already alert (with payment instructions), so those are skipped here.
-- ======================================================================================
create table if not exists team_notifications (
  id bigserial primary key,
  at timestamptz not null default now(),
  kind text not null,                  -- booked, rescheduled, cancelled, no_show, out_of_stock, video_ideas
  text text not null,
  actor text not null,
  booking_id uuid,
  is_test boolean not null default false
);

create or replace function crm_when_text(d date, t time) returns text language sql immutable as $$
  select trim(to_char(d, 'Dy Mon FMDD') || coalesce(' ' || ltrim(to_char(t, 'FMHH12:MI AM'), '0'), ''))
$$;

create or replace function crm_booking_line(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select concat_ws(', ',
    coalesce(nullif('@' || c.ig_handle, '@'), c.name, 'a buyer'),
    (select string_agg(i.qty || 'x ' || concat_ws(' ', i.item, i.color, case when crm_size_key(i.size) = '' then null else i.size end), ', ' order by i.created_at)
       from booking_items i where i.booking_id = b.id),
    b.fulfillment, '$' || trim(to_char(b.sale_price, 'FM999999990.00')))
  from bookings b left join customers c on c.id = b.customer_id where b.id = p_id
$$;

create or replace function crm_notify_booking() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text := crm_actor(); line text; tag text := case when new.is_test then '[TEST] ' else '' end;
begin
  if a = 'Bot' then return null; end if;           -- the bot already alerted for its own changes
  -- Imported history never notifies (checked on the row: this runs at commit, after the import finished).
  if new.imported_from is not null then return null; end if;
  line := crm_booking_line(new.id);
  if line is null then return null; end if;
  if tg_op = 'INSERT' then
    if new.status not in ('cancelled', 'no_show') then
      insert into team_notifications (kind, text, actor, booking_id, is_test) values ('booked',
        tag || '📅 ' || a || ' booked a sale for ' || crm_when_text(new.date, new.time) || ': ' || line
          || '. Fulfilling: ' || coalesce(new.assignee, 'nobody yet') || '.', a, new.id, new.is_test);
    end if;
  elsif (old.date, old.time) is distinct from (new.date, new.time) and new.status not in ('cancelled', 'no_show', 'done') then
    insert into team_notifications (kind, text, actor, booking_id, is_test) values ('rescheduled',
      tag || '🔁 ' || a || ' rescheduled ' || line || ' to ' || crm_when_text(new.date, new.time) || ' (was ' || crm_when_text(old.date, old.time) || ').', a, new.id, new.is_test);
  elsif old.status <> new.status and new.status in ('cancelled', 'no_show') then
    insert into team_notifications (kind, text, actor, booking_id, is_test) values (new.status,
      tag || case new.status when 'cancelled' then '❌ ' || a || ' cancelled ' else '🚫 No-show (marked by ' || a || '): ' end
        || line || ' on ' || crm_when_text(new.date, new.time) || coalesce(' (' || new.status_reason || ')', '') || '.', a, new.id, new.is_test);
  end if;
  return null;
end $$;
drop trigger if exists bookings_notify on bookings;
create constraint trigger bookings_notify after insert or update on bookings
  deferrable initially deferred for each row execute function crm_notify_booking();

create or replace function crm_notify_stock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.qty = 0 and old.qty > 0 and new.status = 'for_sale' then
    insert into team_notifications (kind, text, actor, is_test) values ('out_of_stock',
      case when new.is_test then '[TEST] ' else '' end || '⚠️ Out of stock: ' || concat_ws(' ', new.item, new.color, case when crm_size_key(new.size) = '' then null else new.size end)
        || '. The bot won''t sell it until it''s restocked.', crm_actor(), new.is_test);
  end if;
  return null;
end $$;
drop trigger if exists stock_items_notify on stock_items;
-- At commit too, so "out of stock" comes after the booking that sold the last piece.
create constraint trigger stock_items_notify after update of qty on stock_items
  deferrable initially deferred for each row execute function crm_notify_stock();

create or replace function notifications_after(p_after bigint, p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'bot only' using errcode = '42501'; end if;
  if p_after is null then
    return jsonb_build_object('notifications', '[]'::jsonb, 'latest', coalesce((select max(id) from team_notifications), 0));
  end if;
  return jsonb_build_object(
    'notifications', coalesce((select jsonb_agg(to_jsonb(n) order by n.id) from (
      select * from team_notifications where id > p_after order by id limit least(greatest(p_limit, 1), 500)) n), '[]'::jsonb),
    'latest', coalesce((select max(id) from team_notifications), 0));
end $$;

-- ======================================================================================
-- Video ideas: daily, per account. Goals: Resells 3, Scales 2, Sales 6 (incl. a meetup video).
-- ======================================================================================
create table if not exists video_ideas (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  account text not null check (account in ('resells', 'scales', 'sales')),
  hook text not null check (length(trim(hook)) between 1 and 300),
  meetup boolean not null default false,
  status text not null default 'todo' check (status in ('todo', 'filmed', 'posted')),
  posted_to text[] not null default '{}' check (posted_to <@ array['resells', 'scales', 'sales']),
  post_link text,
  views integer check (views >= 0),
  auto boolean not null default false,   -- generated by the bot
  sort integer not null default 0,
  created_by text not null default 'System',
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists video_ideas_day_idx on video_ideas (day);
drop trigger if exists video_ideas_touch on video_ideas;
create trigger video_ideas_touch before update on video_ideas for each row execute function crm_touch();
drop trigger if exists video_ideas_log on video_ideas;
create trigger video_ideas_log after insert or update or delete on video_ideas for each row execute function crm_log_change();

create or replace function crm_undoable() returns text[] language sql immutable as $$
  select array['customers', 'bookings', 'booking_items', 'restocks', 'restock_items', 'bot_notes', 'video_ideas']
$$;

create or replace function video_goals() returns jsonb language sql immutable as $$
  select '{"resells": 3, "scales": 2, "sales": 6}'::jsonb
$$;

-- p_ideas: [{account, hook, meetup}]. Returns the day's ideas.
create or replace function add_video_ideas(p_day date, p_ideas jsonb, p_auto boolean default false, p_actor text default null, p_is_test boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a text; n integer;
begin
  a := crm_begin(p_actor);
  if p_ideas is null or jsonb_typeof(p_ideas) <> 'array' or jsonb_array_length(p_ideas) = 0 then
    raise exception 'no ideas given' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_ideas);
  perform crm_begin(p_actor, a || ' added ' || n || ' video idea' || case when n = 1 then '' else 's' end || ' for ' || p_day);
  insert into video_ideas (day, account, hook, meetup, auto, sort, created_by, is_test)
  select p_day, i ->> 'account', trim(i ->> 'hook'), coalesce((i ->> 'meetup')::boolean, false), p_auto,
         coalesce((select max(sort) from video_ideas where day = p_day), 0) + ord::integer, a, p_is_test
  from jsonb_array_elements(p_ideas) with ordinality as x(i, ord);
  if p_auto and n > 0 then
    insert into team_notifications (kind, text, actor, is_test) values ('video_ideas',
      case when p_is_test then '[TEST] ' else '' end || '🎬 ' || n || ' new video idea' || case when n = 1 then '' else 's' end
        || ' for ' || crm_when_text(p_day, null) || ' are in the CRM.', a, p_is_test);
  end if;
  return videos_for_day(p_day, p_is_test);
end $$;

-- p: {hook, status, posted_to, post_link, views, account, meetup}
create or replace function update_video_idea(p_id uuid, p jsonb, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a text; v video_ideas;
begin
  a := crm_begin(p_actor);
  select * into v from video_ideas where id = p_id for update;
  if v.id is null then raise exception 'no video idea %', p_id using errcode = 'P0002'; end if;
  perform crm_begin(p_actor, a || ' updated a video idea: ' || left(v.hook, 80));
  update video_ideas set
    hook = coalesce(nullif(trim(p ->> 'hook'), ''), hook),
    status = coalesce(nullif(p ->> 'status', ''), status),
    account = coalesce(nullif(p ->> 'account', ''), account),
    meetup = coalesce((p ->> 'meetup')::boolean, meetup),
    posted_to = case when p ? 'posted_to' then array(select jsonb_array_elements_text(p -> 'posted_to')) else posted_to end,
    post_link = case when p ? 'post_link' then nullif(trim(p ->> 'post_link'), '') else post_link end,
    views = case when p ? 'views' then (p ->> 'views')::integer else views end
  where id = p_id returning * into v;
  return to_jsonb(v);
end $$;

create or replace function delete_video_idea(p_id uuid, p_actor text default null) returns void
language plpgsql security definer set search_path = public as $$
declare a text;
begin
  a := crm_begin(p_actor, null);
  perform crm_begin(p_actor, a || ' removed a video idea');
  delete from video_ideas where id = p_id;
end $$;

create or replace function videos_for_day(p_day date, p_is_test boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_team_or_service();
  return jsonb_build_object('day', p_day, 'goals', video_goals(),
    'ideas', coalesce((select jsonb_agg(to_jsonb(v) order by v.account, v.sort, v.created_at) from video_ideas v where v.day = p_day and v.is_test = p_is_test), '[]'::jsonb));
end $$;

-- For the calendar: per day, how many ideas and how many posted.
create or replace function videos_between(p_from date, p_to date, p_is_test boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_team_or_service();
  return coalesce((select jsonb_object_agg(day, jsonb_build_object('ideas', n, 'posted', p)) from (
    select day, count(*) n, count(*) filter (where status = 'posted') p from video_ideas
     where day between p_from and p_to and is_test = p_is_test group by day) x), '{}'::jsonb);
end $$;

-- Recent hooks (so new ones don't repeat them).
create or replace function recent_hooks(p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_team_or_service();
  return coalesce((select jsonb_agg(hook order by created_at desc) from (
    select hook, created_at from video_ideas where created_at > now() - make_interval(days => p_days) and not is_test order by created_at desc limit 200) x), '[]'::jsonb);
end $$;

-- ======================================================================================
-- Profit also takes off other costs (e.g. a platform fee on old online sales).
-- ======================================================================================
alter table bookings add column if not exists other_costs numeric(10, 2) not null default 0 check (other_costs >= 0);
alter table bookings add column if not exists imported_from text;   -- "Nov 2026!A12": where an imported sale came from
create unique index if not exists bookings_imported_from_key on bookings (imported_from) where imported_from is not null;

create or replace function crm_sale_row(b bookings) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', b.id, 'date', b.date, 'time', b.time, 'status', b.status,
    'customer', (select jsonb_build_object('id', c.id, 'ig_handle', c.ig_handle, 'name', c.name, 'phone', c.phone) from customers c where c.id = b.customer_id),
    'items', coalesce((select jsonb_agg(jsonb_build_object('brand', i.brand, 'item', i.item, 'color', i.color, 'size', i.size, 'qty', i.qty,
        'unit_price', i.unit_price, 'unit_cost', i.unit_cost) order by i.created_at, i.id) from booking_items i where i.booking_id = b.id), '[]'::jsonb),
    'revenue', b.sale_price,
    'item_cost', coalesce((select sum(i.qty * i.unit_cost) from booking_items i where i.booking_id = b.id), 0),
    'label_cost', b.label_cost + b.other_costs,
    'cost_missing', exists (select 1 from booking_items i where i.booking_id = b.id and i.unit_cost is null),
    'profit', b.sale_price - coalesce((select sum(i.qty * i.unit_cost) from booking_items i where i.booking_id = b.id), 0) - b.label_cost - b.other_costs,
    'delivery_fee', b.delivery_fee, 'shipping_fee', b.shipping_fee,
    'payment_method', b.payment_method, 'fulfillment', b.fulfillment, 'location', b.location,
    'assignee', b.assignee, 'source', b.source, 'source_account', b.source_account, 'tracking_number', b.tracking_number,
    'cash_collected_by', b.cash_collected_by, 'imported', b.imported_from is not null, 'is_test', b.is_test)
$$;

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
             sum(b.sale_price - coalesce((select sum(i.qty * i.unit_cost) from booking_items i where i.booking_id = b.id), 0) - b.label_cost - b.other_costs) prof, count(*) n
        from bookings b where b.status = 'done' and (p_include_test or not b.is_test) and crm_sale_matches(b, coalesce(p_filters, '{}'))
       group by 1) x on x.mon = m
    left join (
      select date_trunc('month', b.date) mon, sum(b.sale_price) open
        from bookings b where b.status in ('booked', 'paid', 'paid_needs_check') and (p_include_test or not b.is_test) and crm_sale_matches(b, coalesce(p_filters, '{}'))
       group by 1) o on o.mon = m);
end $$;

-- ======================================================================================
-- Old sales import (from the sales tracker). Historical: Done, no stock reserved, no notifications.
-- p_rows: [{key, date, channel, handle, buyer_name, phone, products, cost, total, platform_fee, label_cost, payment, closer,
--           fulfillment, location, tracking, notes, items: [{item, color, size, qty}]}]
-- p_commit = false: a preview, nothing written. true: writes the rows not imported before.
-- ======================================================================================
create or replace function crm_import_payment(p text) returns text language sql immutable as $$
  select case
    when lower(coalesce(p, '')) ~ 'cash ?app' then 'cash_app'
    when lower(coalesce(p, '')) ~ 'zelle' then 'zelle'
    when lower(coalesce(p, '')) ~ 'apple' then 'apple_pay'
    when lower(coalesce(p, '')) ~ 'stripe|card|shopify' then 'stripe'
    else 'cash' end
$$;

create or replace function import_sales(p_rows jsonb, p_commit boolean default false, p_actor text default 'System') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; it jsonb; cust jsonb; bid uuid; pay text; ful text; total numeric; cost numeric; pieces integer; added integer := 0; skipped integer := 0; problems jsonb := '[]';
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'bot only' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be a list' using errcode = '22023'; end if;
  perform crm_begin(p_actor, 'Imported an old sale from the sales tracker');
  perform set_config('crm.importing', 'on', true);
  for r in select * from jsonb_array_elements(p_rows) loop
    if nullif(r ->> 'date', '') is null or nullif(r ->> 'total', '') is null then
      problems := problems || jsonb_build_object('key', r ->> 'key', 'problem', 'no date or no total');
      continue;
    end if;
    if exists (select 1 from bookings where imported_from = r ->> 'key') then skipped := skipped + 1; continue; end if;
    if not p_commit then added := added + 1; continue; end if;
    pay := crm_import_payment(r ->> 'payment');
    ful := coalesce(nullif(r ->> 'fulfillment', ''), 'pickup');
    if pay = 'cash' and ful <> 'pickup' then pay := 'cash_app'; end if;   -- old rows: cash can't be "shipped"; keep the sale
    total := (r ->> 'total')::numeric;
    cost := nullif(r ->> 'cost', '')::numeric;
    if nullif(r ->> 'handle', '') is not null or nullif(r ->> 'buyer_name', '') is not null or nullif(r ->> 'phone', '') is not null then
      cust := upsert_customer(jsonb_build_object('ig_handle', r ->> 'handle', 'name', r ->> 'buyer_name', 'phone', r ->> 'phone'), p_actor);
      perform set_config('crm.importing', 'on', true);
    else
      cust := null;
    end if;
    insert into bookings (date, customer_id, status, payment_method, fulfillment, sale_price, label_cost, other_costs, location,
                          assignee, source, tracking_number, notes, created_by, imported_from)
    values ((r ->> 'date')::date, (cust ->> 'id')::uuid, 'done', pay, ful, total,
            coalesce(nullif(r ->> 'label_cost', '')::numeric, 0), coalesce(nullif(r ->> 'platform_fee', '')::numeric, 0),
            nullif(r ->> 'location', ''), case when r ->> 'closer' in ('Josh', 'Chema', 'Diego') then r ->> 'closer' end,
            case when lower(coalesce(r ->> 'channel', '')) ~ 'insta|ig' then 'instagram' when lower(coalesce(r ->> 'channel', '')) ~ 'text' then 'text'
                 when lower(coalesce(r ->> 'channel', '')) ~ 'refer' then 'referral' when ful = 'pickup' then 'in_person' else 'other' end,
            case when ful = 'ship' then nullif(r ->> 'tracking', '') end,
            concat_ws(' · ', 'Imported from ' || (r ->> 'key'), nullif(r ->> 'products', ''), nullif(r ->> 'notes', '')),
            p_actor, r ->> 'key')
    returning id into bid;
    -- Lines: the parsed items, or one line with the whole "Products Sold" text. Cost is spread so the total matches the sheet.
    pieces := coalesce((select sum(greatest(coalesce((x ->> 'qty')::integer, 1), 1)) from jsonb_array_elements(coalesce(r -> 'items', '[]')) x), 0);
    if pieces = 0 then
      insert into booking_items (booking_id, item, size, qty, unit_price, unit_cost, reserved)
      values (bid, coalesce(nullif(left(r ->> 'products', 200), ''), 'Old sale'), 'One Size', 1, total, cost, false);
    else
      for it in select * from jsonb_array_elements(r -> 'items') loop
        insert into booking_items (booking_id, item, color, size, qty, unit_price, unit_cost, reserved)
        values (bid, it ->> 'item', nullif(it ->> 'color', ''), coalesce(nullif(it ->> 'size', ''), 'One Size'), greatest(coalesce((it ->> 'qty')::integer, 1), 1),
                round(total / pieces, 2), case when cost is null then null else round(cost / pieces, 2) end, false);
      end loop;
    end if;
    added := added + 1;
  end loop;
  perform set_config('crm.importing', '', true);
  return jsonb_build_object('committed', p_commit, (case when p_commit then 'imported' else 'would_import' end), added,
    'already_imported', skipped, 'problems', problems);
end $$;

-- Imports never reserve stock (they're history).
create or replace function crm_reserve_line() returns trigger
language plpgsql security definer set search_path = public as $$
declare s stock_items; st text;
begin
  if current_setting('crm.importing', true) = 'on' then return new; end if;
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
  if new.unit_cost is null then new.unit_cost := s.cost; end if;
  return new;
end $$;

-- Imported cash sales aren't "cash collected today".
create or replace function crm_cash_collect() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text := crm_actor();
begin
  if current_setting('crm.importing', true) = 'on' then return new; end if;
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
    new.cash_collected_at := null;
    new.cash_collected_by := null;
  end if;
  return new;
end $$;

alter table team_notifications enable row level security;
alter table video_ideas enable row level security;
drop policy if exists team_read on team_notifications;
create policy team_read on team_notifications for select to authenticated using (is_team());
drop policy if exists team_read on video_ideas;
create policy team_read on video_ideas for select to authenticated using (is_team());
revoke all on team_notifications, video_ideas from anon, authenticated;
grant select on team_notifications, video_ideas to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function notifications_after(bigint, integer), import_sales(jsonb, boolean, text) to service_role;
grant execute on function add_video_ideas(date, jsonb, boolean, text, boolean), update_video_idea(uuid, jsonb, text), delete_video_idea(uuid, text),
  videos_for_day(date, boolean), videos_between(date, date, boolean), recent_hooks(integer) to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table video_ideas;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
