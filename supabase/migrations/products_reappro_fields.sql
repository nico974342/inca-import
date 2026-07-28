-- Automated restocking (réassort): per-product reorder threshold and
-- supplier lead time, used to flag low stock and suggest reorder quantities.
alter table public.products
  add column if not exists seuil_reappro integer,
  add column if not exists delai_livraison_jours integer default 21;

comment on column public.products.seuil_reappro is
  'Reorder point in cartons — when stock_quantity drops to or below this, the product is flagged for restocking. Null = not tracked.';
comment on column public.products.delai_livraison_jours is
  'Supplier lead time in days, used to size suggested reorder quantities. Defaults to 21 days.';
