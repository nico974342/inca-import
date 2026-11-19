-- CUMP glissant — MÉTHODE v2 (mise à niveau de cump_glissant.sql, à appliquer APRÈS lui et AVANT cump_recalcul_automatique.sql).
--
-- Cette migration ne touche QUE des objets cump_* : elle remplace 3 fonctions (cump_ledger, cump_recalculer_produits, cump_empreintes), ajoute une colonne à cump_etat_produit et une vue de
-- lecture. Aucune table, fonction, donnée ni droit existants hors cump_* n'est modifié ; order_items.pump_snapshot, prix, stocks, réservations, factures, réceptions : jamais écrits.
-- Elle ne recalcule rien : un recalcul complet (cump_recalculer_tout) est une étape distincte, avec accord explicite.
--
-- POURQUOI. L'analyse des données de production (relevé du 2026-11-19) a montré deux faits qui rendaient certains calculs trop prudents :
--   1. RÉCEPTIONS HISTORIQUES : leur date n'est qu'une date d'enregistrement ; les marchandises étaient déjà en stock avant (des ventes de juin précèdent la date des lots du 23 au 30 juin).
--      En les considérant comme du STOCK D'OUVERTURE disponible dès l'origine, 106 produits sur 114 retrouvent exactement leur stock affiché (contre 90), et les 34 ventes de juin concernées
--      reçoivent un coût égal à celui déjà figé à l'époque (marge identique au centime) : la méthode est confirmée par les données. Ces lignes restent classées « estimée » (jamais « fiable »).
--   2. AJUSTEMENTS MANUELS (journal « produit.stock_ajustement ») : trois natures à ne pas confondre —
--        • doublon d'une réception historique (stock saisi de 0 au montant exact d'une réception historique du produit) : IGNORÉ, c'est la même marchandise (évite la double valorisation) ;
--        • entrée de provenance inconnue (hausse sans réception correspondante) : JAMAIS valorisée, jamais ajoutée au stock valorisé (aucun coût inventé) ; elle ne sert pas à couvrir une vente ;
--        • baisse : annule d'abord les entrées inconnues (une correction qui défait une saisie), le reste est une SORTIE RÉELLE (perte, casse, régularisation) qui retire du stock valorisé au
--          coût moyen du moment — sans créer de ligne de marge. Cela rend au stock calculé sa justesse (poids des anciens lots lors d'une réception suivante).
--      Avec ces deux règles, les seuls produits dont le stock affiché diffère encore du stock calculé sont les vraies anomalies (Bum-Bum, trois Red Bull, Sambo Tropical).
--
-- FIABILITÉ v2 d'une ligne livrée : « fiable » / « estimee » / « non_recalculable » comme avant ; « estimee » s'ajoute : vente antérieure à la date d'enregistrement d'un lot historique de son coût
-- (motif lot_historique_anterieur_a_sa_date). Aucun coût n'est jamais inventé : une vente que les lots connus ne couvrent pas reste « non_recalculable ».
--
-- RETOUR ARRIÈRE : réappliquer les définitions de cump_glissant.sql (cump_ledger, cump_recalculer_produits, cump_empreintes) puis DROP VIEW cump_ajustements_classes ;
--   ALTER TABLE cump_etat_produit DROP COLUMN entrees_inconnues. Les résultats déjà calculés restent lisibles (version_methode 1 ou 2).

ALTER TABLE public.cump_etat_produit ADD COLUMN IF NOT EXISTS entrees_inconnues integer;       -- unités ajoutées par un ajustement manuel de provenance inconnue, non valorisées

-- ── Empreinte des données du calcul : ajoute les ajustements manuels ────────────────────────────────────
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
  ), adj AS (
    SELECT p.id AS pid, string_agg(a.id::text || ':' || coalesce(a.details ->> 'avant', '-') || ':' || coalesce(a.details ->> 'apres', '-') || ':' || a.created_at::text, ',' ORDER BY a.id) AS s
    FROM admin_audit_logs a JOIN products p ON p.id::text = a.target_id
    WHERE a.action = 'produit.stock_ajustement' AND (p_ids IS NULL OR p.id = ANY (p_ids)) GROUP BY 1
  ), ids AS (
    SELECT pid FROM rec UNION SELECT pid FROM liv UNION SELECT pid FROM adj
  )
  SELECT ids.pid, md5(coalesce(rec.s, '') || '|' || coalesce(liv.s, '') || '|' || coalesce(adj.s, '') || '|' || coalesce((SELECT p.stock_quantity::text FROM products p WHERE p.id = ids.pid), '-'))
  FROM ids LEFT JOIN rec ON rec.pid = ids.pid LEFT JOIN liv ON liv.pid = ids.pid LEFT JOIN adj ON adj.pid = ids.pid;
$$;

