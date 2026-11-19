-- SUIVI DU RECALCUL AUTOMATIQUE — LECTURE SEULE (aucune écriture). À lancer avant l'activation, juste après, puis régulièrement les premiers jours.
-- Lecture attendue : interrupteur cohérent avec l'étape en cours ; 6 déclencheurs cump_* tous actifs (tgenabled = 'O') ; demandes « en_attente » qui retombent à 0 après chaque opération ;
-- « echoue » = 0 ; « produits_perimes » = 0 (sinon : balayage, voir la procédure) ; aucune différence de données commerciales (relevé avant/après : receptions_stock_differentiel_avant_apres.sql).
SELECT k, v FROM (
  SELECT 1 AS o, 'interrupteur_recalcul_automatique' AS k, coalesce((SELECT valeur FROM cump_config WHERE cle = 'recalcul_automatique'), 'absent') AS v
  UNION ALL SELECT 2, 'declencheurs_cump (attendu : 6, tous actifs)',
    count(*) || ' : ' || coalesce(string_agg(tgrelid::regclass::text || '.' || tgname || '=' || tgenabled::text, ' ; ' ORDER BY tgname), '-')
    FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg\_cump\_%' AND tgrelid::regclass::text NOT LIKE 'cump\_%' AND tgrelid::regclass::text NOT LIKE 'public.cump\_%'
  UNION ALL SELECT 3, 'file.en_attente', count(*)::text FROM cump_file WHERE statut = 'en_attente'
  UNION ALL SELECT 4, 'file.echoue', count(*)::text FROM cump_file WHERE statut = 'echoue'
  UNION ALL SELECT 5, 'file.reussi_24h', count(*)::text FROM cump_file WHERE statut = 'reussi' AND termine_le > now() - interval '24 hours'
  UNION ALL SELECT 6, 'file.plus_ancienne_attente', coalesce(min(cree_le)::text, '-') FROM cump_file WHERE statut = 'en_attente'
  UNION ALL SELECT 7, 'file.dernieres_erreurs', coalesce(string_agg(left(derniere_erreur, 120) || ' (' || statut || ', ' || tentatives || ' essais)', ' | '), '-') FROM (SELECT * FROM cump_file WHERE derniere_erreur IS NOT NULL ORDER BY derniere_erreur_le DESC LIMIT 5) e
  UNION ALL SELECT 8, 'produits_perimes (données modifiées depuis le dernier calcul)', count(*)::text
    FROM cump_empreintes(NULL) e LEFT JOIN cump_etat_produit s ON s.product_id = e.product_id WHERE s.product_id IS NULL OR s.empreinte_entrees IS DISTINCT FROM e.empreinte
  UNION ALL SELECT 9, 'sorties.lignes (version 1 / version 2)', count(*) FILTER (WHERE version_methode = 1) || ' / ' || count(*) FILTER (WHERE version_methode = 2) FROM cump_sorties
  UNION ALL SELECT 10, 'lignes_livrees_sans_calcul', count(*)::text FROM order_items oi WHERE oi.stock_decremented > 0 AND NOT EXISTS (SELECT 1 FROM cump_sorties c WHERE c.order_item_id = oi.id)
  UNION ALL SELECT 11, 'journal.recalculs_24h (corrections)', count(*)::text FROM cump_recalculs WHERE cree_le > now() - interval '24 hours'
  UNION ALL SELECT 12, 'fiabilite', coalesce(string_agg(fiabilite || '=' || n, ', ' ORDER BY fiabilite), '-') FROM (SELECT fiabilite, count(*) n FROM cump_sorties GROUP BY 1) z
) t ORDER BY o;
