-- Commandes clients : la MÊME clé d'envoi ne crée jamais deux commandes (double clic, nouvel essai après une coupure réseau, réponse perdue).
-- ADDITIF : deux colonnes facultatives, un index unique partiel, une contrainte de cohérence, une fonction. NON APPLIQUÉ en production tant que l'utilisateur ne l'a pas autorisé.
-- OBLIGATOIRE pour le nouveau parcours de commande : sans cette fonction, le site REFUSE proprement l'envoi (le panier est conservé), il ne retombe jamais sur une création moins sûre.
--
-- Principe : order_create_idempotent(p_cle, p_order, p_items) prend un verrou de transaction propre à la clé, puis
--   1. si une commande porte déjà cette clé :
--        - d'un AUTRE client                        → CLE_DEJA_UTILISEE (aucune information sur la commande n'est renvoyée) ;
--        - du même client mais avec un AUTRE contenu → CLE_REUTILISEE_AUTRES_DONNEES (rien n'est créé, la commande existante n'est pas touchée) ;
--        - du même client, même contenu             → renvoie la commande existante (r_deja = true), sans rien créer ;
--   2. sinon délègue à order_create_checked — INCHANGÉE : même contrôle de compte actif, mêmes verrous sur les produits, même calcul du disponible, mêmes conflits —,
--      puis pose la clé et l'empreinte du contenu sur la commande créée, dans la MÊME transaction.
-- Le contenu est comparé par une empreinte (md5) des lignes « produit : quantité cumulée » : ni le prix ni les notes n'entrent dans la comparaison.
-- Deux envois simultanés avec la même clé : le second attend le premier, puis trouve la commande déjà créée. Un refus pour stock ne consomme pas la clé.
-- Un client identifié (user_id) est exigé : la clé ne peut jamais servir à retrouver une commande sans propriétaire.
-- Aucune donnée existante n'est modifiée (les colonnes restent NULL pour les commandes existantes). Aucune fonction existante n'est modifiée.
-- La fonction est réservée au serveur du site (service_role), comme order_create_checked.

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS cle_commande uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cle_empreinte text;
CREATE UNIQUE INDEX IF NOT EXISTS orders_cle_commande_idx ON orders (cle_commande) WHERE cle_commande IS NOT NULL;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_cle_coherente;
ALTER TABLE orders ADD CONSTRAINT orders_cle_coherente CHECK ((cle_commande IS NULL) = (cle_empreinte IS NULL));
COMMENT ON COLUMN orders.cle_commande IS 'Clé d''envoi (idempotence) : la même clé ne crée jamais deux commandes. NULL pour les commandes sans clé (existantes, saisie administrateur).';
COMMENT ON COLUMN orders.cle_empreinte IS 'Empreinte (md5) du contenu du panier envoyé avec la clé : une clé réutilisée avec un autre contenu est refusée.';

CREATE OR REPLACE FUNCTION order_create_idempotent(p_cle uuid, p_order jsonb, p_items jsonb)
RETURNS TABLE(r_order_id uuid, r_conflicts jsonb, r_deja boolean)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid;
  v_emp  text;
  o record;
  v record;
BEGIN
  -- Sans clé : arrêt immédiat, AVANT toute lecture ou écriture (c'est aussi la sonde d'existence utilisée par le site, sans effet).
  IF p_cle IS NULL THEN RAISE EXCEPTION 'CLE_REQUISE'; END IF;
  v_user := NULLIF(p_order->>'user_id', '')::uuid;
  IF v_user IS NULL THEN RAISE EXCEPTION 'CLIENT_REQUIS'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'order_create_idempotent: aucune ligne'; END IF;

  SELECT md5(string_agg(s.pid || ':' || s.q::text, ',' ORDER BY s.pid)) INTO v_emp
    FROM (SELECT it->>'product_id' AS pid, sum((it->>'quantity')::int) AS q FROM jsonb_array_elements(p_items) it GROUP BY 1) s;

  PERFORM pg_advisory_xact_lock(hashtextextended('order_idem:' || p_cle::text, 0));

  SELECT id, user_id, cle_empreinte INTO o FROM orders WHERE cle_commande = p_cle;
  IF FOUND THEN
    IF o.user_id IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'CLE_DEJA_UTILISEE'; END IF;
    IF o.cle_empreinte IS DISTINCT FROM v_emp THEN RAISE EXCEPTION 'CLE_REUTILISEE_AUTRES_DONNEES'; END IF;
    r_order_id := o.id; r_conflicts := '[]'::jsonb; r_deja := true;
    RETURN NEXT; RETURN;
  END IF;

  SELECT * INTO v FROM order_create_checked(p_order, p_items);
  IF v.r_order_id IS NOT NULL THEN
    UPDATE orders SET cle_commande = p_cle, cle_empreinte = v_emp WHERE id = v.r_order_id;
  END IF;
  r_order_id := v.r_order_id; r_conflicts := v.r_conflicts; r_deja := false;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION order_create_idempotent(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION order_create_idempotent(uuid, jsonb, jsonb) TO service_role;

COMMIT;

-- Retour arrière (sans perte de commande : seules la clé et l'empreinte disparaissent) :
--   DROP FUNCTION order_create_idempotent(uuid, jsonb, jsonb);
--   ALTER TABLE orders DROP CONSTRAINT orders_cle_coherente;
--   DROP INDEX orders_cle_commande_idx;
--   ALTER TABLE orders DROP COLUMN cle_commande, DROP COLUMN cle_empreinte;
-- Sans la fonction, le site refuse l'envoi d'une commande (message « momentanément indisponible », panier conservé) : ne retirer la fonction que si le site est revenu à l'ancien code.