-- ── Moteur : registre chronologique (lecture seule) ─────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.cump_ajustements_classes;                    -- la vue dépend de cump_ledger : retirée puis recréée en fin de fichier (migration rejouable)
DROP FUNCTION IF EXISTS public.cump_ledger(uuid);
CREATE FUNCTION public.cump_ledger(p_product_id uuid)
RETURNS TABLE (ordre integer, k integer, t timestamptz, item_id uuid, order_id uuid, quantite integer, cout_lot numeric, historique boolean,
               q_avant numeric, cump_avant numeric, part_hist_avant numeric, q_apres numeric, cump_apres numeric, part_hist_apres numeric,
               couvert boolean, approx boolean, snap numeric, prix numeric,
               hist_anterieur boolean, adj_classe text, adj_variation integer, u_apres integer)
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  e record; v_q numeric := 0; v_avg numeric := NULL; v_f numeric := 0; v_u integer := 0; v_n integer := 0;
  v_hist_enreg timestamptz; v_abs integer; v_reste integer;
BEGIN
  -- date d'enregistrement la plus tardive des lots historiques du produit (sert uniquement à signaler les ventes antérieures)
  SELECT max(r.received_at::timestamp AT TIME ZONE 'Indian/Reunion') INTO v_hist_enreg
    FROM stock_reception_items i JOIN stock_receptions r ON r.id = i.reception_id
   WHERE i.product_id = p_product_id AND NOT r.stock_applied AND (to_jsonb(r) ->> 'annulee_le') IS NULL;

  FOR e IN
    SELECT * FROM (
      -- réceptions : appliquées à leur date ; historiques = stock d'ouverture, disponibles dès l'origine
      SELECT 0 AS k, CASE WHEN r.stock_applied THEN (r.received_at::timestamp AT TIME ZONE 'Indian/Reunion') ELSE timestamptz '1970-01-01 00:00:00+00' END AS t,
             i.quantity AS qty, i.unit_cost_ht AS cost, NOT r.stock_applied AS hist, NULL::uuid AS item_id, NULL::uuid AS order_id, i.id AS tie, false AS approx,
             NULL::numeric AS snap, NULL::numeric AS prix, NULL::boolean AS doublon
      FROM stock_reception_items i JOIN stock_receptions r ON r.id = i.reception_id
      WHERE i.product_id = p_product_id
        AND (to_jsonb(r) ->> 'annulee_le') IS NULL                       -- réception annulée (réceptions partielles) : exclue, la colonne peut ne pas exister
      UNION ALL
      -- livraisons : à la date de livraison tracée au journal, sinon date de commande (« approchée »)
      SELECT 1, coalesce(tr.t, o.created_at), oi.stock_decremented, NULL::numeric, false, oi.id, o.id, oi.id, (tr.t IS NULL), oi.pump_snapshot, oi.price_ht_snapshot, NULL::boolean
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      LEFT JOIN LATERAL (
        SELECT max(a.created_at) AS t FROM admin_audit_logs a
        WHERE a.action = 'commande.statut' AND a.target_id = o.id::text AND a.details ->> 'nouveau' = 'livree'
      ) tr ON true
      WHERE oi.product_id = p_product_id AND oi.stock_decremented > 0
      UNION ALL
      -- ajustements manuels de stock (journal d'audit) : variation = après − avant
      SELECT 2, a.created_at, ((a.details ->> 'apres')::int - (a.details ->> 'avant')::int), NULL::numeric, false, NULL::uuid, NULL::uuid, a.id, false, NULL::numeric, NULL::numeric,
             ((a.details ->> 'avant')::int = 0 AND (a.details ->> 'apres')::int > 0 AND EXISTS (          -- doublon : stock saisi de 0 au montant exact d'une réception historique du produit
               SELECT 1 FROM stock_reception_items i2 JOIN stock_receptions r2 ON r2.id = i2.reception_id
               WHERE i2.product_id = p_product_id AND NOT r2.stock_applied AND i2.quantity = (a.details ->> 'apres')::int AND (to_jsonb(r2) ->> 'annulee_le') IS NULL))
      FROM admin_audit_logs a
      WHERE a.action = 'produit.stock_ajustement' AND a.target_id = p_product_id::text
        AND coalesce(a.details ->> 'avant', '') ~ '^-?[0-9]+$' AND coalesce(a.details ->> 'apres', '') ~ '^-?[0-9]+$'
    ) x ORDER BY x.t, x.k, x.tie
  LOOP
    v_n := v_n + 1;
    ordre := v_n; k := e.k; t := e.t; item_id := e.item_id; order_id := e.order_id; quantite := e.qty; cout_lot := e.cost; historique := e.hist;
    q_avant := v_q; cump_avant := v_avg; part_hist_avant := v_f; couvert := NULL; approx := e.approx; snap := e.snap; prix := e.prix;
    hist_anterieur := NULL; adj_classe := NULL; adj_variation := NULL;
    IF e.k = 0 THEN
      IF v_q <= 0 OR v_avg IS NULL THEN
        v_avg := e.cost; v_f := CASE WHEN e.hist THEN 1 ELSE 0 END; v_q := e.qty;                     -- plus de stock connu : le coût moyen repart du lot
      ELSE
        v_f   := (v_q * v_f + CASE WHEN e.hist THEN e.qty ELSE 0 END) / (v_q + e.qty);
        v_avg := (v_q * v_avg + e.qty * e.cost) / (v_q + e.qty);
        v_q   := v_q + e.qty;
      END IF;
    ELSIF e.k = 1 THEN
      couvert := v_q >= e.qty;                                                                        -- toute la quantité doit venir de lots connus
      hist_anterieur := (v_f > 0.01 AND v_hist_enreg IS NOT NULL AND e.t < v_hist_enreg);            -- vendu avant la date d'enregistrement d'un lot historique de son coût
      v_q := greatest(0, v_q - e.qty);
    ELSE
      adj_variation := e.qty;
      IF e.qty > 0 THEN
        IF e.doublon THEN adj_classe := 'doublon_reception_historique';                              -- même marchandise que la réception historique : ignoré
        ELSE adj_classe := 'entree_provenance_inconnue'; v_u := v_u + e.qty; END IF;                  -- jamais valorisée, jamais ajoutée au stock valorisé
      ELSIF e.qty < 0 THEN
        v_abs := least(v_u, -e.qty); v_u := v_u - v_abs; v_reste := -e.qty - v_abs;
        IF v_reste > 0 THEN
          adj_classe := CASE WHEN v_abs > 0 THEN 'sortie_reelle_apres_annulation_entree' ELSE 'sortie_reelle' END;
          v_q := greatest(0, v_q - v_reste);                                                           -- perte réelle : sort du stock valorisé au coût moyen, sans ligne de marge
        ELSE adj_classe := 'correction_annule_entree'; END IF;                                        -- défait une entrée inconnue : neutre
      ELSE adj_classe := 'sans_effet'; END IF;
    END IF;
    q_apres := v_q; cump_apres := v_avg; part_hist_apres := v_f; u_apres := v_u;
    RETURN NEXT;
  END LOOP;
END $$;

-- ── Moteur : recalcul de produits (écrit UNIQUEMENT dans cump_*) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cump_recalculer_produits(p_product_ids uuid[], p_declencheur text DEFAULT 'manuel', p_reception_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_pids uuid[]; v_pid uuid; r record; o record;
  v_stock integer; v_qfin numeric; v_avgfin numeric; v_ffin numeric; v_ufin integer; v_coherent boolean; v_nlig integer;
  v_fiab text; v_motif text; v_cout numeric; v_recon boolean;
  v_lignes integer := 0; v_modif integer := 0; v_avant numeric := 0; v_apres numeric := 0; v_detail jsonb := '[]'::jsonb; v_detail_n integer := 0; v_tronque boolean := false;
  v_avant_l numeric; v_apres_l numeric; v_change boolean; v_supprimees integer := 0; v_ids uuid[]; v_emp text; v_incoh boolean;
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
    SELECT l.q_apres, l.cump_apres, l.part_hist_apres, l.u_apres INTO v_qfin, v_avgfin, v_ffin, v_ufin FROM cump_ledger(v_pid) l ORDER BY l.ordre DESC LIMIT 1;
    v_qfin := coalesce(v_qfin, 0); v_ufin := coalesce(v_ufin, 0);
    SELECT stock_quantity INTO v_stock FROM products WHERE id = v_pid;
    v_coherent := (v_stock IS NOT NULL AND v_stock = v_qfin + v_ufin);                  -- les entrées de provenance inconnue sont physiquement présentes : elles comptent dans le stock affiché
    v_incoh := NOT v_coherent;

    -- 2) lignes livrées
    v_nlig := 0; v_ids := '{}';
    FOR r IN SELECT * FROM cump_ledger(v_pid) l WHERE l.k = 1 ORDER BY l.ordre LOOP
      v_nlig := v_nlig + 1; v_ids := v_ids || r.item_id;
      v_motif := NULL; v_recon := false; v_cout := NULL;
      IF NOT r.couvert THEN
        v_fiab := 'non_recalculable'; v_motif := 'stock_ouverture_inconnu';
      ELSE
        v_cout := r.cump_avant;
        IF r.approx OR r.hist_anterieur OR (r.part_hist_avant > 0.01 AND v_incoh) THEN v_fiab := 'estimee'; ELSE v_fiab := 'fiable'; END IF;
        v_motif := nullif(concat_ws(',', CASE WHEN r.approx THEN 'date_livraison_approchee' END,
                                         CASE WHEN r.hist_anterieur THEN 'lot_historique_anterieur_a_sa_date' END,
                                         CASE WHEN r.part_hist_avant > 0.01 AND v_incoh THEN 'lots_historiques_stock_incoherent' END), '');
        IF r.snap IS NULL THEN                                                         -- ligne sans coût d'origine
          IF v_fiab = 'fiable' THEN v_recon := true;
          ELSE v_fiab := 'non_recalculable'; v_cout := NULL; v_motif := 'sans_cout_origine_reconstitution_non_fiable'; END IF;
        END IF;
      END IF;

      SELECT * INTO o FROM cump_sorties WHERE order_item_id = r.item_id;
      INSERT INTO cump_sorties (order_item_id, order_id, product_id, date_sortie, source_date, quantite, cout_initial, cout_cump, fiabilite, reconstitue, motif, part_historique, couvert, version_methode)
      VALUES (r.item_id, r.order_id, v_pid, r.t, CASE WHEN r.approx THEN 'creation_commande_approchee' ELSE 'journal_livraison' END, r.quantite, r.snap, v_cout, v_fiab, v_recon, v_motif,
              r.part_hist_avant, r.couvert, 2)
      ON CONFLICT (order_item_id) DO UPDATE SET
        order_id = EXCLUDED.order_id, product_id = EXCLUDED.product_id, date_sortie = EXCLUDED.date_sortie, source_date = EXCLUDED.source_date, quantite = EXCLUDED.quantite,
        cout_cump = EXCLUDED.cout_cump, fiabilite = EXCLUDED.fiabilite, reconstitue = EXCLUDED.reconstitue, motif = EXCLUDED.motif, part_historique = EXCLUDED.part_historique,
        couvert = EXCLUDED.couvert, version_methode = EXCLUDED.version_methode, calcule_le = now();               -- cout_initial et cree_le ne sont jamais réécrits

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

    INSERT INTO cump_etat_produit (product_id, quantite_calculee, cump_courant, part_historique, stock_affiche, ecart_stock, coherent, lignes_livrees, empreinte_entrees, entrees_inconnues, calcule_le)
    VALUES (v_pid, v_qfin, v_avgfin, v_ffin, v_stock, CASE WHEN v_stock IS NULL THEN NULL ELSE v_stock - v_qfin - v_ufin END, v_coherent, coalesce(array_length(v_ids, 1), 0), v_emp, v_ufin, now())
    ON CONFLICT (product_id) DO UPDATE SET quantite_calculee = EXCLUDED.quantite_calculee, cump_courant = EXCLUDED.cump_courant, part_historique = EXCLUDED.part_historique,
      stock_affiche = EXCLUDED.stock_affiche, ecart_stock = EXCLUDED.ecart_stock, coherent = EXCLUDED.coherent, lignes_livrees = EXCLUDED.lignes_livrees, empreinte_entrees = EXCLUDED.empreinte_entrees,
      entrees_inconnues = EXCLUDED.entrees_inconnues, calcule_le = now();
  END LOOP;

  -- Le journal garde les CORRECTIONS : un recalcul automatique qui ne modifie aucune ligne n'y ajoute rien (le suivi des recalculs est dans cump_file).
  IF v_modif > 0 OR p_declencheur NOT LIKE 'auto\_%' THEN
    INSERT INTO cump_recalculs (declencheur, reception_id, produits, lignes, lignes_modifiees, marge_avant, marge_apres, detail, detail_tronque)
    VALUES (p_declencheur, p_reception_id, v_pids, v_lignes, v_modif, round(v_avant, 2), round(v_apres, 2), v_detail, v_tronque);
  END IF;
  RETURN jsonb_build_object('produits', array_length(v_pids, 1), 'lignes', v_lignes, 'modifiees', v_modif, 'supprimees', v_supprimees, 'marge_avant', round(v_avant, 2), 'marge_apres', round(v_apres, 2));
END $$;

-- ── Vue de lecture : nature de chaque ajustement manuel de stock (lecture seule, serveur) ────────────────
CREATE OR REPLACE VIEW public.cump_ajustements_classes WITH (security_invoker = true) AS
SELECT p.id AS product_id, p.name AS produit, l.t AS date_ajustement, l.adj_variation AS variation, l.adj_classe AS classe, l.u_apres AS entrees_inconnues_apres
FROM products p CROSS JOIN LATERAL cump_ledger(p.id) l WHERE l.k = 2;

REVOKE ALL ON FUNCTION public.cump_empreintes(uuid[]), public.cump_ledger(uuid), public.cump_recalculer_produits(uuid[], text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cump_empreintes(uuid[]), public.cump_ledger(uuid), public.cump_recalculer_produits(uuid[], text, uuid) TO service_role;
REVOKE ALL ON public.cump_ajustements_classes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cump_ajustements_classes TO service_role;
