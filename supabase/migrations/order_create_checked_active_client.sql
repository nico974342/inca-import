-- Faille 2 (audit externe) : un compte dont client_accounts.status n'est pas
-- 'actif' (en_attente, suspendu, ou même prospect) pouvait passer commande.
-- Le catalogue masquait les boutons et l'admin validait manuellement à
-- l'inscription, mais rien côté serveur n'empêchait un appel direct.
--
-- order_create_checked est le SEUL chemin de création de commande autorisé
-- par l'application (voir src/lib/stock.ts) — c'est donc ici, dans la même
-- transaction que la vérification de stock, que le contrôle doit vivre pour
-- être réellement infranchissable. Une vérification côté page ne protège de
-- rien (elle est ajoutée en plus, pour l'ergonomie, pas comme rempart).
--
-- client_accounts n'a pas de colonne user_id (choix assumé, voir
-- schema_v11.sql) : le rapprochement se fait par email, insensible à la
-- casse, comme partout ailleurs dans le code applicatif.
--
-- Un email absent, ou ne correspondant à aucune fiche client, ou correspondant
-- à une fiche dont le statut n'est pas 'actif', est rejeté en levant
-- l'exception 'COMPTE_NON_ACTIF' — reconnue explicitement par
-- src/lib/stock.ts (createOrderChecked) pour afficher un message clair côté
-- application plutôt qu'une erreur générique.

CREATE OR REPLACE FUNCTION public.order_create_checked(p_order jsonb, p_items jsonb)
 RETURNS TABLE(r_order_id uuid, r_conflicts jsonb)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_order_id  uuid;
  v_conflicts jsonb;
  v_email     text;
  v_status    text;
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

  -- Disponible recalculé maintenant, verrous tenus.
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
           'available',    GREATEST(0, COALESCE(a.available, 0))
         ) ORDER BY p.name)
    INTO v_conflicts
  FROM req
  LEFT JOIN products p             ON p.id = req.product_id
  LEFT JOIN product_availability a ON a.product_id = req.product_id
  WHERE p.id IS NULL                                    -- produit disparu
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
