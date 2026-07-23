-- Add "divers" as a valid product category
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_check;
ALTER TABLE products ADD CONSTRAINT products_category_check
  CHECK (category IN ('boissons', 'snacks', 'confiseries', 'divers'));
