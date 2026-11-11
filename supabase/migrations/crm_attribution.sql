-- CRM — ÉTAPE 1 (M1) : rattachement fiable commande ↔ compte client et attribution commerciale.
-- NON APPLIQUÉE en production : à exécuter seulement sur accord explicite, après sauvegarde.
-- STRUCTURE UNIQUEMENT : colonnes, contraintes, déclencheurs, fonctions. Aucune donnée existante n'est modifiée ici
-- (les commandes existantes reçoivent « historique » par la valeur par défaut de la colonne ; le rattachement des 78
-- correspondances exactes est un fichier SÉPARÉ : crm_attribution_remplissage.sql, à lancer APRÈS vérification du rapport).
-- Rejouable sans erreur. Indépendante de la TVA.
--
-- Modèle :
--   client_accounts.responsable_*        commercial responsable du client (id + e-mail + depuis quand). Modifiable SEULEMENT par les
--                                        fonctions client_attribuer / clients_attribuer_lot, qui journalisent dans admin_audit_logs.
--   client_accounts.rattachement_groupe  'interne' (Groupe Incana) | 'externe' | NULL = « à classer ». Classé À LA MAIN par un
--                                        administrateur (client_classer_groupe) : aucune déduction automatique.
--   client_accounts.parent_id            RÉSERVÉ à l'avenir (entreprise → points de vente) : non utilisé aujourd'hui.
--                                        Convention future : client_id d'une commande = le point de vente livré (son propre compte, ses
--                                        propres clés de BL) ; le client facturé = COALESCE(parent_id, id) ; le responsable reste celui du compte.
--   orders.client_id                     compte client de la commande (posé par order_create_checked ; par e-mail exact et unique sinon).
--   orders.responsable_id / _email       commercial responsable du client AU MOMENT de la création de la commande. FIGÉ ensuite.
--   orders.attribution                   'historique' (commandes d'avant M1 : aucune preuve fiable, JAMAIS attribuées automatiquement →
--                                        « Historique non attribué » dans les statistiques) | 'portefeuille' | 'sans_responsable'
--                                        (client sans responsable à la création) | 'manuelle' (réservé : attribution explicite future).

BEGIN;

-- ── 1. client_accounts ───────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE client_accounts
  ADD COLUMN IF NOT EXISTS responsable_id           uuid,
  ADD COLUMN IF NOT EXISTS responsable_email        text,
  ADD COLUMN IF NOT EXISTS responsable_depuis       timestamptz,
  ADD COLUMN IF NOT EXISTS rattachement_groupe      text,
  ADD COLUMN IF NOT EXISTS rattachement_valide_par  text,
  ADD COLUMN IF NOT EXISTS rattachement_valide_le   timestamptz,
  ADD COLUMN IF NOT EXISTS parent_id                uuid;

ALTER TABLE client_accounts DROP CONSTRAINT IF EXISTS client_accounts_responsable_coherent;
ALTER TABLE client_accounts ADD CONSTRAINT client_accounts_responsable_coherent
  CHECK ((responsable_id IS NULL) = (responsable_email IS NULL) AND (responsable_id IS NULL) = (responsable_depuis IS NULL));
ALTER TABLE client_accounts DROP CONSTRAINT IF EXISTS client_accounts_rattachement_check;
ALTER TABLE client_accounts ADD CONSTRAINT client_accounts_rattachement_check
  CHECK (rattachement_groupe IS NULL OR rattachement_groupe IN ('interne', 'externe'));
ALTER TABLE client_accounts DROP CONSTRAINT IF EXISTS client_accounts_rattachement_coherent;
ALTER TABLE client_accounts ADD CONSTRAINT client_accounts_rattachement_coherent
  CHECK ((rattachement_groupe IS NULL) = (rattachement_valide_par IS NULL) AND (rattachement_groupe IS NULL) = (rattachement_valide_le IS NULL));
