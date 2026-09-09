-- Identifiant fournisseur stable pour les réceptions et les arrivages.
--
-- Jusqu'ici, le fournisseur d'un produit était déduit d'une correspondance
-- TEXTE entre stock_receptions.supplier_name / shipments.supplier_name et
-- suppliers.name (voir suppliers_table.sql). Un écart de libellé — casse,
-- espace, faute de frappe — fait silencieusement échouer la correspondance
-- et retomber le produit sur le délai/sécurité/couverture par défaut, sans
-- aucun signalement (bug réel : "Chane-Hive" vs "CHANE-HIVE", et plus tôt
-- "SOLO IMPORT" vs "SOLO IMPORT OI" — voir [[project_supplier_id_fk_todo]]).
--
-- Cette migration ajoute un vrai lien relationnel (supplier_id) SANS
-- supprimer le texte saisi (conservé comme snapshot, même convention que
-- order_items.*_snapshot) :
--   1. stock_receptions.supplier_id / shipments.supplier_id, en clé
--      étrangère vers suppliers(id).
--   2. reception_create / reception_update acceptent et stockent désormais
--      p_supplier_id (résolu côté application par matchSupplierName, voir
--      src/lib/constants.ts, AVANT l'appel RPC).
--   3. Rattachement rétroactif : les lignes existantes dont le texte,
--      normalisé (casse + espaces, RIEN d'autre — pas de ponctuation ni de
--      tiret), correspond à EXACTEMENT UN fournisseur sont liées. Les cas où
--      plusieurs fournisseurs partageraient la même clé normalisée sont
--      explicitement exclus (laissés NULL) plutôt que de choisir au hasard —
--      aucun cas de ce genre ne devrait exister aujourd'hui, mais le rejet
--      protège les rattachements futurs. Les textes qui ne correspondent à
--      aucun fournisseur (ex. "SAP", "CORE TRADING REUNION", "FRAIS IMPORT",
--      "Big Brand" au 2026-09-09) restent NULL et remontent comme "à
--      rapprocher" sur /admin/fournisseurs — aucune fusion automatique.
--
-- Compatibilité : p_supplier_id porte un DEFAULT NULL explicite sur les deux
-- fonctions (pas seulement une colonne nullable, qui ne rendrait rien
-- facultatif côté appel RPC) — un appelant qui ignore encore ce paramètre
-- (déploiement en cours au moment de cette migration) continue de fonctionner
-- à l'identique, supplier_id restant NULL comme avant. PostgREST invoque
-- toujours ces fonctions par nom de paramètre, jamais par position : l'ordre
-- de déclaration ci-dessous n'a donc aucune incidence sur les appels
-- existants ni sur les nouveaux.
--
-- Sécurité : ni reception_create ni reception_update ne portent SECURITY
-- DEFINER (comportement par défaut Postgres : exécution avec les droits de
-- l'appelant) — comme dans stock_rpc_functions.sql d'origine. L'accès reste
-- REVOKE pour PUBLIC/anon/authenticated et GRANT au seul service_role,
-- rappelé explicitement ci-dessous pour les nouvelles signatures : un
-- visiteur ou un client authentifié (rôles anon/authenticated, jamais
-- service_role) ne peut pas les appeler directement, quelle que soit la
-- signature. Le contrôle admin (isAdmin(user)) reste en plus la première
-- porte côté route API.
--
-- Transactionnel : toute la migration (schéma, fonctions, permissions,
-- rattachement rétroactif) s'applique ou échoue en bloc — voir BEGIN/COMMIT
-- en fin de fichier, avec un rafraîchissement explicite du cache de schéma
-- PostgREST une fois le tout validé.

BEGIN;

ALTER TABLE stock_receptions
  ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id);
CREATE INDEX IF NOT EXISTS stock_receptions_supplier_id_idx ON stock_receptions(supplier_id);

ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id);
CREATE INDEX IF NOT EXISTS shipments_supplier_id_idx ON shipments(supplier_id);

-- ── RPC : reception_create / reception_update stockent désormais supplier_id.
--    Signature étendue -> DROP explicite d'abord (CREATE OR REPLACE ne peut
--    pas ajouter un paramètre sans changer la signature, ce qui créerait un
--    doublon surchargé au lieu de remplacer). ──

DROP FUNCTION IF EXISTS reception_create(text, date, text, boolean, jsonb);

