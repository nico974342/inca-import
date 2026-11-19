# CUMP glissant — plan de déploiement progressif (mis à jour : méthode v2 et étape 4 détaillée)

Chaque étape demande l'accord explicite du responsable, une sauvegarde Supabase récente (postérieure aux dernières commandes) et un relevé « avant / après » en lecture seule
(`supabase/controles/receptions_stock_differentiel_avant_apres.sql` : stocks, réservations, commandes, lignes, réceptions, fonctions, droits).
Aucune étape ne modifie `order_items.pump_snapshot`, les prix de vente, les factures, les stocks physiques ni les réservations.

## État au 2026-11-19 (production)
- **Fait :** étape 1 (`cump_glissant.sql`, version `20261119144917`) et étape 2 (remplissage initial, 1 394 lignes, 114 produits) ; étape 3 : 0 écart face à la simulation v1, second calcul sans modification.
- **Préparé en local, non appliqué :** `cump_methode_v2.sql` (méthode v2) puis `cump_recalcul_automatique.sql` (recalcul automatique, interrupteur sur `off`).

## Étapes
| # | Étape | Fichier / action | Effet sur le site | Retour arrière |
|---|-------|------------------|-------------------|----------------|
| 4a | Méthode v2 | `supabase/migrations/cump_methode_v2.sql` : remplace 3 fonctions `cump_*`, 1 colonne et 1 vue `cump_*` | Aucun : rien ne lit ces objets | Réappliquer les définitions de `cump_glissant.sql` (voir en-tête) |
| 4b | Recalcul complet v2 | `SELECT cump_recalculer_tout('manuel')` : écrit UNIQUEMENT dans `cump_*` ; **rattrape** les opérations intervenues depuis le remplissage initial | Aucun | `DELETE FROM cump_sorties; DELETE FROM cump_etat_produit;` (le journal reste) |
| 4c | Comparaison v2 | `supabase/controles/cump_comparaison_simulation.sql` (lecture seule) : tous les `mismatch_*` à 0 ; revue produit par produit | Aucun | — |
| 4d | Migration du recalcul automatique | `supabase/migrations/cump_recalcul_automatique.sql` (interrupteur `off`) : file `cump_file`, 6 déclencheurs, fonctions de traitement | Aucun (interrupteur off : les déclencheurs ne déposent rien) | `supabase/retour/cump_recalcul_automatique_retour.sql` |
| 4e | Code | Déploiement de la branche (appel du traitement après réception / livraison) : sans effet tant que 4d n'est pas appliquée ou que l'interrupteur est `off` | Aucun | Déploiement précédent |
| 4f | **Activation** | `SELECT cump_activer_recalcul_automatique(true)` — accord séparé | Chaque réception / livraison / ajustement dépose une demande, traitée après l'opération | **`UPDATE cump_config SET valeur='off' WHERE cle='recalcul_automatique'`** (immédiat) |
| 4g | Tâche quotidienne (facultatif) | `crons` dans `vercel.json` + variable `CRON_SECRET` : balayage de sécurité | Appel quotidien de `/api/cron/cump` | Retirer l'entrée `crons` |
| 5 | Écrans de marges | Étape séparée : lire `cump_marges_lignes_suivi` (coût réalisé, fiabilité, « marge non actualisée ») | À définir | Revenir à `pump_snapshot` (jamais modifié) |
| 6 | Coût moyen courant des produits | Étape séparée, après inventaires : `products.prix_achat_moyen_ht` ← `cump_etat_produit.cump_courant` | Nouvelles commandes : coût prévisionnel = CUMP de la marchandise restante | Revenir à `recalc_pump` (inchangé) |

## Procédure d'activation (4a → 4f), contrôles à chaque étape
Avant chaque étape : vérifier l'empreinte SHA-256 du fichier, prendre le relevé « avant » (`receptions_stock_differentiel_avant_apres.sql`), vérifier qu'une sauvegarde Supabase récente existe.
Après chaque étape : relevé « après » (toutes les lignes `donnees.*` identiques ; fonctions hors `cump_*` identiques) et `supabase/controles/cump_suivi_activation.sql`.

1. **4a** : appliquer `cump_methode_v2.sql` seul. Contrôler : colonne `entrees_inconnues`, vue `cump_ajustements_classes` (anon/authenticated sans accès), fonctions `cump_*` à droits serveur seul.
2. **4b** : `SELECT cump_recalculer_tout('manuel')`. Résultat attendu (état du 19/11) : 1 394 lignes ; ≈ 1 256 fiables, ≈ 129 estimées, ≈ 9 non recalculables ; 109 produits sur 114 cohérents (écarts restants : Bum-Bum, 3 Red Bull, Sambo Tropical). Un second appel (`'auto_balayage'`) doit renvoyer `modifiees = 0`.
3. **4c** : lancer la comparaison v2 : `mismatch_*` = 0 ; marges « moteur » = « simulation » ; `lignes_non_calculees_en_version_1` = 0. Si une livraison a eu lieu entre 4b et 4c, relancer 4b d'abord.
4. **Validation du responsable** sur les marges recalculées et les cas estimés / non recalculables.
5. **4d** : appliquer `cump_recalcul_automatique.sql` seul. Contrôler : `cump_auto_actif()` = `false`, `cump_file` vide, 6 déclencheurs `trg_cump_*` actifs, objets existants inchangés (empreintes hors `cump_*` identiques).
6. **4e** : déployer le code (accord séparé). Contrôler : pages de réception et de commandes OK, journaux d'erreurs vides.
7. **4f** : sur accord, activer l'interrupteur. Contrôles : `GET /api/admin/cump/etat` ; après une opération courante, `en_attente` revient à 0 ; `echoue` = 0 ; `produits_perimes` = 0 ; journal `cump_recalculs` : seules les vraies corrections.
8. **Surveillance** (premiers jours) : `cump_suivi_activation.sql` ; en cas d'échec, lire `dernieres_erreurs`, corriger la cause puis `POST /api/admin/cump/reprendre` (reprise sans doublon + balayage).
9. **Désactivation immédiate** à tout moment : `UPDATE cump_config SET valeur = 'off' WHERE cle = 'recalcul_automatique';` — plus aucune demande n'est déposée ; les marges déjà calculées restent consultables.

## Rattrapage
Les opérations survenues entre le remplissage et l'activation sont rattrapées de deux façons indépendantes : (1) le recalcul complet 4b juste avant la comparaison ; (2) à l'activation, `cump_detecter_obsoletes()` (balayage) redépose une demande pour tout produit dont les données ont changé depuis son dernier calcul — appelé par la tâche quotidienne et par `POST /api/admin/cump/reprendre`.

## Ordre conseillé
4a → 4b → 4c → validation → 4d → 4e → 4f. Les étapes 5 et 6 ne sont pas préparées dans le code : elles feront l'objet d'une demande distincte, après inventaires.