ALTER TABLE client_accounts DROP CONSTRAINT IF EXISTS client_accounts_parent_fkey;
ALTER TABLE client_accounts ADD CONSTRAINT client_accounts_parent_fkey FOREIGN KEY (parent_id) REFERENCES client_accounts(id) ON DELETE SET NULL;
ALTER TABLE client_accounts DROP CONSTRAINT IF EXISTS client_accounts_parent_distinct;
ALTER TABLE client_accounts ADD CONSTRAINT client_accounts_parent_distinct CHECK (parent_id IS NULL OR parent_id <> id);

CREATE INDEX IF NOT EXISTS client_accounts_responsable_idx ON client_accounts (responsable_id);
CREATE INDEX IF NOT EXISTS client_accounts_parent_idx      ON client_accounts (parent_id);

-- ── 2. orders ────────────────────────────────────────────────────────────────────────────────────────────────────
-- attribution : NOT NULL avec défaut 'historique' le temps d'ajouter la colonne (les lignes existantes prennent cette valeur),
-- puis le défaut est retiré : une commande insérée sans passer par le déclencheur échouerait bruyamment au lieu d'être étiquetée à tort.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS client_id          uuid,
  ADD COLUMN IF NOT EXISTS responsable_id     uuid,
  ADD COLUMN IF NOT EXISTS responsable_email  text,
  ADD COLUMN IF NOT EXISTS attribution       text NOT NULL DEFAULT 'historique';
ALTER TABLE orders ALTER COLUMN attribution DROP DEFAULT;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_client_id_fkey;
ALTER TABLE orders ADD CONSTRAINT orders_client_id_fkey FOREIGN KEY (client_id) REFERENCES client_accounts(id) ON DELETE SET NULL;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_attribution_check;
ALTER TABLE orders ADD CONSTRAINT orders_attribution_check CHECK (attribution IN ('historique', 'portefeuille', 'sans_responsable', 'manuelle'));
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_attribution_coherente;
ALTER TABLE orders ADD CONSTRAINT orders_attribution_coherente
  CHECK ((attribution IN ('portefeuille', 'manuelle')) = (responsable_id IS NOT NULL) AND (responsable_id IS NULL) = (responsable_email IS NULL));

CREATE INDEX IF NOT EXISTS orders_client_id_idx      ON orders (client_id);
CREATE INDEX IF NOT EXISTS orders_responsable_id_idx ON orders (responsable_id);

-- ── 3. Déclencheurs de protection et d'attribution ───────────────────────────────────────────────────────────────

-- Nouvelle commande : rattache au compte client et FIGE le responsable du moment. Ni le responsable ni l'attribution ne viennent
-- jamais de l'appelant. Le compte est lu FOR SHARE : un transfert de portefeuille simultané (FOR UPDATE) est sérialisé avec la commande.
CREATE OR REPLACE FUNCTION orders_attribuer() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_n        int;
  v_resp_id  uuid;
  v_resp_mel text;
BEGIN
  NEW.responsable_id    := NULL;
  NEW.responsable_email := NULL;

  -- Rattachement par e-mail UNIQUEMENT s'il désigne un seul compte (insensible à la casse et aux espaces) ; sinon la commande reste sans client.
  IF NEW.client_id IS NULL AND nullif(trim(NEW.email), '') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM client_accounts WHERE lower(trim(email)) = lower(trim(NEW.email));
    IF v_n = 1 THEN
      SELECT id INTO NEW.client_id FROM client_accounts WHERE lower(trim(email)) = lower(trim(NEW.email));
    END IF;
  END IF;

  IF NEW.client_id IS NOT NULL THEN
    SELECT responsable_id, responsable_email INTO v_resp_id, v_resp_mel
    FROM client_accounts WHERE id = NEW.client_id FOR SHARE;
    NEW.responsable_id    := v_resp_id;
    NEW.responsable_email := v_resp_mel;
  END IF;

  NEW.attribution := CASE WHEN NEW.responsable_id IS NULL THEN 'sans_responsable' ELSE 'portefeuille' END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_orders_attribuer ON orders;
CREATE TRIGGER trg_orders_attribuer BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION orders_attribuer();

