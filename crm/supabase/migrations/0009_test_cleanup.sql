-- Triangle Resells CRM v1: delete all TEST data after the end-to-end tests (the brief: "After tests: delete all test
-- data"). Only rows marked is_test go; real bookings, customers, stock and history are never touched. Bot only.

create or replace function delete_test_data(p_actor text default 'System') returns jsonb
language plpgsql security definer set search_path = public as $$
declare n_bookings integer; n_restocks integer; n_videos integer; n_customers integer; n_stock integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'bot only' using errcode = '42501'; end if;
  perform crm_begin(p_actor, 'Deleted TEST data');
  -- Bookings first: their lines give TEST stock back on the way out (TEST stock only), then go with them.
  with d as (delete from bookings where is_test returning 1) select count(*) into n_bookings from d;
  with d as (delete from restocks where is_test returning 1) select count(*) into n_restocks from d;
  with d as (delete from video_ideas where is_test returning 1) select count(*) into n_videos from d;
  -- TEST customers that no real booking points to.
  with d as (delete from customers c where c.is_test and not exists (select 1 from bookings b where b.customer_id = c.id) returning 1)
    select count(*) into n_customers from d;
  delete from bot_events where is_test;
  delete from team_notifications where is_test;
  delete from stock_moves where is_test;
  with d as (delete from stock_items s where s.is_test
                and not exists (select 1 from booking_items i where i.stock_item_id = s.id)
                and not exists (select 1 from restock_items r where r.stock_item_id = s.id) returning 1)
    select count(*) into n_stock from d;
  -- The log lines about test rows (including the ones these deletes just wrote) go last.
  delete from activity_log where is_test;
  return jsonb_build_object('bookings', n_bookings, 'restocks', n_restocks, 'video_ideas', n_videos, 'customers', n_customers, 'test_stock_rows', n_stock);
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function delete_test_data(text) to service_role;
