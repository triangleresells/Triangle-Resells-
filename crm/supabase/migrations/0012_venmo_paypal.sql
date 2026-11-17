-- Venmo and PayPal are accepted payment methods (Josh, Nov 17 2026). Josh approved this ONE change to an existing
-- CRM table: the allowed list on bookings.payment_method gets 'venmo' and 'paypal' added. Nothing is removed or
-- renamed and no row changes. Documented in docs/schema.md.
alter table bookings drop constraint if exists bookings_payment_method_check;
alter table bookings add constraint bookings_payment_method_check
  check (payment_method in ('cash', 'cash_app', 'zelle', 'stripe', 'apple_pay', 'venmo', 'paypal'));