-- Commande existante : le responsable et l'attribution sont figés (même pour un administrateur). Le compte client ne peut pas être
-- changé non plus ; deux exceptions seulement : (a) le compte est supprimé (ON DELETE SET NULL : le lien disparaît, l'attribution reste) ;
-- (b) rattachement d'une commande HISTORIQUE encore sans client, par la procédure de remplissage (réglage de transaction explicite).
CREATE OR REPLACE FUNCTION orders_attribution_proteger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.responsable_id    IS DISTINCT FROM OLD.responsable_id
  OR NEW.responsable_email IS DISTINCT FROM OLD.responsable_email
  OR NEW.attribution       IS DISTINCT FROM OLD.attribution THEN
    RAISE EXCEPTION 'ATTRIBUTION_FIGEE : le responsable d''une commande est figé à sa création';
  END IF;

  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    IF OLD.client_id IS NOT NULL AND NEW.client_id IS NULL AND NOT EXISTS (SELECT 1 FROM client_accounts WHERE id = OLD.client_id) THEN
      RETURN NEW;
    END IF;
    IF OLD.client_id IS NULL AND NEW.client_id IS NOT NULL AND OLD.attribution = 'historique'
       AND coalesce(current_setting('inca.rattachement_historique', true), '') = '1' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'CLIENT_FIGE : le compte client d''une commande ne peut pas être modifié';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_orders_attribution_proteger ON orders;
CREATE TRIGGER trg_orders_attribution_proteger BEFORE UPDATE OF client_id, responsable_id, responsable_email, attribution ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_attribution_proteger();

-- Compte client : le responsable et le rattachement au Groupe ne changent QUE par les fonctions ci-dessous (qui journalisent).
CREATE OR REPLACE FUNCTION client_accounts_attribution_proteger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.responsable_id, NEW.responsable_email, NEW.responsable_depuis)
       IS DISTINCT FROM (OLD.responsable_id, OLD.responsable_email, OLD.responsable_depuis)
  OR (NEW.rattachement_groupe, NEW.rattachement_valide_par, NEW.rattachement_valide_le)
       IS DISTINCT FROM (OLD.rattachement_groupe, OLD.rattachement_valide_par, OLD.rattachement_valide_le) THEN
    IF coalesce(current_setting('inca.attribution_client', true), '') <> '1' THEN
      RAISE EXCEPTION 'ATTRIBUTION_PROTEGEE : passer par client_attribuer / client_classer_groupe (journalisés)';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_client_accounts_attribution_proteger ON client_accounts;
CREATE TRIGGER trg_client_accounts_attribution_proteger
  BEFORE UPDATE OF responsable_id, responsable_email, responsable_depuis, rattachement_groupe, rattachement_valide_par, rattachement_valide_le ON client_accounts
  FOR EACH ROW EXECUTE FUNCTION client_accounts_attribution_proteger();

