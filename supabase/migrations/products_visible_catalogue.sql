-- Visibilité catalogue par produit.
--
-- Un produit avec visible_catalogue = false est retiré de tout ce que voit un
-- client (catalogue, fiche, panier, catalogue PDF, chiffres de la page
-- d'accueil) mais reste entièrement géré en administration (stock, réception,
-- transit, commande fournisseur, marges, tarifs, commande rapide).
--
-- À LANCER AVANT de déployer le code correspondant : les pages sélectionnent
-- cette colonne et échoueraient sans elle.
--
-- Sans effet de comportement à la migration : tous les produits existants
-- prennent la valeur true (DEFAULT) et restent visibles.

-- ── 1. Colonne ──────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS visible_catalogue boolean NOT NULL DEFAULT true;

-- ── 2. order_create_checked : refuse les produits masqués ───────────────
-- Rempart définitif côté base (le panier est aussi nettoyé par la page
-- /commande, mais seul ce contrôle, dans la transaction, ne peut pas être
-- contourné). Un produit masqué est signalé comme un conflit « disponible = 0 »
-- — même mécanisme et même message que la rupture de stock.
--
-- Exception : la saisie staff (commande rapide) passe allow_hidden_products =
-- true dans p_order pour pouvoir vendre un produit masqué. La fonction n'est
-- exécutable que par service_role (voir stock_reserve.sql), donc ce drapeau ne
-- peut pas être fourni par un client.
--
-- CREATE OR REPLACE conserve les droits EXECUTE existants (service_role seul).
CREATE OR REPLACE FUNCTION public.order_create_checked(p_order jsonb, p_items jsonb)
 RETURNS TABLE(r_order_id uuid, r_conflicts jsonb)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_order_id     uuid;
  v_conflicts    jsonb;
  v_email        text;
  v_status       text;
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

  SELECT status INTO v_status
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

  -- Disponible recalculé maintenant, verrous tenus. Un produit masqué (hors
  -- saisie staff) compte comme indisponible.
  WITH req AS (
    SELECT (it->>'product_id')::uuid AS product_id,
           SUM((it->>'quantity')::int)::int AS qty
    FROM jsonb_array_elements(p_items) it
    WHERE it->>'product_id' IS NOT NULL
    GROUP BY 1
  )
  SELECT jsonb_agg(jsonb_build_object(
           'product_id',   req.product_id,
           'product_name', COALESCE(p.name, 'Produit inconnu'),
           'requested',    req.qty,
           'available',    CASE
                             WHEN NOT v_allow_hidden AND p.visible_catalogue = false THEN 0
                             ELSE GREATEST(0, COALESCE(a.available, 0))
                           END
         ) ORDER BY p.name)
    INTO v_conflicts
  FROM req
  LEFT JOIN products p             ON p.id = req.product_id
  LEFT JOIN product_availability a ON a.product_id = req.product_id
  WHERE p.id IS NULL                                    -- produit disparu
     OR (NOT v_allow_hidden AND p.visible_catalogue = false)   -- produit masqué
     OR req.qty > GREATEST(0, COALESCE(a.available, 0));

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

-- ── 3. Lecture publique directe de l'API : ne plus exposer les masqués ──────
-- Le site n'utilise jamais cette policy (tout passe par le serveur), mais elle
-- permet à quiconque possède la clé anon de lire les produits en stock.
-- Un produit masqué ne doit pas non plus être lisible par ce chemin.
DROP POLICY IF EXISTS "Public read in-stock products" ON products;
CREATE POLICY "Public read in-stock products" ON products
  FOR SELECT
  USING (in_stock = true AND visible_catalogue = true);
