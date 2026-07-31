-- Warehouse picking mode: tracks which order line has been physically
-- picked, so /admin/preparation progress survives reloads and is shared
-- between whoever is picking.
alter table public.order_items
  add column if not exists picked boolean not null default false;