-- ── 4. Attribution et transfert de portefeuille (journalisés dans admin_audit_logs, même transaction) ─────────────
-- Le rôle de l'acteur est vérifié par le serveur (session) et transmis ici ; la base applique les RÈGLES :
--   admin       : attribution (client sans responsable), transfert (motif obligatoire), retrait (motif obligatoire), prise en charge pour soi ;
--   commercial  : UNIQUEMENT la prise en charge, pour lui-même, d'un client SANS responsable (deux prises simultanées : une seule réussit).
CREATE OR REPLACE FUNCTION client_attribuer(
  p_client_id uuid, p_nouveau_id uuid, p_nouveau_email text, p_action text,
  p_acteur_id uuid, p_acteur_email text, p_acteur_role text, p_motif text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  c        client_accounts%ROWTYPE;
  v_motif  text := nullif(trim(coalesce(p_motif, '')), '');
  v_mel    text := nullif(trim(coalesce(p_nouveau_email, '')), '');
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('attribution', 'transfert', 'retrait', 'prise_en_charge') THEN RAISE EXCEPTION 'ACTION_INCONNUE'; END IF;
  IF p_acteur_role IS NULL OR p_acteur_role NOT IN ('admin', 'commercial') OR p_acteur_id IS NULL
     OR nullif(trim(coalesce(p_acteur_email, '')), '') IS NULL THEN RAISE EXCEPTION 'ACTEUR_INVALIDE'; END IF;
  IF p_nouveau_id IS NOT NULL AND v_mel IS NULL THEN RAISE EXCEPTION 'RESPONSABLE_INVALIDE'; END IF;
  IF p_nouveau_id IS NULL AND v_mel IS NOT NULL THEN RAISE EXCEPTION 'RESPONSABLE_INVALIDE'; END IF;

  SELECT * INTO c FROM client_accounts WHERE id = p_client_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLIENT_INTROUVABLE'; END IF;

  IF p_action = 'prise_en_charge' THEN
    IF p_nouveau_id IS DISTINCT FROM p_acteur_id THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
    IF c.responsable_id IS NOT NULL THEN RAISE EXCEPTION 'DEJA_ATTRIBUE'; END IF;
  ELSE
    IF p_acteur_role <> 'admin' THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
    IF p_action = 'attribution' THEN
      IF c.responsable_id IS NOT NULL OR p_nouveau_id IS NULL THEN RAISE EXCEPTION 'ACTION_INCOHERENTE'; END IF;
    ELSIF p_action = 'transfert' THEN
      IF c.responsable_id IS NULL OR p_nouveau_id IS NULL THEN RAISE EXCEPTION 'ACTION_INCOHERENTE'; END IF;
      IF c.responsable_id = p_nouveau_id THEN RAISE EXCEPTION 'AUCUN_CHANGEMENT'; END IF;
      IF v_motif IS NULL OR length(v_motif) < 3 THEN RAISE EXCEPTION 'MOTIF_REQUIS'; END IF;
    ELSE  -- retrait
      IF c.responsable_id IS NULL OR p_nouveau_id IS NOT NULL THEN RAISE EXCEPTION 'ACTION_INCOHERENTE'; END IF;
      IF v_motif IS NULL OR length(v_motif) < 3 THEN RAISE EXCEPTION 'MOTIF_REQUIS'; END IF;
    END IF;
  END IF;

  PERFORM set_config('inca.attribution_client', '1', true);
  UPDATE client_accounts
     SET responsable_id = p_nouveau_id, responsable_email = v_mel,
         responsable_depuis = CASE WHEN p_nouveau_id IS NULL THEN NULL ELSE now() END
   WHERE id = p_client_id;
  PERFORM set_config('inca.attribution_client', '', true);

  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'client.responsable', 'client', p_client_id::text, coalesce(nullif(c.societe, ''), c.nom),
          jsonb_build_object('action', p_action, 'role_acteur', p_acteur_role,
                             'ancien', jsonb_build_object('id', c.responsable_id, 'email', c.responsable_email),
                             'nouveau', jsonb_build_object('id', p_nouveau_id, 'email', v_mel),
                             'motif', v_motif));

  RETURN jsonb_build_object('client_id', p_client_id, 'action', p_action, 'ancien_id', c.responsable_id, 'nouveau_id', p_nouveau_id);
END $$;