CREATE FUNCTION reception_create(
  p_supplier_name text,
  p_received_at   date,
  p_notes         text,
  p_stock_applied boolean,
  p_items         jsonb,
  p_supplier_id   uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id   uuid;
  v_pids uuid[];
BEGIN
  INSERT INTO stock_receptions (supplier_name, supplier_id, received_at, notes, stock_applied)
  VALUES (p_supplier_name, p_supplier_id, p_received_at, p_notes, p_stock_applied)
  RETURNING id INTO v_id;

  INSERT INTO stock_reception_items (reception_id, product_id, quantity, unit_cost_ht)
  SELECT v_id,
         (it->>'product_id')::uuid,
         (it->>'quantity')::int,
         (it->>'unit_cost_ht')::numeric
  FROM jsonb_array_elements(p_items) it;

  SELECT array_agg(DISTINCT (it->>'product_id')::uuid)
    INTO v_pids
    FROM jsonb_array_elements(p_items) it;

  PERFORM recalc_pump(v_pids);

  IF p_stock_applied THEN
    UPDATE products p
    SET stock_quantity = p.stock_quantity + agg.qty,
        in_stock       = (p.stock_quantity + agg.qty) > 0
    FROM (
      SELECT (it->>'product_id')::uuid AS product_id,
             SUM((it->>'quantity')::int)::int AS qty
      FROM jsonb_array_elements(p_items) it
      GROUP BY 1
    ) agg
    WHERE p.id = agg.product_id;
  END IF;

  RETURN v_id;
END;
$$;

DROP FUNCTION IF EXISTS reception_update(uuid, text, date, text, boolean, jsonb);

CREATE FUNCTION reception_update(
  p_reception_id  uuid,
  p_supplier_name text,
  p_received_at   date,
  p_notes         text,
  p_stock_applied boolean,
  p_items         jsonb,
  p_supplier_id   uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_old_applied boolean;
  v_pids        uuid[];
BEGIN
  SELECT stock_applied INTO v_old_applied
    FROM stock_receptions WHERE id = p_reception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception % not found', p_reception_id;
  END IF;

  IF v_old_applied THEN
    UPDATE products p
    SET stock_quantity = GREATEST(0, p.stock_quantity - old.qty),
        in_stock       = GREATEST(0, p.stock_quantity - old.qty) > 0
    FROM (
      SELECT product_id, SUM(quantity)::int AS qty
      FROM stock_reception_items
      WHERE reception_id = p_reception_id
      GROUP BY product_id
    ) old
    WHERE p.id = old.product_id;
  END IF;

  -- old ∪ new products all need their PUMP recalculated
  SELECT array_agg(DISTINCT pid) INTO v_pids FROM (
    SELECT product_id AS pid FROM stock_reception_items WHERE reception_id = p_reception_id
    UNION
    SELECT (it->>'product_id')::uuid FROM jsonb_array_elements(p_items) it
  ) u;

  DELETE FROM stock_reception_items WHERE reception_id = p_reception_id;

  INSERT INTO stock_reception_items (reception_id, product_id, quantity, unit_cost_ht)
  SELECT p_reception_id,
         (it->>'product_id')::uuid,
         (it->>'quantity')::int,
         (it->>'unit_cost_ht')::numeric
  FROM jsonb_array_elements(p_items) it;

  UPDATE stock_receptions
  SET supplier_name = p_supplier_name,
      supplier_id   = p_supplier_id,
      received_at   = p_received_at,
      notes         = p_notes,
      stock_applied = p_stock_applied
  WHERE id = p_reception_id;

  PERFORM recalc_pump(v_pids);

  IF p_stock_applied THEN
    UPDATE products p
    SET stock_quantity = p.stock_quantity + agg.qty,
        in_stock       = (p.stock_quantity + agg.qty) > 0
    FROM (
      SELECT (it->>'product_id')::uuid AS product_id,
             SUM((it->>'quantity')::int)::int AS qty
      FROM jsonb_array_elements(p_items) it
      GROUP BY 1
    ) agg
    WHERE p.id = agg.product_id;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION reception_create(text, date, text, boolean, jsonb, uuid)      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION reception_update(uuid, text, date, text, boolean, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reception_create(text, date, text, boolean, jsonb, uuid)      TO service_role;
GRANT EXECUTE ON FUNCTION reception_update(uuid, text, date, text, boolean, jsonb, uuid) TO service_role;

-- ── Rattachement rétroactif : correspondance exacte après normalisation
--    (casse + espaces), jamais quand plusieurs fournisseurs partagent la
--    même clé normalisée. ──

WITH normalized_suppliers AS (
  SELECT id, upper(regexp_replace(btrim(name), '\s+', ' ', 'g')) AS key
  FROM suppliers
),
unique_keys AS (
  SELECT key FROM normalized_suppliers GROUP BY key HAVING count(*) = 1
)
UPDATE stock_receptions r
SET supplier_id = ns.id
FROM normalized_suppliers ns
JOIN unique_keys uk ON uk.key = ns.key
WHERE r.supplier_id IS NULL
  AND r.supplier_name IS NOT NULL
  AND upper(regexp_replace(btrim(r.supplier_name), '\s+', ' ', 'g')) = ns.key;

WITH normalized_suppliers AS (
  SELECT id, upper(regexp_replace(btrim(name), '\s+', ' ', 'g')) AS key
  FROM suppliers
),
unique_keys AS (
  SELECT key FROM normalized_suppliers GROUP BY key HAVING count(*) = 1
)
UPDATE shipments s
SET supplier_id = ns.id
FROM normalized_suppliers ns
JOIN unique_keys uk ON uk.key = ns.key
WHERE s.supplier_id IS NULL
  AND s.supplier_name IS NOT NULL
  AND upper(regexp_replace(btrim(s.supplier_name), '\s+', ' ', 'g')) = ns.key;

-- PostgREST doit connaître la nouvelle signature de reception_create /
-- reception_update avant qu'aucun appel (ancien ou nouveau) ne les invoque —
-- sans ce rafraîchissement, un appel juste après cette migration risquerait
-- une erreur "function not found in schema cache" le temps que PostgREST
-- détecte le changement par lui-même.
NOTIFY pgrst, 'reload schema';

COMMIT;
