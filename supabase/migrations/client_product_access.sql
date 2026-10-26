-- Accès individuel aux produits masqués du catalogue.
--
-- products.visible_catalogue reste l'interrupteur principal :
--   true                          → visible par tout le monde
--   false et client non autorisé  → invisible
--   false et client autorisé      → visible pour ce client seul
-- Un visiteur non connecté ne voit jamais un produit masqué.
--
-- Pré-requis : products_visible_catalogue.sql déjà appliquée.
-- À LANCER AVANT de déployer le code correspondant.
--
-- Aucun changement de comportement à la migration : la table est vide.

-- ── 1. Table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_product_access (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid        NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
  product_id  uuid        NOT NULL REFERENCES products(id)        ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, product_id)
);

-- UNIQUE (client_id, product_id) couvre déjà les recherches par client ;
-- celui-ci sert au dénombrement par produit (/admin/produits).
CREATE INDEX IF NOT EXISTS client_product_access_product_idx
  ON client_product_access (product_id);

-- Accès uniquement via la clé service_role (comme les autres tables métier) :
-- RLS activée sans aucune policy, et plus aucun privilège pour anon/authenticated
-- (leur donner tous les droits par défaut serait ici sans objet et risqué).
ALTER TABLE client_product_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON client_product_access FROM anon, authenticated;

-- ── 2. order_create_checked : un produit masqué n'est refusé qu'aux clients
--       non autorisés ───────────────────────────────────────────────────────
-- Même fonction que products_visible_catalogue.sql ; seule change la règle
-- « masqué » : le client (résolu par son e-mail, comme le contrôle de compte
-- actif) doit avoir une ligne dans client_product_access pour ce produit.
-- Toujours exécutable par service_role seul (CREATE OR REPLACE conserve les
-- droits). Saisie staff : allow_hidden_products = true court-circuite le test.
CREATE OR REPLACE FUNCTION public.order_create_checked(p_order jsonb, p_items jsonb)
 RETURNS TABLE(r_order_id uuid, r_conflicts jsonb)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_order_id     uuid;
  v_conflicts    jsonb;
  v_email        text;
  v_status       text;
  v_client_id    uuid;
  v_allow_hidden boolean := COALESCE((p_order->>'allow_hidden_products')::boolean, false);
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'order_create_checked: aucune ligne';
  END IF;

  -- ── Faille 2 : le compte doit être actif ──────────────────────────────
  v_email := NULLIF(lower(trim(p_order->>'email')), '');

  IF v_email IS NULL THEN
    RAISE EXCEPTION 'COMPTE_NON_ACTIF';
  END IF;

  SELECT id, status INTO v_client_id, v_status
  FROM client_accounts
  WHERE lower(email) = v_email;

  IF v_status IS NULL OR v_status <> 'actif' THEN
    RAISE EXCEPTION 'COMPTE_NON_ACTIF';
  END IF;

  -- Verrou par id croissant : deux commandes portant les mêmes produits dans
  -- un ordre différent se bloqueraient mutuellement sans ce tri.
  PERFORM 1
  FROM products
  WHERE id IN (
    SELECT DISTINCT (it->>'product_id')::uuid
    FROM jsonb_array_elements(p_items) it
    WHERE it->>'product_id' IS NOT NULL
  )
  ORDER BY id
  FOR UPDATE;

  -- Disponible recalculé maintenant, verrous tenus. Un produit masqué est
  -- indisponible, sauf saisie staff ou client explicitement autorisé.
  WITH req AS (
    SELECT (it->>'product_id')::uuid AS product_id,
           SUM((it->>'quantity')::int)::int AS qty
    FROM jsonb_array_elements(p_items) it
    WHERE it->>'product_id' IS NOT NULL
    GROUP BY 1
  ),
  chk AS (
    SELECT req.product_id,
           req.qty,
           p.name,
           (p.id IS NULL) AS gone,
           (NOT v_allow_hidden
            AND p.visible_catalogue = false
            AND NOT EXISTS (
              SELECT 1 FROM client_product_access cpa
              WHERE cpa.client_id = v_client_id AND cpa.product_id = req.product_id
            )) AS blocked,
           GREATEST(0, COALESCE(a.available, 0)) AS avail
    FROM req
    LEFT JOIN products p             ON p.id = req.product_id
    LEFT JOIN product_availability a ON a.product_id = req.product_id
  )
  SELECT jsonb_agg(jsonb_build_object(
           'product_id',   chk.product_id,
           'product_name', COALESCE(chk.name, 'Produit inconnu'),
           'requested',    chk.qty,
           'available',    CASE WHEN chk.blocked THEN 0 ELSE chk.avail END
         ) ORDER BY chk.name)
    INTO v_conflicts
  FROM chk
  WHERE chk.gone                 -- produit disparu
     OR chk.blocked              -- produit masqué non autorisé
     OR chk.qty > chk.avail;

  IF v_conflicts IS NOT NULL THEN
    r_order_id  := NULL;
    r_conflicts := v_conflicts;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO orders (user_id, nom, societe, telephone, email, notes, status)
  VALUES (
    NULLIF(p_order->>'user_id', '')::uuid,
    COALESCE(p_order->>'nom', ''),
    COALESCE(p_order->>'societe', ''),
    COALESCE(p_order->>'telephone', ''),
    NULLIF(p_order->>'email', ''),
    NULLIF(p_order->>'notes', ''),
    'en_attente'
  )
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (
    order_id, product_id, product_name, quantity, unit,
    price_ht_snapshot, tva_rate_snapshot, pump_snapshot
  )
  SELECT v_order_id,
         (it->>'product_id')::uuid,
         it->>'product_name',
         (it->>'quantity')::int,
         NULLIF(it->>'unit', ''),
         NULLIF(it->>'price_ht_snapshot', '')::numeric,
         NULLIF(it->>'tva_rate_snapshot', '')::numeric,
         NULLIF(it->>'pump_snapshot', '')::numeric
  FROM jsonb_array_elements(p_items) it;

  r_order_id  := v_order_id;
  r_conflicts := '[]'::jsonb;
  RETURN NEXT;
END;
$function$;
