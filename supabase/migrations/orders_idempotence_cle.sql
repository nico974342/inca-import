-- Commandes clients : la MÊME clé d'envoi ne crée jamais deux commandes (double clic, nouvel essai après une coupure réseau, réponse perdue).
-- ADDITIF : une colonne facultative, un index unique partiel, une fonction. NON APPLIQUÉ en production tant que l'utilisateur ne l'a pas autorisé.
--
-- Principe : order_create_idempotent(p_cle, p_order, p_items) prend un verrou de transaction propre à la clé, puis
--   1. si une commande porte déjà cette clé (même client) → la renvoie (r_deja = true), sans rien créer ;
--   2. sinon délègue à order_create_checked — INCHANGÉE : même contrôle de compte actif, mêmes verrous sur les produits, même calcul du disponible, mêmes conflits —,
--      puis pose la clé sur la commande créée, dans la MÊME transaction.
-- Deux envois simultanés avec la même clé : le second attend le premier, puis trouve la commande déjà créée. Un refus pour stock ne consomme pas la clé.
-- Aucune donnée existante n'est modifiée (orders.cle_commande reste NULL pour les commandes existantes). Aucune fonction existante n'est modifiée.
-- La fonction est réservée au serveur du site (service_role), comme order_create_checked.

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS cle_commande uuid;
CREATE UNIQUE INDEX IF NOT EXISTS orders_cle_commande_idx ON orders (cle_commande) WHERE cle_commande IS NOT NULL;
COMMENT ON COLUMN orders.cle_commande IS 'Clé d''envoi (idempotence) : la même clé ne crée jamais deux commandes. NULL pour les commandes sans clé (existantes, saisie administrateur).';

CREATE OR REPLACE FUNCTION order_create_idempotent(p_cle uuid, p_order jsonb, p_items jsonb)
RETURNS TABLE(r_order_id uuid, r_conflicts jsonb, r_deja boolean)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid;
  o record;
  v record;
BEGIN
  -- Sans clé : arrêt immédiat, AVANT toute lecture ou écriture (c'est aussi la sonde d'existence utilisée par le site, sans effet).
  IF p_cle IS NULL THEN RAISE EXCEPTION 'CLE_REQUISE'; END IF;
  v_user := NULLIF(p_order->>'user_id', '')::uuid;

  PERFORM pg_advisory_xact_lock(hashtextextended('order_idem:' || p_cle::text, 0));

  SELECT id, user_id INTO o FROM orders WHERE cle_commande = p_cle;
  IF FOUND THEN
    IF o.user_id IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'CLE_DEJA_UTILISEE'; END IF;
    r_order_id := o.id; r_conflicts := '[]'::jsonb; r_deja := true;
    RETURN NEXT; RETURN;
  END IF;

  SELECT * INTO v FROM order_create_checked(p_order, p_items);
  IF v.r_order_id IS NOT NULL THEN
    UPDATE orders SET cle_commande = p_cle WHERE id = v.r_order_id;
  END IF;
  r_order_id := v.r_order_id; r_conflicts := v.r_conflicts; r_deja := false;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION order_create_idempotent(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION order_create_idempotent(uuid, jsonb, jsonb) TO service_role;

COMMIT;

-- Retour arrière (sans perte de commande : seule la clé d'idempotence disparaît) :
--   DROP FUNCTION order_create_idempotent(uuid, jsonb, jsonb);
--   DROP INDEX orders_cle_commande_idx;
--   ALTER TABLE orders DROP COLUMN cle_commande;
-- Le site retombe alors automatiquement sur order_create_checked (détection de la fonction absente).