-- Lot (administrateur) : tout ou rien, dans une seule transaction. Les clients déjà confiés au même responsable sont ignorés.
CREATE OR REPLACE FUNCTION clients_attribuer_lot(
  p_client_ids uuid[], p_nouveau_id uuid, p_nouveau_email text,
  p_acteur_id uuid, p_acteur_email text, p_acteur_role text, p_motif text
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid; v_courant uuid; v_attribues int := 0; v_transferes int := 0; v_ignores int := 0;
BEGIN
  IF p_acteur_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF p_nouveau_id IS NULL THEN RAISE EXCEPTION 'RESPONSABLE_INVALIDE'; END IF;
  IF p_client_ids IS NULL OR cardinality(p_client_ids) = 0 OR cardinality(p_client_ids) > 200 THEN RAISE EXCEPTION 'LOT_INVALIDE'; END IF;
  IF nullif(trim(coalesce(p_motif, '')), '') IS NULL OR length(trim(p_motif)) < 3 THEN RAISE EXCEPTION 'MOTIF_REQUIS'; END IF;

  FOR v_id IN SELECT DISTINCT x FROM unnest(p_client_ids) x ORDER BY x LOOP       -- ordre stable : pas d'interblocage entre deux lots
    SELECT responsable_id INTO v_courant FROM client_accounts WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CLIENT_INTROUVABLE'; END IF;
    IF v_courant IS NOT DISTINCT FROM p_nouveau_id THEN
      v_ignores := v_ignores + 1;
    ELSIF v_courant IS NULL THEN
      PERFORM client_attribuer(v_id, p_nouveau_id, p_nouveau_email, 'attribution', p_acteur_id, p_acteur_email, p_acteur_role, p_motif);
      v_attribues := v_attribues + 1;
    ELSE
      PERFORM client_attribuer(v_id, p_nouveau_id, p_nouveau_email, 'transfert', p_acteur_id, p_acteur_email, p_acteur_role, p_motif);
      v_transferes := v_transferes + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('attribues', v_attribues, 'transferes', v_transferes, 'ignores', v_ignores);
END $$;

-- ── 5. Classement Groupe Incana (interne) / externe : manuel, administrateur seulement, journalisé ───────────────
CREATE OR REPLACE FUNCTION client_classer_groupe(
  p_client_id uuid, p_valeur text, p_acteur_email text, p_acteur_role text, p_motif text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  c client_accounts%ROWTYPE;
  v_motif text := nullif(trim(coalesce(p_motif, '')), '');
BEGIN
  IF p_acteur_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF nullif(trim(coalesce(p_acteur_email, '')), '') IS NULL THEN RAISE EXCEPTION 'ACTEUR_INVALIDE'; END IF;
  IF p_valeur IS NOT NULL AND p_valeur NOT IN ('interne', 'externe') THEN RAISE EXCEPTION 'VALEUR_INVALIDE'; END IF;

  SELECT * INTO c FROM client_accounts WHERE id = p_client_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLIENT_INTROUVABLE'; END IF;
  IF c.rattachement_groupe IS NOT DISTINCT FROM p_valeur THEN
    RETURN jsonb_build_object('client_id', p_client_id, 'inchange', true);
  END IF;

  PERFORM set_config('inca.attribution_client', '1', true);
  UPDATE client_accounts
     SET rattachement_groupe = p_valeur,
         rattachement_valide_par = CASE WHEN p_valeur IS NULL THEN NULL ELSE p_acteur_email END,
         rattachement_valide_le  = CASE WHEN p_valeur IS NULL THEN NULL ELSE now() END
   WHERE id = p_client_id;
  PERFORM set_config('inca.attribution_client', '', true);

  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'client.rattachement_groupe', 'client', p_client_id::text, coalesce(nullif(c.societe, ''), c.nom),
          jsonb_build_object('ancien', c.rattachement_groupe, 'nouveau', p_valeur, 'motif', v_motif));
  RETURN jsonb_build_object('client_id', p_client_id, 'ancien', c.rattachement_groupe, 'nouveau', p_valeur, 'inchange', false);
END $$;

CREATE OR REPLACE FUNCTION clients_classer_groupe_lot(
  p_client_ids uuid[], p_valeur text, p_acteur_email text, p_acteur_role text, p_motif text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_r jsonb; v_changes int := 0; v_inchanges int := 0;
BEGIN
  IF p_acteur_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF p_client_ids IS NULL OR cardinality(p_client_ids) = 0 OR cardinality(p_client_ids) > 200 THEN RAISE EXCEPTION 'LOT_INVALIDE'; END IF;
  FOR v_id IN SELECT DISTINCT x FROM unnest(p_client_ids) x ORDER BY x LOOP
    v_r := client_classer_groupe(v_id, p_valeur, p_acteur_email, p_acteur_role, p_motif);
    IF (v_r->>'inchange')::boolean THEN v_inchanges := v_inchanges + 1; ELSE v_changes := v_changes + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('classes', v_changes, 'inchanges', v_inchanges);
END $$;

-- ── 6. order_create_checked : SEUL CHANGEMENT = l'insertion enregistre client_id (déjà trouvé par e-mail, compte actif exigé). ──
-- Corps repris à l'identique de la définition de production (relevée le 2026-11-12). search_path conservé (CREATE OR REPLACE le réinitialise).
CREATE OR REPLACE FUNCTION public.order_create_checked(p_order jsonb, p_items jsonb)
 RETURNS TABLE(r_order_id uuid, r_conflicts jsonb)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
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

  -- M1 : client_id enregistré (le responsable et l'attribution sont posés par le déclencheur trg_orders_attribuer).
  INSERT INTO orders (user_id, nom, societe, telephone, email, notes, status, client_id)
  VALUES (
    NULLIF(p_order->>'user_id', '')::uuid,
    COALESCE(p_order->>'nom', ''),
    COALESCE(p_order->>'societe', ''),
    COALESCE(p_order->>'telephone', ''),
    NULLIF(p_order->>'email', ''),
    NULLIF(p_order->>'notes', ''),
    'en_attente',
    v_client_id
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

-- ── 7. Droits : exécution réservée au serveur (comme toutes les fonctions du schéma depuis la phase 0) ───────────
REVOKE EXECUTE ON FUNCTION orders_attribuer(), orders_attribution_proteger(), client_accounts_attribution_proteger(),
  client_attribuer(uuid, uuid, text, text, uuid, text, text, text),
  clients_attribuer_lot(uuid[], uuid, text, uuid, text, text, text),
  client_classer_groupe(uuid, text, text, text, text),
  clients_classer_groupe_lot(uuid[], text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION client_attribuer(uuid, uuid, text, text, uuid, text, text, text),
  clients_attribuer_lot(uuid[], uuid, text, uuid, text, text, text),
  client_classer_groupe(uuid, text, text, text, text),
  clients_classer_groupe_lot(uuid[], text, text, text, text) TO service_role;

COMMENT ON COLUMN orders.attribution IS 'historique = commande antérieure à M1, jamais attribuée automatiquement ; portefeuille = responsable figé à la création ; sans_responsable = client non attribué à la création ; manuelle = attribution explicite (réservé)';
COMMENT ON COLUMN client_accounts.rattachement_groupe IS 'interne = client du Groupe Incana, externe = portefeuille indépendant, NULL = à classer (jamais déduit automatiquement)';
COMMENT ON COLUMN client_accounts.parent_id IS 'RÉSERVÉ : entreprise (facturée) → point de vente (livré). Non utilisé en phase CRM 2 ; chaque point de vente garde son propre compte et ses clés de BL.';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Retour arrière (seulement tant qu'aucun responsable n'a été attribué et aucune commande créée depuis M1 ; sinon des données seraient perdues) :
--   1. Remettre order_create_checked à sa version d'avant : rejouer la définition de supabase/migrations/products_visible_catalogue.sql
--      puis ALTER FUNCTION public.order_create_checked(jsonb, jsonb) SET search_path = public, pg_temp;
--   2. DROP TRIGGER trg_orders_attribuer ON orders;  DROP TRIGGER trg_orders_attribution_proteger ON orders;
--      DROP TRIGGER trg_client_accounts_attribution_proteger ON client_accounts;
--   3. DROP FUNCTION orders_attribuer(), orders_attribution_proteger(), client_accounts_attribution_proteger(), client_attribuer(uuid, uuid, text, text, uuid, text, text, text),
--        clients_attribuer_lot(uuid[], uuid, text, uuid, text, text, text), client_classer_groupe(uuid, text, text, text, text), clients_classer_groupe_lot(uuid[], text, text, text, text);
--   4. ALTER TABLE orders DROP COLUMN client_id, DROP COLUMN responsable_id, DROP COLUMN responsable_email, DROP COLUMN attribution;
--   5. ALTER TABLE client_accounts DROP COLUMN responsable_id, DROP COLUMN responsable_email, DROP COLUMN responsable_depuis,
--        DROP COLUMN rattachement_groupe, DROP COLUMN rattachement_valide_par, DROP COLUMN rattachement_valide_le, DROP COLUMN parent_id;
