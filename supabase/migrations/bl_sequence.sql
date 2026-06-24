-- BL sequential numbering: atomic, never resets, never duplicates
CREATE SEQUENCE IF NOT EXISTS bl_number_seq START 1;

CREATE OR REPLACE FUNCTION next_bl_number()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT 'BL-' || lpad(nextval('bl_number_seq')::text, 4, '0');
$$;

-- Grant execute to authenticated and service roles
GRANT EXECUTE ON FUNCTION next_bl_number() TO authenticated, service_role;
