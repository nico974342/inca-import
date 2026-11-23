# Réceptions partielles — procédure FINALE de mise en production

**Statut : à valider. RIEN n'est appliqué, poussé, fusionné ni déployé.** Remplace l'ordre d'exécution de `docs/achats-deploiement-coordonne.md` (dont les principes et la section « Incidents » restent valables) et complète
`docs/achats-integration-mise-en-production.md`. Code à déployer : branche locale `feat/achats-receptions-integration` (main f9e7cdd + réceptions partielles). Base : Supabase `uixmsrrprgvoejsuuaat`.

## 0. Règles non négociables
1. **Une seule étape à la fois.** Chaque étape qui écrit en production attend un accord explicite, donné pour CETTE étape seulement. Un accord ne vaut pas pour la suivante.
2. **Aucune double comptabilisation du stock.** Aucun script ne touche `products.stock_quantity` en dehors des fonctions de réception ; FA/1 est régularisée AVANT l'activation et sans mouvement de stock.
3. **Aucun changement des marges historiques d'origine.** Coûts d'origine (`order_items.pump_snapshot`, `cump_sorties.cout_initial`) immuables, vérifiés par empreintes (`…_releve_marges.sql`) à chaque étape.
4. **CUMP et cron conservés.** Aucune migration ni script ne touche aux tables ou fonctions `cump_*` ; `vercel.json` (cron 22 h 30 UTC) est inchangé ; l'interrupteur du recalcul reste actif.
5. **Retour arrière CIBLÉ uniquement** (§6). Jamais de restauration globale automatique de Supabase : la sauvegarde physique n'est qu'un ultime recours, décidé par l'administrateur, car elle ferait perdre les commandes clients passées entre-temps.
6. **Condition d'arrêt = on s'arrête**, on informe, rien d'autre n'est fait.

