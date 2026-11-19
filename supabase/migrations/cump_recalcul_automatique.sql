-- CUMP glissant — RECALCUL AUTOMATIQUE (étape 4 du déploiement : à n'appliquer qu'APRÈS cump_glissant.sql, son remplissage initial et la validation de la comparaison).
--
-- PRINCIPE (« boîte d'envoi » transactionnelle) : un événement (réception créée / modifiée / supprimée / annulée, livraison effective, retour ou correction de livraison) DÉPOSE une demande
-- dans cump_file, dans la MÊME transaction que l'événement ; le calcul lui-même est fait ENSUITE, dans une transaction séparée, par cump_traiter_file. Conséquences :
--   • un problème de calcul ne peut JAMAIS annuler une réception ni une livraison : le calcul n'est pas dans leur transaction ;
--   • un événement annulé (refus de stock, erreur) ne laisse aucune demande (même transaction) ;
--   • une demande n'est jamais perdue : elle reste « en_attente » (avec reprises à délai croissant) puis « echoue » (visible, reprise manuelle) — jamais supprimée silencieusement ;
--   • une coupure pendant le calcul annule le calcul ET sa prise en charge : la demande redevient disponible, sans résultat partiel ;
--   • plusieurs demandes pour un même produit se fusionnent (une seule « en_attente » par produit) ; deux traitements simultanés ne prennent jamais la même demande (SKIP LOCKED)
--     et ne calculent jamais le même produit en même temps (verrou par produit dans le moteur) ; le calcul est idempotent : le rejouer ne crée ni doublon ni écart.
--   • filet de sécurité : cump_detecter_obsoletes compare l'empreinte des données de chaque produit à celle de son dernier calcul et redépose toute demande manquante (déclencheur en échec,
--     modification faite hors application, stock corrigé à la main…).
--
-- INTERRUPTEUR : cump_config « recalcul_automatique » vaut 'off' à l'installation. Tant qu'il vaut 'off', aucun déclencheur ne dépose rien : la migration ne change AUCUN comportement.
-- L'activation (cump_activer_recalcul_automatique(true)) est un acte séparé, avec accord explicite.
--
-- SÉCURITÉ DES DÉCLENCHEURS : AFTER (jamais avant l'événement), toute erreur est avalée et signalée (RAISE WARNING) : un déclencheur ne bloque jamais une réception, une livraison ni une commande.
-- Ils s'exécutent en SECURITY DEFINER (droits du propriétaire) avec search_path figé, pour ne dépendre d'aucun droit de l'appelant. Ils n'écrivent QUE dans cump_file.
-- Ils sont posés sur : stock_reception_items, stock_receptions, order_items, admin_audit_logs (la date de livraison vient de la trace « commande.statut → livree »).
--
-- RETOUR ARRIÈRE : supabase/retour/cump_recalcul_automatique_retour.sql (désactivation immédiate par l'interrupteur, puis suppression des déclencheurs si besoin).

-- ── Interrupteur ───────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cump_config (
  cle        text PRIMARY KEY,
  valeur     text NOT NULL,
  modifie_le timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.cump_config (cle, valeur) VALUES ('recalcul_automatique', 'off') ON CONFLICT (cle) DO NOTHING;

-- ── Suivi des recalculs ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cump_file (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        uuid NOT NULL,
  origine           text NOT NULL CHECK (origine IN ('reception', 'livraison', 'balayage', 'reprise')),
  reception_id      uuid,
  statut            text NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'reussi', 'echoue', 'fusionne')),
  evenements        integer NOT NULL DEFAULT 1,                    -- nombre d'événements regroupés dans cette demande
  tentatives        integer NOT NULL DEFAULT 0,
  derniere_erreur   text,
  derniere_erreur_le timestamptz,
  disponible_apres  timestamptz NOT NULL DEFAULT now(),            -- reprise à délai croissant après un échec
  cree_le           timestamptz NOT NULL DEFAULT now(),
  termine_le        timestamptz
);
-- Une seule demande « en_attente » par produit : les événements rapprochés se fusionnent, aucun doublon.
CREATE UNIQUE INDEX IF NOT EXISTS cump_file_une_attente_par_produit ON public.cump_file (product_id) WHERE statut = 'en_attente';
CREATE INDEX IF NOT EXISTS cump_file_statut_idx ON public.cump_file (statut, disponible_apres);

ALTER TABLE public.cump_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cump_file   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cump_config, public.cump_file FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.cump_config TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.cump_file TO service_role;

CREATE OR REPLACE FUNCTION public.cump_auto_actif() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT valeur = 'on' FROM cump_config WHERE cle = 'recalcul_automatique'), false);
$$;

