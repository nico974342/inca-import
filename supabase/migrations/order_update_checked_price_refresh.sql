-- Bug : modifier une commande existante (changement de quantité, ajout d'une
-- ligne, etc.) ne permettait JAMAIS de corriger le prix d'une ligne déjà
-- présente. order_update_checked (voir order_update_checked.sql) ne SET que
-- `quantity` dans son étape 1 — price_ht_snapshot restait figé à sa valeur
-- de création, même quand l'écran d'édition affichait un nouveau prix pour
-- cette ligne et que l'appelant tentait de le sauvegarder.
--
-- Cas réel : une ligne créée avec price_ht_snapshot = 0 € (prix produit à 0
-- par erreur au moment de la commande) restait à 0 € pour toujours, même
-- après correction du prix catalogue.
--
-- Ce correctif rend price_ht_snapshot éditable ligne par ligne, à la
-- discrétion de l'admin (écran de modification, champ prix — voir
-- edit.astro et src/pages/api/admin/orders/[id]/update.ts) :
--   - `quantity` est toujours réécrite (comportement inchangé) ;
--   - `price_ht_snapshot` n'est réécrit QUE si l'appelant envoie une valeur
--     non nulle pour cette ligne précise (COALESCE conserve sinon la valeur
--     existante) — jamais de recalcul automatique depuis le catalogue au
--     simple fait d'enregistrer une commande ;
--   - `tva_rate_snapshot` et `pump_snapshot` ne sont jamais réécrits par une
--     édition, intentionnellement : l'écran ne permet pas de les corriger,
--     donc il n'y a rien à leur appliquer ici (comportement inchangé par
--     rapport à la version originale de ce fichier).
-- Modifier UNIQUEMENT une quantité (aucune valeur de prix envoyée) laisse
-- ainsi le price_ht_snapshot de CETTE ligne — et de toutes les autres —
-- strictement inchangé.

CREATE OR REPLACE FUNCTION public.order_update_checked(p_order_id uuid, p_items jsonb)
 RETURNS TABLE(r_conflicts jsonb)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_conflicts jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'order_update_checked: aucune ligne';
  END IF;

  -- Verrou sur la commande elle-même en premier (sérialise deux éditions
  -- concurrentes de la même commande), puis sur les produits concernés par id
  -- croissant — même ordre de verrouillage que order_create_checked pour
  -- limiter le risque d'interblocage entre les deux fonctions.
  PERFORM 1 FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_update_checked: commande introuvable';
  END IF;

  PERFORM 1
  FROM products
  WHERE id IN (
    SELECT DISTINCT (it->>'product_id')::uuid
    FROM jsonb_array_elements(p_items) it
    WHERE it->>'product_id' IS NOT NULL
  )
  ORDER BY id
  FOR UPDATE;

  -- Disponible recalculé maintenant, verrous tenus, en excluant les propres
  -- lignes de la commande éditée de la réservation des « autres ».
  WITH req AS (
    SELECT (it->>'product_id')::uuid AS product_id,
           SUM((it->>'quantity')::int)::int AS qty
    FROM jsonb_array_elements(p_items) it
    WHERE it->>'product_id' IS NOT NULL
    GROUP BY 1
  ),
  reserved_others AS (
    SELECT oi.product_id, SUM(oi.quantity)::int AS qty
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = ANY(stock_reserving_statuses())
      AND o.id <> p_order_id
      AND oi.product_id IS NOT NULL
    GROUP BY oi.product_id
  )
  SELECT jsonb_agg(jsonb_build_object(
           'product_id',   req.product_id,
           'product_name', COALESCE(p.name, 'Produit inconnu'),
           'requested',    req.qty,
           'available',    GREATEST(0, COALESCE(p.stock_quantity, 0) - COALESCE(ro.qty, 0))
         ) ORDER BY p.name)
    INTO v_conflicts
  FROM req
  LEFT JOIN products p          ON p.id = req.product_id
  LEFT JOIN reserved_others ro  ON ro.product_id = req.product_id
  WHERE p.id IS NULL                                                              -- produit disparu
     OR req.qty > GREATEST(0, COALESCE(p.stock_quantity, 0) - COALESCE(ro.qty, 0));

  IF v_conflicts IS NOT NULL THEN
    r_conflicts := v_conflicts;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Tout passe : diff atomique des lignes.
  -- 1) Lignes déjà présentes : quantité toujours mise à jour ; le prix n'est
  -- réécrit que si l'appelant envoie explicitement une valeur pour cette
  -- ligne (COALESCE conserve sinon price_ht_snapshot tel quel). TVA et coût
  -- restent hors de portée d'une édition, volontairement.
  UPDATE order_items oi
  SET quantity          = (it->>'quantity')::int,
      price_ht_snapshot = COALESCE(NULLIF(it->>'price_ht_snapshot', '')::numeric, oi.price_ht_snapshot)
  FROM jsonb_array_elements(p_items) it
  WHERE oi.order_id = p_order_id
    AND oi.product_id = (it->>'product_id')::uuid;

  -- 2) Nouvelles lignes (produit pas encore présent sur cette commande).
  INSERT INTO order_items (
    order_id, product_id, product_name, quantity, unit,
    price_ht_snapshot, tva_rate_snapshot, pump_snapshot
  )
  SELECT p_order_id,
         (it->>'product_id')::uuid,
         it->>'product_name',
         (it->>'quantity')::int,
         NULLIF(it->>'unit', ''),
         NULLIF(it->>'price_ht_snapshot', '')::numeric,
         NULLIF(it->>'tva_rate_snapshot', '')::numeric,
         NULLIF(it->>'pump_snapshot', '')::numeric
  FROM jsonb_array_elements(p_items) it
  WHERE NOT EXISTS (
    SELECT 1 FROM order_items oi
    WHERE oi.order_id = p_order_id AND oi.product_id = (it->>'product_id')::uuid
  );

  -- 3) Lignes retirées (produit présent avant, absent de p_items).
  DELETE FROM order_items oi
  WHERE oi.order_id = p_order_id
    AND oi.product_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_items) it
      WHERE (it->>'product_id')::uuid = oi.product_id
    );

  r_conflicts := '[]'::jsonb;
  RETURN NEXT;
END;
$function$;
