-- Bug : modifier une commande existante (changement de quantité, ajout d'une
-- ligne, etc.) ne rafraîchissait jamais le prix/TVA/coût des lignes DÉJÀ
-- présentes. order_update_checked (voir order_update_checked.sql) ne SET
-- que `quantity` dans son étape 1 — price_ht_snapshot, tva_rate_snapshot et
-- pump_snapshot restaient figés à leur valeur de création, même quand
-- l'appelant en envoyait une nouvelle valeur (src/pages/api/admin/orders/
-- [id]/update.ts envoyait d'ailleurs `null` pour ces trois colonnes sur les
-- lignes existantes, en s'appuyant explicitement sur le fait qu'elles ne
-- seraient pas touchées).
--
-- Cas réel : une ligne créée avec price_ht_snapshot = 0 € (prix produit à 0
-- par erreur au moment de la commande) restait à 0 € pour toujours, même
-- après correction du prix catalogue et modification explicite de la
-- commande par un admin — la ligne rouverte affichait encore 0 €.
--
-- Ce correctif fait ré-évaluer price_ht_snapshot / tva_rate_snapshot /
-- pump_snapshot à chaque édition, pour toutes les lignes conservées, à
-- partir du produit actuel — exactement comme une ligne nouvellement
-- ajoutée l'est déjà (voir l'étape 2, INSERT, inchangée). C'est un choix
-- délibéré : "modifier la commande" doit refléter les prix catalogue
-- actuels sur les lignes retouchées, pas seulement sur les lignes ajoutées.
-- L'appelant doit désormais envoyer un price_ht_snapshot/tva_rate_snapshot/
-- pump_snapshot résolu pour CHAQUE ligne (existante ou nouvelle) ; NULL reste
-- interprété comme "conserve la valeur actuelle" (COALESCE), pour le cas où
-- le produit a disparu du catalogue entre-temps.

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
  -- 1) Lignes déjà présentes : quantité ET prix/TVA/coût ré-alignés sur le
  -- produit actuel (COALESCE conserve l'existant si l'appelant envoie NULL,
  -- ex. produit disparu du catalogue).
  UPDATE order_items oi
  SET quantity          = (it->>'quantity')::int,
      price_ht_snapshot = COALESCE(NULLIF(it->>'price_ht_snapshot', '')::numeric, oi.price_ht_snapshot),
      tva_rate_snapshot = COALESCE(NULLIF(it->>'tva_rate_snapshot', '')::numeric, oi.tva_rate_snapshot),
      pump_snapshot      = COALESCE(NULLIF(it->>'pump_snapshot', '')::numeric, oi.pump_snapshot)
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
