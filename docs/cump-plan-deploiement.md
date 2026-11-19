# CUMP glissant — plan de déploiement progressif

Chaque étape demande l'accord explicite du responsable, une sauvegarde Supabase récente (postérieure aux dernières commandes) et un relevé « avant / après » en lecture seule
(`supabase/controles/receptions_stock_differentiel_avant_apres.sql` : stocks, réservations, commandes, lignes, réceptions, fonctions, droits).
Aucune étape ne modifie `order_items.pump_snapshot`, les prix de vente, les factures, les stocks physiques ni les réservations.

| # | Étape | Fichier / action | Effet sur le site | Retour arrière |
|---|-------|------------------|-------------------|----------------|
| 1 | Migration additive | `supabase/migrations/cump_glissant.sql` (3 tables `cump_*`, 5 fonctions, 1 vue) | Aucun : rien ne lit ces objets | `supabase/retour/cump_glissant_retour.sql` (suspension immédiate ou suppression des seuls objets `cump_*`) |
| 2 | Remplissage initial | `SELECT cump_recalculer_tout('initial')` (écrit UNIQUEMENT dans `cump_*`) | Aucun | Vider/supprimer les tables `cump_*` (non nécessaire : elles ne sont lues par personne) |
| 3 | Comparaison et validation | `supabase/controles/cump_comparaison_simulation.sql` (lecture seule) : 0 écart face à la simulation ; revue produit par produit des marges recalculées | Aucun | — |
| 4 | Recalcul automatique | a) déploiement du code (`feat/cump-glissant`) : sans effet tant que la migration 4b n'est pas appliquée · b) migration `cump_recalcul_automatique.sql` (interrupteur sur `off`) · c) contrôle · d) `SELECT cump_activer_recalcul_automatique(true)` · e) facultatif : tâche planifiée quotidienne (`crons` dans `vercel.json` + variable `CRON_SECRET`) | b) aucun (interrupteur off) · d) les réceptions/livraisons déposent des demandes dans `cump_file`, traitées après chaque opération | `supabase/retour/cump_recalcul_automatique_retour.sql` : `UPDATE cump_config SET valeur='off'` désactive tout immédiatement |
| 5 | Basculement des écrans de marges | Étape séparée : lire `cump_marges_lignes_suivi` (coût réalisé, fiabilité, état « marge non actualisée ») au lieu de `pump_snapshot` | À définir avec le responsable | Revenir à la lecture de `pump_snapshot` (jamais modifié) |
| 6 | Coût moyen courant des produits | Étape séparée, après inventaires : `products.prix_achat_moyen_ht` ← `cump_etat_produit.cump_courant` | Nouvelles commandes : coût prévisionnel = CUMP de la marchandise restante | Revenir à `recalc_pump` (inchangé) |

## Contrôles propres à l'étape 4
- Après `b)` : relevé avant/après identique (données) ; fonctions existantes inchangées ; `SELECT cump_auto_actif()` → `false` ; `cump_file` vide.
- Après `d)` : faire une opération courante (ex. une livraison) ; `GET /api/admin/cump/etat` : `en_attente` revient à 0, `echoue` = 0 ; le journal `cump_recalculs` ne reçoit que les vraies corrections.
- Surveillance : `echoue` > 0 → lire `dernieres_erreurs`, corriger la cause, puis `POST /api/admin/cump/reprendre` (reprise sans doublon + balayage).
- Désactivation d'urgence : `UPDATE cump_config SET valeur = 'off' WHERE cle = 'recalcul_automatique';`

## Ordre conseillé
1 → 2 → 3 (validation par le responsable) → 4 → (inventaires) → 5 → 6. Les étapes 5 et 6 ne sont pas préparées dans le code : elles feront l'objet d'une demande distincte.