## 1. Préalables (étape 0 — faite, lecture seule)
| Préalable | État |
|---|---|
| Sauvegarde physique Supabase du **2026-11-23 05:19 UTC** (09:19 La Réunion), sauvegardes quotidiennes précédentes présentes, Restore disponible | confirmée par l'administrateur |
| Empreintes SHA-256 des 3 scripts (contenu git) : migration `d4109ea2…5698c`, gel `91604f61…37a4b0`, dégel `1283fd8a…7665fb` (valeurs complètes dans l'addendum) | confirmées |
| Scripts de régularisation FA/1 et de retour (`supabase/regularisation/achats_fa1_cumul.sql`, `supabase/retours/achats_fa1_cumul_retour.sql`) | prêts, testés en local (5 tests) |
| Tests : 597 + 5 nouveaux ; build ; concurrence PostgreSQL réelle (21 contrôles) | verts |
| État de production relevé : migrations CUMP appliquées, aucune migration achats, `ACHATS_RECEPTIONS_ACTIVES` absente, `CRON_SECRET` posé | confirmé |
| Gel sans effet sur commandes clients, livraisons, ajustements, PUMP, CUMP | prouvé en local |
| **À refaire juste avant l'étape 1** : relevés « avant » frais (empreintes + marges), car la production est vivante | à faire |

**Durée prévue de la fenêtre d'écriture : de l'étape 1 à l'étape 6 ≈ 45 à 90 minutes.** À planifier hors des heures où les administrateurs saisissent des réceptions.

## 2. Contrôles communs (à chaque étape)
- **C-A (état)** : requête d'empreintes `supabase/verifications/achats_receptions_partielles_releve_empreintes.sql` : s1 à s6 identiques à l'« avant » (le journal `admin_audit_logs` et les stocks bougent légitimement avec l'activité réelle : écarts expliqués par les commandes et livraisons de l'intervalle, jamais par une réception).
- **C-B (marges)** : `supabase/verifications/achats_receptions_partielles_releve_marges.sql`, limite = heure du relevé « avant » : h1 à h5 **identiques** ; h6 (PUMP actuel) identique tant qu'aucune réception de commande n'est faite.
- **C-C (silence)** : section avant_1 à avant_4 : 0 requête en cours, 0 transaction ouverte, 0 verrou d'écriture, 0 écriture récente sur les réceptions et commandes fournisseurs.
- **C-D (CUMP)** : `cump_etat_file()` : 0 en échec, file en attente ≤ 3 (les 3 demandes du 20/11 attendent le cron) ; 10 déclencheurs CUMP présents ; `cump_auto_actif() = true`.
- **C-E (journaux Vercel)** : aucune erreur d'exécution nouvelle sur les routes de commande, de livraison et d'administration.

## 3. Étapes

### Étape 1 — Gel des anciennes réceptions *(SQL n° 1, autorisation requise)*
**Action** : exécuter `supabase/transition/achats_gel_receptions_base.sql` (contenu git, SHA vérifié), une transaction, instantanée. Il retire à `service_role`, `anon`, `authenticated` et PUBLIC le droit d'exécuter `reception_create`, `reception_update`, `reception_delete`, puis vérifie les droits **effectifs** et annule tout s'il reste un accès.
**Avant** : C-A, C-B, C-C, C-D en baseline ; sauvegarde confirmée ; SHA ; équipe prévenue (voir risques) ; dégel prêt à être exécuté.
**Après** : `avant_5_gel_actif = true` ; droits effectifs des 3 fonctions à `false` pour tous les rôles ; `product_adjust_stock`, `recalc_pump`, `order_create_checked`, `order_mark_livree`, `cump_*` toujours exécutables ; C-A (s1 à s5 identiques), C-B identiques ; C-E : aucune erreur sur les commandes clients pendant 5 minutes.
**Arrêt si** : erreur SQL, gel inactif, droit résiduel, écart de données.
**Retour** : dégel (`achats_degel_receptions_base.sql`, restaure exactement les droits d'avant).

### Étape 2 — Vérifier qu'aucune opération n'est en cours *(lecture seule)*
C-C à zéro ; journaux Vercel des 15 dernières minutes : aucune requête POST sur `/api/admin/reception/*`. Attendre et recontrôler si une ligne apparaît ; arrêt si l'anomalie dure plus de 10 minutes.

### Étape 3 — Migration *(SQL n° 2, autorisation requise)*
**Action** : appliquer `supabase/migrations/achats_receptions_partielles.sql` **à l'identique** (SHA vérifié, contenu LF), une transaction ; rien n'est appliqué en cas d'erreur. Aucune autre instruction.
**Avant** : étapes 1 et 2 validées ; relevé « avant » de moins de 15 minutes.
**Après (étape 4, lecture seule)** : s1 à s6 **strictement identiques** à l'avant ; s7 = 10 fonctions, 11 colonnes, 2 tables, 7 déclencheurs hors CUMP, 10 déclencheurs CUMP inchangés ; C-B identiques ; `reception_create/update/delete` toujours gelées ; le nouveau parcours est indépendant du gel ; section 3 du contrôle : MSMU6919953 « integrale » (2 291/2 291), FA/1 et ECO OI « attente ».
**Arrêt si** : la moindre différence en s1 à s6 → pas de déploiement (voir §6, scénario A).

### Étape 5 — Fusion, push et déploiement *(autorisation requise)*
**Action** : fusion de `feat/achats-receptions-integration` dans `main` (avance rapide depuis f9e7cdd), push de `main`, déploiement Vercel automatique. Aucune variable d'environnement modifiée : `ACHATS_RECEPTIONS_ACTIVES` reste absente → le site démarre à l'état « gelé ».
**Après** : déploiement « READY » sur le commit attendu ; `vercel.json` identique (cron `/api/cron/cump` à 22 h 30 UTC présent : `vercel crons list`) ; aucune erreur d'exécution ; les trois commandes s'affichent (FA/1 « attente », ECO OI « attente », MSMU « intégrale »).
**Arrêt si** : build en échec ou erreurs d'exécution → retour au déploiement précédent (§6, scénario B).

### Étape 6 — Routes et droits, sans créer de réception *(lecture seule + navigation)*
Sans session : routes d'écriture et pages refusées. Session administrateur : liste, détail et formulaire s'affichent, bandeau « réceptions suspendues », aucun bouton d'écriture ; ancienne adresse `?shipment=` renvoyée avec message. Compte commercial : aucun accès. C-A, C-B identiques (aucune réception créée).

### Étape 6b — Régularisation de FA/1 *(SQL n° 3, autorisation requise, uniquement après validation écrite du rapprochement)*
**Condition préalable** : l'administrateur valide `docs/achats-fa1-rapprochement.md` (383 reçus / 207 restants) **après** les derniers contrôles documentaires (§5, question 1). Si ces contrôles changent les quantités, le script est ajusté, retesté et son SHA recalculé AVANT toute autorisation.
**Action** : `supabase/regularisation/achats_fa1_cumul.sql`, une transaction, avec garde-fous (migration appliquée, 16 lignes d'origine inchangées, aucun cumul préexistant, aucune réception de commande sur FA/1, total 383) et **contrôles dans la transaction** (état reçu 383 / reste 207 / « partielle » ; stock et PUMP des 16 produits inchangés ; réceptions, lignes de réception et file CUMP inchangées). Au moindre écart : exception, rien n'est écrit.
**Après** : FA/1 « partiellement réceptionnée » 383/590 ; stocks (s4) et C-B identiques ; une entrée de journal `reception.regularisation_cumul`.
**Retour** : `supabase/retours/achats_fa1_cumul_retour.sql` (remet exactement les 11 cumuls à NULL ; refusé si une réception a été rattachée depuis).

### Étape 7 — Réouverture progressive *(autorisation requise à chaque sous-étape)*
- **7a.** Ajouter `ACHATS_RECEPTIONS_ACTIVES=1` (Production) et redéployer le **même** commit. État « actif ». Le gel de la base reste en place. Contrôle : la liste affiche les boutons de réception ; aucune écriture.
- **7b.** Envoi du formulaire avec toutes les quantités à 0 : refus (« Saisissez au moins une quantité »), rien d'enregistré (C-A identique).
- **7c.** Première réception **réelle** par l'administrateur, de préférence sur ECO OI à son arrivée (jamais FA/1 avant 6b). Vérifier en lecture seule : une réception rattachée à la commande ; stock = ancien + quantité exacte ; cumul de la ligne ; une entrée `reception.commande` ; PUMP du produit = moyenne attendue ; **demande CUMP déposée puis traitée** (file vidée, 0 échec) ; C-B h1 à h5 identiques (les coûts d'origine ne bougent pas). **Saisir la vraie date d'arrivée** : une réception datée avant des ventes déjà livrées peut légitimement recalculer leur coût CUMP.
- **7d.** Seulement ensuite : dégel (`achats_degel_receptions_base.sql`) pour reprendre les réceptions libres. Contrôle : une réception libre + sa correction (stock différentiel) sur un produit de test connu, ou observation d'une réception réelle.

### Étape 8 — Suivi
Premier passage du cron CUMP (22 h 30 UTC) : 200 dans les journaux Vercel, les 3 demandes du 20/11 traitées ; entrée `cump.rattrapage` au journal si des échecs existaient.

## 4. Risques et mesures
| Risque | Étape | Mesure |
|---|---|---|
| Après le gel, une réception libre échoue **sans message** avec le code actuellement en production (redirection silencieuse) ; le message « suspendues » n'arrive qu'à l'étape 5 | 1 à 5 | prévenir les administrateurs de ne saisir AUCUNE réception pendant la fenêtre ; noter les arrivées sur papier ; enchaîner 1 → 5 sans interruption |
| Réceptions libres fermées jusqu'au dégel (7d), donc jusqu'à la première réception réelle (ECO OI, arrivée prévue depuis le 06/11) | 1 à 7d | ne geler qu'au moment de la fenêtre ; si un arrivage de FA/1 survient avant 7d, le saisir après le dégel ; la date de dégel peut être avancée à après 7b **avec un accord distinct** (le nouveau code empêche déjà tout cumul direct) |
| Double entrée en stock sur FA/1 | 7 | 6b obligatoire avant 7a ; ligne soldée refusée par la base (testé) |
| Marge historique modifiée | toutes | coûts d'origine immuables en base ; empreintes h1 à h5 à chaque étape |
| Erreur de quantité dans la régularisation | 6b | garde-fous + contrôles dans la transaction ; retour ciblé |
| Écart d'empreinte après migration | 3 | arrêt ; scénario A ; aucun déploiement |
| Déploiement défectueux | 5 | retour au déploiement précédent (aucune donnée en jeu) |
| Réception saisie avec une mauvaise date | 7c | la base borne la date (jamais future, pas plus de 1 100 jours) ; la correction passe par l'annulation motivée |

## 5. Questions ouvertes avant l'étape 6b
1. **Documents fournisseur pour FA/1** : facture ou bon de commande FA/1 et « BC/8 – Acompte FA/1 », BL du 21/08 et du 10/11, comptage physique de Banane, Café et Fraise. Tant qu'ils manquent, les 160 milkshakes restent « à recevoir » (règle de l'administrateur).
2. Date de dégel (7d) : après la première réception réelle (validé) ou après 7b (à décider).

## 6. Retour arrière CIBLÉ (aucune restauration globale automatique)
| Situation | Action | Données touchées |
|---|---|---|
| Étape 1 faite, on renonce | `achats_degel_receptions_base.sql` | droits de 3 fonctions uniquement |
| **A** — Étape 3 : écart ou erreur, **aucune** réception de commande enregistrée | `supabase/retours/achats_receptions_partielles_retour.sql` (retrait complet, refuse s'il existe la moindre réception de commande) | objets de la migration uniquement ; aucune donnée d'origine |
| **B** — Étape 5 : déploiement défectueux | promotion/retour du déploiement précédent dans Vercel ; **le gel reste actif** (l'ancienne interface écrit directement le cumul, refusé par la base) | aucune donnée |
| Étape 6b : écart constaté | `supabase/retours/achats_fa1_cumul_retour.sql` | 11 cumuls de FA/1 remis à NULL |
| Étape 7 : une réception de commande est erronée | annulation motivée (parcours prévu) : stock retiré seulement s'il est encore disponible, jamais de stock recréé | stock, cumul et état de la commande concernée |
| Étape 7 : arrêt d'urgence du nouveau parcours **après** de vraies réceptions | `supabase/retours/achats_receptions_partielles_desactivation.sql` (retire le droit d'exécution des 3 fonctions d'écriture ; rien n'est supprimé) puis gel des anciennes fonctions si besoin | droits uniquement |
| Dernier recours | restauration Supabase décidée par l'administrateur (perte des commandes clients intermédiaires) | globale — jamais automatique |

Ordre de retrait si tout doit être annulé avant toute vraie réception : 6b (retour FA/1) → 7a (retirer la variable) → déploiement précédent → A (retrait de la migration) → dégel.
