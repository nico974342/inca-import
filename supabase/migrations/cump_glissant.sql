-- CUMP glissant : coût de revient RÉALISÉ des ventes, recalculable après correction d'un coût d'achat ancien.
--
-- ADDITIF ET ISOLÉ. Cette migration crée de NOUVEAUX objets (3 tables, 5 fonctions, 1 vue). Elle ne modifie, ne remplace et ne supprime AUCUN objet existant, et n'écrit dans AUCUNE
-- table existante : ni order_items.pump_snapshot (conservé à l'identique, c'est le coût « prévisionnel » de la commande), ni prix de vente, factures, stocks physiques, réservations,
-- réceptions. Les écrans de marges et products.prix_achat_moyen_ht NE SONT PAS basculés : rien ne lit ces objets tant qu'on ne l'a pas décidé.
-- Aucun déclencheur n'est posé sur les réceptions : le recalcul est appelé explicitement (cump_recalculer_produits), jamais en cascade dans reception_create/update/delete.
--
-- MÉTHODE (par produit, dans l'ordre du temps) :
--   • Entrée  : chaque ligne de réception (appliquée OU historique, hors réception annulée) à la date de réception (minuit, heure de La Réunion).
--               coût moyen = (stock × coût moyen + quantité × coût) / (stock + quantité) ; si le stock est nul, le coût moyen repart du coût du lot.
--   • Sortie  : chaque ligne livrée (order_items.stock_decremented) à la date de LIVRAISON = dernier passage à « livree » du journal d'audit (commande.statut) ;
--               sans trace (2 commandes de juin 2026), la date de création de la commande, signalée « approchée ». Coût de la sortie = coût moyen avant la sortie.
--   • Couverture : une vente n'est recalculée que si le stock connu (lots) couvre TOUTE sa quantité à cette date ; sinon « non_recalculable » : aucun coût d'ouverture n'est inventé.
--   • Les quantités viennent des événements (réceptions, livraisons), JAMAIS de products.stock_quantity : un stock faussé n'influence pas le calcul.
--
-- RÉCEPTIONS HISTORIQUES (stock_applied = false) : leur stock était déjà dans le stock d'ouverture. Elles servent ici uniquement de lots de COÛT (information historique) ; elles ne créent
-- JAMAIS de stock (products.stock_quantity n'est jamais touché) et les ajustements manuels du journal ne sont jamais ajoutés comme lots : pas de double valorisation. Un contrôle de cohérence
-- compare le stock du calcul au stock affiché (cump_etat_produit.coherent) ; un produit incohérent voit ses coûts dépendant de lots historiques classés « estimée ».
--
-- FIABILITÉ de chaque ligne livrée :
--   fiable           : stock couvert, date de livraison tracée, coût ne dépendant pas d'un lot historique incohérent.
--   estimee          : stock couvert mais date de livraison approchée, ou coût issu de lots historiques d'un produit dont le stock ne concorde pas.
--   non_recalculable : stock connu insuffisant (stock d'ouverture inconnu), ou ligne sans coût d'origine dont la reconstitution n'est pas fiable. Aucun coût recalculé n'est stocké.
--   « Coût reconstitué » (reconstitue = true) : ligne SANS pump_snapshot d'origine, dont le coût est reconstitué de façon FIABLE à partir des réceptions enregistrées.
--
-- HISTORIQUE : cout_initial (copie de pump_snapshot au premier calcul) est immuable (déclencheur). cump_recalculs est un journal append-only : pour chaque recalcul, produits touchés,
-- lignes modifiées, marge avant/après, détail ligne à ligne (plafonné).
--
-- RETOUR ARRIÈRE (sans toucher aux données existantes) :
--   DROP VIEW cump_marges_lignes; DROP FUNCTION cump_recalculer_tout(text), cump_recalculer_produits(uuid[], text, uuid), cump_ledger(uuid), cump_empreintes(uuid[]);
--   DROP TABLE cump_sorties, cump_etat_produit, cump_recalculs;  (puis fonctions de protection cump_*_proteger)
--   Aucune autre fonction ni table n'en dépend.

-- ── Tables ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cump_sorties (
  order_item_id   uuid PRIMARY KEY,
  order_id        uuid NOT NULL,
  product_id      uuid NOT NULL,
  date_sortie     timestamptz NOT NULL,
  source_date     text NOT NULL CHECK (source_date IN ('journal_livraison', 'creation_commande_approchee')),
  quantite        integer NOT NULL CHECK (quantite > 0),
  cout_initial    numeric,                                     -- copie immuable de order_items.pump_snapshot au premier calcul (NULL si la ligne n'en avait pas)
  cout_cump       numeric,                                     -- coût recalculé (par carton) ; NULL si non recalculable
  fiabilite       text NOT NULL CHECK (fiabilite IN ('fiable', 'estimee', 'non_recalculable')),
  reconstitue     boolean NOT NULL DEFAULT false,
  motif           text,
  part_historique numeric,                                     -- part (0..1) du coût moyen issue de lots de réceptions historiques
  couvert         boolean NOT NULL,
  version_methode integer NOT NULL DEFAULT 1,
  calcule_le      timestamptz NOT NULL DEFAULT now(),
  cree_le         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cump_sorties_cout_ou_non_recalculable CHECK (cout_cump IS NOT NULL OR fiabilite = 'non_recalculable'),
  CONSTRAINT cump_sorties_reconstitue_coherent CHECK (NOT reconstitue OR (cout_initial IS NULL AND fiabilite = 'fiable' AND cout_cump IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS cump_sorties_produit_idx ON public.cump_sorties (product_id, date_sortie);

CREATE TABLE IF NOT EXISTS public.cump_etat_produit (
  product_id         uuid PRIMARY KEY,
  quantite_calculee  numeric NOT NULL,                         -- stock selon les événements (réceptions − livraisons), jamais négatif
  cump_courant       numeric,                                  -- coût moyen de la marchandise restante ; NULL si aucun lot connu
  part_historique    numeric,
  stock_affiche      integer,
  ecart_stock        numeric,                                  -- stock affiché − quantité calculée (information, n'est jamais corrigé ici)
  coherent           boolean NOT NULL,
  lignes_livrees     integer NOT NULL,
  empreinte_entrees  text,                                     -- empreinte des données utilisées au dernier calcul : sert à détecter un produit dont les données ont changé depuis
  calcule_le         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cump_recalculs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  declencheur      text NOT NULL,
  reception_id     uuid,
  produits         uuid[] NOT NULL,
  lignes           integer NOT NULL,
  lignes_modifiees integer NOT NULL,
  marge_avant      numeric,                                    -- somme (prix − coût avant) × quantité, lignes ayant un prix ; coût avant = dernier coût recalculé, sinon coût d'origine
  marge_apres      numeric,
  detail           jsonb NOT NULL DEFAULT '[]'::jsonb,         -- lignes modifiées : {ligne, avant, apres, fiabilite}, plafonné
  detail_tronque   boolean NOT NULL DEFAULT false,
  cree_le          timestamptz NOT NULL DEFAULT now()
);

-- ── Protection : coût d'origine immuable, journal append-only ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cump_sorties_proteger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'CUMP_NON_VIDABLE : l''historique des coûts ne se vide pas'; END IF;
  IF NEW.cout_initial IS DISTINCT FROM OLD.cout_initial OR NEW.cree_le IS DISTINCT FROM OLD.cree_le OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id THEN
    RAISE EXCEPTION 'COUT_INITIAL_IMMUABLE : le coût d''origine d''une ligne ne se modifie jamais';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_cump_sorties_proteger ON public.cump_sorties;
CREATE TRIGGER trg_cump_sorties_proteger BEFORE UPDATE ON public.cump_sorties FOR EACH ROW EXECUTE FUNCTION public.cump_sorties_proteger();
DROP TRIGGER IF EXISTS trg_cump_sorties_proteger_truncate ON public.cump_sorties;
CREATE TRIGGER trg_cump_sorties_proteger_truncate BEFORE TRUNCATE ON public.cump_sorties FOR EACH STATEMENT EXECUTE FUNCTION public.cump_sorties_proteger();

CREATE OR REPLACE FUNCTION public.cump_recalculs_proteger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'CUMP_JOURNAL_APPEND_ONLY : le journal des recalculs ne se modifie ni ne se supprime'; END $$;
DROP TRIGGER IF EXISTS trg_cump_recalculs_proteger ON public.cump_recalculs;
CREATE TRIGGER trg_cump_recalculs_proteger BEFORE UPDATE OR DELETE ON public.cump_recalculs FOR EACH ROW EXECUTE FUNCTION public.cump_recalculs_proteger();
DROP TRIGGER IF EXISTS trg_cump_recalculs_proteger_truncate ON public.cump_recalculs;
CREATE TRIGGER trg_cump_recalculs_proteger_truncate BEFORE TRUNCATE ON public.cump_recalculs FOR EACH STATEMENT EXECUTE FUNCTION public.cump_recalculs_proteger();

-- ── Droits : serveur seulement ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.cump_sorties      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cump_etat_produit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cump_recalculs    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cump_sorties, public.cump_etat_produit, public.cump_recalculs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cump_sorties, public.cump_etat_produit TO service_role;
GRANT SELECT, INSERT ON public.cump_recalculs TO service_role;
REVOKE EXECUTE ON FUNCTION public.cump_sorties_proteger(), public.cump_recalculs_proteger() FROM PUBLIC, anon, authenticated;

-- ── Empreinte des données utilisées par le calcul (lecture seule) ─────────────────────────────────────────
-- Réceptions (quantité, coût, statut, date, annulation), lignes livrées avec leur date de livraison tracée, stock affiché. Deux empreintes différentes = le calcul d'un produit est périmé.
CREATE OR REPLACE FUNCTION public.cump_empreintes(p_ids uuid[] DEFAULT NULL)
RETURNS TABLE (product_id uuid, empreinte text)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH rec AS (
    SELECT i.product_id AS pid, string_agg(i.id::text || ':' || i.quantity || ':' || i.unit_cost_ht || ':' || r.stock_applied || ':' || r.received_at || ':' || coalesce(to_jsonb(r) ->> 'annulee_le', '-'), ',' ORDER BY i.id) AS s
    FROM stock_reception_items i JOIN stock_receptions r ON r.id = i.reception_id WHERE (p_ids IS NULL OR i.product_id = ANY (p_ids)) GROUP BY 1
  ), liv AS (
    SELECT oi.product_id AS pid, string_agg(oi.id::text || ':' || oi.stock_decremented || ':' ||
             coalesce((SELECT max(a.created_at)::text FROM admin_audit_logs a WHERE a.action = 'commande.statut' AND a.target_id = oi.order_id::text AND a.details ->> 'nouveau' = 'livree'), '-'), ',' ORDER BY oi.id) AS s
    FROM order_items oi WHERE oi.stock_decremented > 0 AND oi.product_id IS NOT NULL AND (p_ids IS NULL OR oi.product_id = ANY (p_ids)) GROUP BY 1
  )
  SELECT coalesce(rec.pid, liv.pid), md5(coalesce(rec.s, '') || '|' || coalesce(liv.s, '') || '|' || coalesce((SELECT p.stock_quantity::text FROM products p WHERE p.id = coalesce(rec.pid, liv.pid)), '-'))
  FROM rec FULL JOIN liv ON liv.pid = rec.pid;
$$;

-- ── Moteur : registre chronologique d'un produit (lecture seule) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cump_ledger(p_product_id uuid)
RETURNS TABLE (ordre integer, k integer, t timestamptz, item_id uuid, order_id uuid, quantite integer, cout_lot numeric, historique boolean,
               q_avant numeric, cump_avant numeric, part_hist_avant numeric, q_apres numeric, cump_apres numeric, part_hist_apres numeric,
               couvert boolean, approx boolean, snap numeric, prix numeric)
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  e record; v_q numeric := 0; v_avg numeric := NULL; v_f numeric := 0; v_n integer := 0;
BEGIN
  FOR e IN
    SELECT * FROM (
      SELECT 0 AS k, (r.received_at::timestamp AT TIME ZONE 'Indian/Reunion') AS t, i.quantity AS qty, i.unit_cost_ht AS cost, NOT r.stock_applied AS hist,
             NULL::uuid AS item_id, NULL::uuid AS order_id, i.id AS tie, false AS approx, NULL::numeric AS snap, NULL::numeric AS prix
      FROM stock_reception_items i JOIN stock_receptions r ON r.id = i.reception_id
      WHERE i.product_id = p_product_id
        AND (to_jsonb(r) ->> 'annulee_le') IS NULL                       -- réception annulée (réceptions partielles) : exclue, la colonne peut ne pas exister
      UNION ALL
      SELECT 1, coalesce(tr.t, o.created_at), oi.stock_decremented, NULL::numeric, false, oi.id, o.id, oi.id, (tr.t IS NULL), oi.pump_snapshot, oi.price_ht_snapshot
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      LEFT JOIN LATERAL (
        SELECT max(a.created_at) AS t FROM admin_audit_logs a
        WHERE a.action = 'commande.statut' AND a.target_id = o.id::text AND a.details ->> 'nouveau' = 'livree'
      ) tr ON true
      WHERE oi.product_id = p_product_id AND oi.stock_decremented > 0
    ) x ORDER BY x.t, x.k, x.tie
  LOOP
    v_n := v_n + 1;
    ordre := v_n; k := e.k; t := e.t; item_id := e.item_id; order_id := e.order_id; quantite := e.qty; cout_lot := e.cost; historique := e.hist;
    q_avant := v_q; cump_avant := v_avg; part_hist_avant := v_f; couvert := NULL; approx := e.approx; snap := e.snap; prix := e.prix;
    IF e.k = 0 THEN
      IF v_q <= 0 OR v_avg IS NULL THEN
        v_avg := e.cost; v_f := CASE WHEN e.hist THEN 1 ELSE 0 END; v_q := e.qty;                     -- plus de stock connu : le coût moyen repart du lot
      ELSE
        v_f   := (v_q * v_f + CASE WHEN e.hist THEN e.qty ELSE 0 END) / (v_q + e.qty);
        v_avg := (v_q * v_avg + e.qty * e.cost) / (v_q + e.qty);
        v_q   := v_q + e.qty;
      END IF;
    ELSE
      couvert := v_q >= e.qty;                                                                        -- toute la quantité doit venir de lots connus
      v_q := greatest(0, v_q - e.qty);
    END IF;
    q_apres := v_q; cump_apres := v_avg; part_hist_apres := v_f;
    RETURN NEXT;
  END LOOP;
END $$;

-- ── Moteur : recalcul de produits (écrit UNIQUEMENT dans cump_*) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cump_recalculer_produits(p_product_ids uuid[], p_declencheur text DEFAULT 'manuel', p_reception_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_pids uuid[]; v_pid uuid; r record; o record;
  v_stock integer; v_qfin numeric; v_avgfin numeric; v_ffin numeric; v_coherent boolean; v_nlig integer;
  v_fiab text; v_motif text; v_cout numeric; v_recon boolean;
  v_lignes integer := 0; v_modif integer := 0; v_avant numeric := 0; v_apres numeric := 0; v_detail jsonb := '[]'::jsonb; v_detail_n integer := 0; v_tronque boolean := false;
  v_avant_l numeric; v_apres_l numeric; v_change boolean; v_supprimees integer := 0; v_ids uuid[]; v_emp text;
BEGIN
  IF p_declencheur NOT IN ('manuel', 'initial', 'reception_creation', 'reception_modification', 'reception_suppression', 'controle', 'auto_reception', 'auto_livraison', 'auto_balayage', 'auto_reprise') THEN
    RAISE EXCEPTION 'CUMP_DECLENCHEUR_INVALIDE : %', p_declencheur;
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_pids FROM unnest(p_product_ids) x WHERE x IS NOT NULL;
  IF v_pids IS NULL THEN RETURN jsonb_build_object('produits', 0, 'lignes', 0, 'modifiees', 0); END IF;

  FOREACH v_pid IN ARRAY v_pids LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('cump:' || v_pid::text, 0));       -- un seul recalcul à la fois par produit

    -- empreinte AVANT le calcul : si une donnée change pendant le calcul, l'empreinte enregistrée sera plus ancienne que les données et le produit sera recalculé au balayage
    SELECT e.empreinte INTO v_emp FROM cump_empreintes(ARRAY[v_pid]) e;

    -- 1) état final et cohérence avec le stock affiché (lecture seule du stock)
    SELECT l.q_apres, l.cump_apres, l.part_hist_apres INTO v_qfin, v_avgfin, v_ffin FROM cump_ledger(v_pid) l ORDER BY l.ordre DESC LIMIT 1;
    v_qfin := coalesce(v_qfin, 0);
    SELECT stock_quantity INTO v_stock FROM products WHERE id = v_pid;
    v_coherent := (v_stock IS NOT NULL AND v_stock = v_qfin);

    -- 2) lignes livrées
    v_nlig := 0; v_ids := '{}';
    FOR r IN SELECT * FROM cump_ledger(v_pid) l WHERE l.k = 1 ORDER BY l.ordre LOOP
      v_nlig := v_nlig + 1; v_ids := v_ids || r.item_id;
      v_motif := NULL; v_recon := false; v_cout := NULL;
      IF NOT r.couvert THEN
        v_fiab := 'non_recalculable'; v_motif := 'stock_ouverture_inconnu';
      ELSE
        v_cout := r.cump_avant;
        IF r.approx OR (r.part_hist_avant > 0.01 AND NOT v_coherent) THEN v_fiab := 'estimee'; ELSE v_fiab := 'fiable'; END IF;
        v_motif := nullif(concat_ws(',', CASE WHEN r.approx THEN 'date_livraison_approchee' END,
                                         CASE WHEN r.part_hist_avant > 0.01 AND NOT v_coherent THEN 'lots_historiques_stock_incoherent' END), '');
        IF r.snap IS NULL THEN                                                         -- ligne sans coût d'origine
          IF v_fiab = 'fiable' THEN v_recon := true;
          ELSE v_fiab := 'non_recalculable'; v_cout := NULL; v_motif := 'sans_cout_origine_reconstitution_non_fiable'; END IF;
        END IF;
      END IF;

      SELECT * INTO o FROM cump_sorties WHERE order_item_id = r.item_id;
      INSERT INTO cump_sorties (order_item_id, order_id, product_id, date_sortie, source_date, quantite, cout_initial, cout_cump, fiabilite, reconstitue, motif, part_historique, couvert)
      VALUES (r.item_id, r.order_id, v_pid, r.t, CASE WHEN r.approx THEN 'creation_commande_approchee' ELSE 'journal_livraison' END, r.quantite, r.snap, v_cout, v_fiab, v_recon, v_motif,
              r.part_hist_avant, r.couvert)
      ON CONFLICT (order_item_id) DO UPDATE SET
        order_id = EXCLUDED.order_id, product_id = EXCLUDED.product_id, date_sortie = EXCLUDED.date_sortie, source_date = EXCLUDED.source_date, quantite = EXCLUDED.quantite,
        cout_cump = EXCLUDED.cout_cump, fiabilite = EXCLUDED.fiabilite, reconstitue = EXCLUDED.reconstitue, motif = EXCLUDED.motif, part_historique = EXCLUDED.part_historique,
        couvert = EXCLUDED.couvert, calcule_le = now();                               -- cout_initial et cree_le ne sont jamais réécrits

      v_lignes := v_lignes + 1;
      IF r.prix IS NOT NULL THEN
        v_avant_l := (r.prix - coalesce(o.cout_cump, r.snap, 0)) * r.quantite * CASE WHEN coalesce(o.cout_cump, r.snap) IS NULL THEN 0 ELSE 1 END;
        v_apres_l := (r.prix - coalesce(v_cout, r.snap, 0)) * r.quantite * CASE WHEN coalesce(v_cout, r.snap) IS NULL THEN 0 ELSE 1 END;
        v_avant := v_avant + v_avant_l; v_apres := v_apres + v_apres_l;
      END IF;
      v_change := (o.order_item_id IS NULL) OR o.cout_cump IS DISTINCT FROM v_cout OR o.fiabilite IS DISTINCT FROM v_fiab OR o.reconstitue IS DISTINCT FROM v_recon;
      IF v_change THEN
        v_modif := v_modif + 1;
        IF v_detail_n < 1000 THEN
          v_detail := v_detail || jsonb_build_object('ligne', r.item_id, 'avant', CASE WHEN o.order_item_id IS NULL THEN NULL ELSE o.cout_cump END, 'avant_origine', r.snap, 'apres', v_cout, 'fiabilite', v_fiab);
          v_detail_n := v_detail_n + 1;
        ELSE v_tronque := true; END IF;
      END IF;
    END LOOP;

    -- lignes qui ne sont plus des sorties de stock (retour arrière de livraison, suppression) : leur calcul dérivé est retiré (le journal garde la trace des recalculs)
    DELETE FROM cump_sorties WHERE product_id = v_pid AND NOT (order_item_id = ANY (v_ids));
    GET DIAGNOSTICS v_nlig = ROW_COUNT; v_supprimees := v_supprimees + v_nlig;

    INSERT INTO cump_etat_produit (product_id, quantite_calculee, cump_courant, part_historique, stock_affiche, ecart_stock, coherent, lignes_livrees, empreinte_entrees, calcule_le)
    VALUES (v_pid, v_qfin, v_avgfin, v_ffin, v_stock, CASE WHEN v_stock IS NULL THEN NULL ELSE v_stock - v_qfin END, v_coherent, coalesce(array_length(v_ids, 1), 0), v_emp, now())
    ON CONFLICT (product_id) DO UPDATE SET quantite_calculee = EXCLUDED.quantite_calculee, cump_courant = EXCLUDED.cump_courant, part_historique = EXCLUDED.part_historique,
      stock_affiche = EXCLUDED.stock_affiche, ecart_stock = EXCLUDED.ecart_stock, coherent = EXCLUDED.coherent, lignes_livrees = EXCLUDED.lignes_livrees, empreinte_entrees = EXCLUDED.empreinte_entrees, calcule_le = now();
  END LOOP;

  -- Le journal garde les CORRECTIONS : un recalcul automatique qui ne modifie aucune ligne n'y ajoute rien (le suivi des recalculs est dans cump_file).
  IF v_modif > 0 OR p_declencheur NOT LIKE 'auto\_%' THEN
    INSERT INTO cump_recalculs (declencheur, reception_id, produits, lignes, lignes_modifiees, marge_avant, marge_apres, detail, detail_tronque)
    VALUES (p_declencheur, p_reception_id, v_pids, v_lignes, v_modif, round(v_avant, 2), round(v_apres, 2), v_detail, v_tronque);
  END IF;
  RETURN jsonb_build_object('produits', array_length(v_pids, 1), 'lignes', v_lignes, 'modifiees', v_modif, 'supprimees', v_supprimees, 'marge_avant', round(v_avant, 2), 'marge_apres', round(v_apres, 2));
END $$;

-- Recalcul de tous les produits ayant des réceptions ou des livraisons (remplissage initial : à n'exécuter qu'avec un accord explicite).
CREATE OR REPLACE FUNCTION public.cump_recalculer_tout(p_declencheur text DEFAULT 'initial') RETURNS jsonb
LANGUAGE sql SET search_path = public, pg_temp AS $$
  SELECT public.cump_recalculer_produits(
    (SELECT array_agg(DISTINCT pid) FROM (
       SELECT product_id AS pid FROM stock_reception_items
       UNION SELECT product_id FROM order_items WHERE stock_decremented > 0 AND product_id IS NOT NULL) u),
    p_declencheur, NULL);
$$;

REVOKE ALL ON FUNCTION public.cump_empreintes(uuid[]), public.cump_ledger(uuid), public.cump_recalculer_produits(uuid[], text, uuid), public.cump_recalculer_tout(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cump_empreintes(uuid[]), public.cump_ledger(uuid), public.cump_recalculer_produits(uuid[], text, uuid), public.cump_recalculer_tout(text) TO service_role;

-- ── Vue de lecture : marge PRÉVISIONNELLE (coût à la commande) et marge RÉALISÉE (coût à la livraison) ─────
-- Lecture seule, réservée au serveur. Aucun écran n'y est branché pour l'instant.
CREATE OR REPLACE VIEW public.cump_marges_lignes WITH (security_invoker = true) AS
SELECT oi.id AS order_item_id, oi.order_id, oi.product_id, o.status AS statut, o.created_at AS date_commande, cs.date_sortie, cs.source_date,
       oi.quantity AS quantite, oi.price_ht_snapshot AS prix_vente_ht,
       oi.pump_snapshot AS cout_previsionnel,                                   -- coût figé à la création de la commande (jamais modifié)
       cs.cout_cump AS cout_realise,                                            -- coût moyen au moment de la livraison (NULL si non recalculable)
       cs.fiabilite, coalesce(cs.reconstitue, false) AS reconstitue, cs.motif,
       CASE WHEN oi.price_ht_snapshot IS NOT NULL AND oi.pump_snapshot IS NOT NULL THEN (oi.price_ht_snapshot - oi.pump_snapshot) * oi.quantity END AS marge_previsionnelle,
       CASE WHEN oi.price_ht_snapshot IS NOT NULL AND cs.cout_cump IS NOT NULL THEN (oi.price_ht_snapshot - cs.cout_cump) * oi.quantity END AS marge_realisee,
       CASE WHEN cs.order_item_id IS NOT NULL THEN cs.fiabilite
            WHEN o.status = 'annulee' THEN 'annulee'
            WHEN o.status = 'livree' THEN 'non_calculee'
            ELSE 'en_cours' END AS statut_marge
FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN cump_sorties cs ON cs.order_item_id = oi.id;
REVOKE ALL ON public.cump_marges_lignes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cump_marges_lignes TO service_role;