CREATE OR REPLACE FUNCTION public.cump_activer_recalcul_automatique(p_actif boolean) RETURNS boolean
LANGUAGE sql SET search_path = public, pg_temp AS $$
  UPDATE cump_config SET valeur = CASE WHEN p_actif THEN 'on' ELSE 'off' END, modifie_le = now() WHERE cle = 'recalcul_automatique' RETURNING valeur = 'on';
$$;

-- ── Dépôt d'une demande (interne ; ne fait rien si l'interrupteur est sur 'off') ────────────────────────
-- lock_timeout : si une demande du même produit est verrouillée par un calcul en cours, l'événement attend au plus 1,5 s ; au-delà, le dépôt est abandonné (avertissement) et le filet de sécurité
-- (cump_detecter_obsoletes) le retrouvera : un calcul lent ne bloque jamais une réception ni une livraison.
CREATE OR REPLACE FUNCTION public.cump_enfiler(p_product_ids uuid[], p_origine text, p_reception_id uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '1500ms' AS $$
DECLARE v_n integer;
BEGIN
  IF NOT cump_auto_actif() THEN RETURN 0; END IF;
  IF coalesce(current_setting('inca.cump_abandon', true), '') = '1' THEN RETURN 0; END IF;     -- un dépôt a déjà dû être abandonné dans cette transaction : on n'attend pas une seconde fois
  INSERT INTO cump_file (product_id, origine, reception_id)
  SELECT DISTINCT x, p_origine, p_reception_id FROM unnest(p_product_ids) x WHERE x IS NOT NULL
  ON CONFLICT (product_id) WHERE statut = 'en_attente' DO UPDATE SET evenements = cump_file.evenements + 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
EXCEPTION WHEN lock_not_available THEN
  PERFORM set_config('inca.cump_abandon', '1', true);
  RAISE WARNING 'cump : dépôt abandonné (demande verrouillée par un calcul en cours) ; le balayage de sécurité le retrouvera';
  RETURN 0;
END $$;

-- ── Déclencheurs : déposent une demande, ne calculent rien, ne bloquent jamais ─────────────────────────
CREATE OR REPLACE FUNCTION public.cump_trg_lignes_reception() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN PERFORM cump_enfiler(ARRAY[OLD.product_id], 'reception', OLD.reception_id);
    ELSE PERFORM cump_enfiler(ARRAY[NEW.product_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.product_id END], 'reception', NEW.reception_id); END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cump : dépôt de demande impossible (lignes de réception) : %', SQLERRM;
  END;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.cump_trg_receptions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  BEGIN
    IF (OLD.stock_applied, OLD.received_at, to_jsonb(OLD) ->> 'annulee_le') IS DISTINCT FROM (NEW.stock_applied, NEW.received_at, to_jsonb(NEW) ->> 'annulee_le') THEN
      PERFORM cump_enfiler(ARRAY(SELECT DISTINCT i.product_id FROM stock_reception_items i WHERE i.reception_id = NEW.id), 'reception', NEW.id);
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cump : dépôt de demande impossible (réception) : %', SQLERRM;
  END;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.cump_trg_lignes_commande() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF coalesce(OLD.stock_decremented, 0) > 0 THEN PERFORM cump_enfiler(ARRAY[OLD.product_id], 'livraison'); END IF;
    ELSIF TG_OP = 'INSERT' THEN
      IF coalesce(NEW.stock_decremented, 0) > 0 THEN PERFORM cump_enfiler(ARRAY[NEW.product_id], 'livraison'); END IF;
    ELSIF OLD.stock_decremented IS DISTINCT FROM NEW.stock_decremented
       OR (coalesce(NEW.stock_decremented, 0) > 0 AND (OLD.quantity IS DISTINCT FROM NEW.quantity OR OLD.product_id IS DISTINCT FROM NEW.product_id)) THEN
      PERFORM cump_enfiler(ARRAY[NEW.product_id, OLD.product_id], 'livraison');                  -- livraison, retour arrière de livraison, correction
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cump : dépôt de demande impossible (ligne de commande) : %', SQLERRM;
  END;
  RETURN NULL;
END $$;

-- La date de livraison vient du journal d'audit, écrit juste APRÈS la déduction du stock : ce déclencheur redépose la demande une fois la trace écrite.
CREATE OR REPLACE FUNCTION public.cump_trg_journal_livraison() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  BEGIN
    IF NEW.action = 'commande.statut' AND (NEW.details ->> 'nouveau' = 'livree' OR NEW.details ->> 'ancien' = 'livree') AND NEW.target_id ~ '^[0-9a-f-]{36}$' THEN
      PERFORM cump_enfiler(ARRAY(SELECT DISTINCT oi.product_id FROM order_items oi WHERE oi.order_id = NEW.target_id::uuid AND oi.product_id IS NOT NULL), 'livraison');
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cump : dépôt de demande impossible (journal de livraison) : %', SQLERRM;
  END;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_cump_lignes_reception ON public.stock_reception_items;
CREATE TRIGGER trg_cump_lignes_reception AFTER INSERT OR UPDATE OR DELETE ON public.stock_reception_items FOR EACH ROW EXECUTE FUNCTION public.cump_trg_lignes_reception();
DROP TRIGGER IF EXISTS trg_cump_receptions ON public.stock_receptions;
CREATE TRIGGER trg_cump_receptions AFTER UPDATE ON public.stock_receptions FOR EACH ROW EXECUTE FUNCTION public.cump_trg_receptions();
-- Lignes de commande : seuls les changements qui touchent une SORTIE de stock déclenchent la fonction (la création d'une commande, les cases cochées en préparation, etc. ne la déclenchent pas).
DROP TRIGGER IF EXISTS trg_cump_lignes_commande ON public.order_items;
DROP TRIGGER IF EXISTS trg_cump_lignes_commande_ins ON public.order_items;
CREATE TRIGGER trg_cump_lignes_commande_ins AFTER INSERT ON public.order_items FOR EACH ROW WHEN (NEW.stock_decremented > 0) EXECUTE FUNCTION public.cump_trg_lignes_commande();
DROP TRIGGER IF EXISTS trg_cump_lignes_commande_maj ON public.order_items;
CREATE TRIGGER trg_cump_lignes_commande_maj AFTER UPDATE OF stock_decremented, quantity, product_id ON public.order_items FOR EACH ROW
  WHEN (OLD.stock_decremented IS DISTINCT FROM NEW.stock_decremented OR NEW.stock_decremented > 0) EXECUTE FUNCTION public.cump_trg_lignes_commande();
DROP TRIGGER IF EXISTS trg_cump_lignes_commande_sup ON public.order_items;
CREATE TRIGGER trg_cump_lignes_commande_sup AFTER DELETE ON public.order_items FOR EACH ROW WHEN (OLD.stock_decremented > 0) EXECUTE FUNCTION public.cump_trg_lignes_commande();
DROP TRIGGER IF EXISTS trg_cump_journal_livraison ON public.admin_audit_logs;
CREATE TRIGGER trg_cump_journal_livraison AFTER INSERT ON public.admin_audit_logs FOR EACH ROW WHEN (NEW.action = 'commande.statut') EXECUTE FUNCTION public.cump_trg_journal_livraison();

-- ── Traitement des demandes (appelé par le serveur ; sans effet sur l'événement d'origine) ──────────────
-- Prend les demandes disponibles une à une (SKIP LOCKED : deux traitements simultanés ne prennent jamais la même). Le calcul et la prise en charge sont dans la même transaction : en cas de
-- coupure, tout est annulé et la demande reste en attente. Une erreur de calcul n'annule que le calcul (sous-transaction) : la demande est alors reprogrammée (délai croissant), puis « echoue »
-- après 5 tentatives, avec le message d'erreur conservé.
CREATE OR REPLACE FUNCTION public.cump_traiter_file(p_limite integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE f record; v_ok integer := 0; v_ko integer := 0; v_i integer := 0;
BEGIN
  LOOP
    EXIT WHEN v_i >= greatest(1, least(p_limite, 200));
    SELECT * INTO f FROM cump_file WHERE statut = 'en_attente' AND disponible_apres <= now() ORDER BY cree_le, id FOR UPDATE SKIP LOCKED LIMIT 1;
    EXIT WHEN NOT FOUND;
    v_i := v_i + 1;
    BEGIN
      PERFORM cump_recalculer_produits(ARRAY[f.product_id], 'auto_' || f.origine, f.reception_id);
      UPDATE cump_file SET statut = 'reussi', tentatives = tentatives + 1, derniere_erreur = NULL, termine_le = now() WHERE id = f.id;
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE cump_file SET tentatives = tentatives + 1, derniere_erreur = left(SQLERRM, 500), derniere_erreur_le = now(),
             statut = CASE WHEN tentatives + 1 >= 5 THEN 'echoue' ELSE 'en_attente' END,
             termine_le = CASE WHEN tentatives + 1 >= 5 THEN now() END,
             disponible_apres = now() + (interval '1 minute' * power(2, least(tentatives, 6)))
       WHERE id = f.id;
      v_ko := v_ko + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('traitees', v_i, 'reussies', v_ok, 'en_erreur', v_ko);
END $$;

-- Reprise des demandes « echoue » : sans doublon (si une demande est déjà en attente pour le produit, l'échec est marqué « fusionne »).
CREATE OR REPLACE FUNCTION public.cump_reprendre_echecs() RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE f record; v_rep integer := 0; v_fus integer := 0;
BEGIN
  FOR f IN SELECT * FROM cump_file WHERE statut = 'echoue' ORDER BY cree_le, id FOR UPDATE SKIP LOCKED LOOP
    IF EXISTS (SELECT 1 FROM cump_file w WHERE w.product_id = f.product_id AND w.statut = 'en_attente') THEN
      UPDATE cump_file SET statut = 'fusionne', termine_le = now() WHERE id = f.id; v_fus := v_fus + 1;
    ELSE
      UPDATE cump_file SET statut = 'en_attente', tentatives = 0, disponible_apres = now(), termine_le = NULL, origine = 'reprise' WHERE id = f.id; v_rep := v_rep + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('reprises', v_rep, 'fusionnees', v_fus);
END $$;

-- Filet de sécurité : redépose une demande pour tout produit dont les données ont changé depuis son dernier calcul (ou jamais calculé).
CREATE OR REPLACE FUNCTION public.cump_detecter_obsoletes() RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_pids uuid[];
BEGIN
  SELECT array_agg(DISTINCT x) INTO v_pids FROM (
    SELECT e.product_id AS x FROM cump_empreintes(NULL) e LEFT JOIN cump_etat_produit s ON s.product_id = e.product_id WHERE s.product_id IS NULL OR s.empreinte_entrees IS DISTINCT FROM e.empreinte
    UNION
    SELECT s.product_id FROM cump_etat_produit s WHERE NOT EXISTS (SELECT 1 FROM cump_empreintes(ARRAY[s.product_id]) e WHERE e.product_id = s.product_id) AND (s.lignes_livrees > 0 OR s.quantite_calculee > 0)
  ) u;
  IF v_pids IS NULL THEN RETURN 0; END IF;
  RETURN cump_enfiler(v_pids, 'balayage');
END $$;

CREATE OR REPLACE FUNCTION public.cump_etat_file() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'automatique', cump_auto_actif(),
    'en_attente', (SELECT count(*) FROM cump_file WHERE statut = 'en_attente'),
    'echoue', (SELECT count(*) FROM cump_file WHERE statut = 'echoue'),
    'reussi_24h', (SELECT count(*) FROM cump_file WHERE statut = 'reussi' AND termine_le > now() - interval '24 hours'),
    'plus_ancienne_attente', (SELECT min(cree_le) FROM cump_file WHERE statut = 'en_attente'),
    'dernieres_erreurs', coalesce((SELECT jsonb_agg(x) FROM (SELECT product_id, derniere_erreur, derniere_erreur_le, tentatives, statut FROM cump_file WHERE derniere_erreur IS NOT NULL AND statut IN ('en_attente', 'echoue') ORDER BY derniere_erreur_le DESC LIMIT 10) x), '[]'::jsonb));
$$;

-- Purge des demandes terminées anciennes (l'historique des CORRECTIONS reste dans cump_recalculs, jamais purgé).
CREATE OR REPLACE FUNCTION public.cump_purger_file(p_jours integer DEFAULT 90) RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM cump_file WHERE statut IN ('reussi', 'fusionne') AND termine_le < now() - make_interval(days => greatest(p_jours, 7));
  GET DIAGNOSTICS v_n = ROW_COUNT; RETURN v_n;
END $$;
GRANT DELETE ON public.cump_file TO service_role;

-- ── Vue : les marges signalent qu'un recalcul est en attente ou en échec (lecture seule, serveur) ───────
CREATE OR REPLACE VIEW public.cump_marges_lignes_suivi WITH (security_invoker = true) AS
SELECT m.*,
       CASE WHEN EXISTS (SELECT 1 FROM cump_file f WHERE f.product_id = m.product_id AND f.statut = 'echoue') THEN 'echec'
            WHEN EXISTS (SELECT 1 FROM cump_file f WHERE f.product_id = m.product_id AND f.statut = 'en_attente') THEN 'en_attente'
            ELSE 'a_jour' END AS etat_recalcul,
       NOT EXISTS (SELECT 1 FROM cump_file f WHERE f.product_id = m.product_id AND f.statut IN ('en_attente', 'echoue')) AS marge_actualisee
FROM cump_marges_lignes m;

-- ── Droits : serveur seulement ──────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.cump_auto_actif(), public.cump_activer_recalcul_automatique(boolean), public.cump_enfiler(uuid[], text, uuid),
  public.cump_trg_lignes_reception(), public.cump_trg_receptions(), public.cump_trg_lignes_commande(), public.cump_trg_journal_livraison(),
  public.cump_traiter_file(integer), public.cump_reprendre_echecs(), public.cump_detecter_obsoletes(), public.cump_etat_file(), public.cump_purger_file(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cump_auto_actif(), public.cump_activer_recalcul_automatique(boolean), public.cump_traiter_file(integer), public.cump_reprendre_echecs(),
  public.cump_detecter_obsoletes(), public.cump_etat_file(), public.cump_purger_file(integer) TO service_role;
REVOKE ALL ON public.cump_marges_lignes_suivi FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cump_marges_lignes_suivi TO service_role;
