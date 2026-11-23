# Suivi des achats — réceptions partielles : dossier de mise en production

État : migration **non appliquée** en production. Rien n'est poussé, fusionné ni déployé. Ce dossier décrit ce qui sera fait, comment le vérifier et comment revenir en arrière.

## 1. Empreinte de la migration

`supabase/migrations/achats_receptions_partielles.sql`

SHA-256 : `d4109ea23ea0536f8efa905c8524d1d0b264bbc90ee393960c2f4d30ac35698c`

À recalculer juste avant l'application (`sha256sum`) : toute différence interrompt la procédure.

## 2. Objets SQL créés ou modifiés (tout est additif)

**Colonnes ajoutées (11)**
- `stock_receptions` : `shipment_id`, `cle_idempotence`, `empreinte`, `bl_fournisseur`, `created_by`, `created_by_email`, `annulee_le`, `annulee_par`, `annulation_motif`.
- `stock_reception_items` : `shipment_item_id`.
- `shipments` : `statut_avant_reception`.

**Contraintes et index** : clés étrangères `shipment_id` et `shipment_item_id` (`ON DELETE RESTRICT`), contraintes `stock_receptions_commande_complete` et `stock_receptions_annulation_coherente`, index unique partiel sur `cle_idempotence`, deux index partiels de recherche.

**Tables créées (2, fermées : RLS active, aucun droit pour anon/authenticated, jamais de suppression même pour le serveur)**
- `stock_reception_items_annulees` : lignes des réceptions annulées (archive).
- `shipment_item_quantites_historique` : historique des changements de quantité commandée (motif obligatoire).

**Fonctions (10)**
- Écriture, réservées au serveur et à l'administrateur : `reception_commande_enregistrer`, `reception_commande_annuler`, `shipment_item_quantite_modifier`.
- Lecture : `shipment_reception_quantites`, `shipment_reception_etat`.
- Protection (déclencheurs) : `shipment_items_proteger`, `shipments_proteger`, `stock_receptions_proteger`, `stock_reception_items_proteger`, `achats_historique_proteger`.

**Déclencheurs (11)** : cumul des lignes, suppression d'une commande reçue, réceptions rattachées, lignes de réception, deux historiques (chacun avec sa protection contre le vidage).

**Ce qui n'est PAS touché** : aucune donnée existante, aucun prix fournisseur, aucune facture, aucune TVA, aucune fonction existante (`reception_create`, `recalc_pump`, etc.), aucune vue. Aucune table de mouvements parallèle : le stock passe par `products.stock_quantity`, les entrées par `stock_receptions` / `stock_reception_items`, comme avant.

## 3. Audit en lecture seule de la production (11 novembre 2026)

- PostgreSQL 17.6 (même version que la base locale des tests).
- Aucun des objets ci-dessus n'existe déjà : pas de conflit de nom, aucun déclencheur sur les quatre tables.
- Les dépendances existent avec la signature attendue : `recalc_pump(uuid[])`, `reception_create(text,date,text,boolean,jsonb,uuid)`, vue `product_availability`, table `admin_audit_logs`, colonnes `received_quantity`, `dlc`, `supplier_id`.
- Droits par défaut : les fonctions créées par `postgres` ne sont exécutables que par `postgres` et `service_role`. La migration ferme en plus explicitement `PUBLIC`, `anon` et `authenticated`.
- Migrations déjà appliquées en production : price_groups, products_delai_override_moq, shipments_annule_receptions_partielles, commande_fournisseur_drafts_et_idempotence, suppliers_couverture_cible, suppliers_stable_id_matching, order_update_checked_price_refresh. La base locale des tests les charge toutes.

**Données mesurées (avant)**

| Objet | Lignes | Somme | Empreinte MD5 |
|---|---|---|---|
| products | 126 | stock 4 682 | `c3068760d4a6a3b8522436d5b7a78ac0` |
| shipments | 3 | — | `d775c42e35f3e0db99076242adc5fdb9` |
| shipment_items | 44 | cumul reçu 2 291 | `2068853e07a5b8edeca138534235ab55` |
| stock_receptions | 40 | 30 avec stock appliqué | `11cecd5849aad63e6223d92469d321e1` |
| stock_reception_items | 172 | 8 702 cartons | `28a25b3a1034ef9ffb56734cb46e9fa2` |
| admin_audit_logs | 943 | — | — |

Ces empreintes sont celles du 11 novembre 2026. **À relever de nouveau juste avant l'application** (l'activité normale du site les fait évoluer) avec `supabase/verifications/achats_receptions_partielles_controle.sql`, section 1 ; la comparaison utile est « juste avant » contre « juste après ».

**Les 3 commandes existantes et leur affichage après la migration**

| Référence | Statut logistique | Lignes | Commandé | Cumul reçu | Réception affichée |
|---|---|---|---|---|---|
| MSMU6919953 | réceptionné | 21 | 2 291 | 2 291 (21 lignes soldées) | Réceptionnée intégralement (avec la mention « reçu avant le suivi réception par réception ») |
| FA/1 | commande | 16 | 590 | 0 | En attente |
| (sans référence) | dédouanement | 7 | 1 300 | 0 | En attente |

Aucune commande n'est rouverte ni modifiée. Les 40 réceptions existantes restent des réceptions historiques (non rattachées à une commande) et ne génèrent aucune entrée en stock supplémentaire.

## 3 bis. Rejeu des 3 commandes réelles et compatibilité avec l'interface actuelle

**Rejeu local fidèle** (les 44 lignes réelles relevées en lecture seule, chargées dans une base locale avec leurs réceptions, puis migration) : toutes les données restent identiques, le stock total ne bouge pas, aucun cumul n'est modifié. États calculés : MSMU6919953 « Réceptionnée intégralement » (2 291 sur 2 291, `historique: false`) ; FA/1 « En attente » (0 sur 590) ; la commande en dédouanement « En attente » (0 sur 1 300). Aucune quantité n'est déduite : le cumul est celui qui est enregistré. Pour MSMU6919953, les 21 lignes ont un cumul égal, produit par produit, aux quantités des réceptions déjà enregistrées pour son fournisseur (2 291 contre 2 291).

**Avec la migration seule (interface actuelle encore en ligne)** — rejoué avec les appels de l'ancienne interface (`tests/achats-receptions-ancienne-interface.spec.ts`) :
- inchangé : créer, corriger et supprimer une réception hors commande ; corriger l'ancienne réception ; créer, modifier et supprimer une commande non reçue ; changer son statut logistique ; ajuster le stock à la main.
- **change, volontairement** : (a) l'ancien écran « réceptionner cette commande » crée la réception (stock + quantité) mais son écriture séparée du cumul est refusée (`CUMUL_PROTEGE`) ; l'ancienne interface affiche alors son avertissement existant (« shipment_warning »). (b) l'ancien écran de modification d'une commande **déjà reçue** échoue au lieu de remettre silencieusement le cumul à zéro. Les deux commandes ouvertes (FA/1, dédouanement) restent modifiables.
- **Conséquence pratique** : entre la migration et le déploiement de la nouvelle interface, **ne pas utiliser le bouton de réception d'une commande** (la réception serait comptée en stock sans mise à jour du cumul de la commande). Les réceptions hors commande et tout le reste fonctionnent normalement. Fenêtre à garder la plus courte possible ; si une telle réception a lieu quand même, elle reste visible dans l'historique des réceptions ; le cumul de la commande ne pouvant plus s'écrire à la main, la régularisation serait une correction SQL préparée et validée avec vous au cas par cas.

## 4. Procédure de mise en production (proposée — chaque étape attend votre accord)

> **Remplacée par la procédure de déploiement coordonné : `docs/achats-deploiement-coordonne.md`** (gel des réceptions, vérification « rien en cours », migration, interface fermée par défaut, réouverture progressive). Les sections ci-dessous restent la référence pour la liste des objets, les contrôles et le retour arrière.

1. Confirmation d'une sauvegarde récente (plan Supabase Pro : sauvegarde physique ; date et heure à me communiquer).
2. Vérifier l'empreinte SHA-256 du fichier (section 1).
3. Lancer en lecture seule le **relevé** (`supabase/verifications/achats_receptions_partielles_releve.sql`, 7 sections : commandes, lignes et cumuls, réceptions, stocks, historiques, permissions, objets de la migration) et la section 1 du fichier de contrôle ; conserver les résultats « avant ».
4. Appliquer **uniquement** `achats_receptions_partielles.sql` (une transaction, durée attendue : moins d'une seconde ; les `ALTER TABLE` prennent un verrou bref sur 4 petites tables).
5. Relancer le relevé (sections 1 à 6 strictement identiques ; seule la section 7 change : 10 fonctions, 11 colonnes, 2 tables, 7 déclencheurs) et la section 1 du contrôle (identique au 3), puis la section 2 (tout à `true`) et la section 3 (états des 3 commandes comme dans le tableau ci-dessus).
6. Contrôle de non-régression en lecture seule : stock total, nombre de lignes et empreintes inchangés.
7. **Seulement ensuite**, et sur votre accord distinct : fusion, push et déploiement de l'interface. Tant que l'interface n'est pas déployée, la migration est sans effet visible (colonnes et fonctions inutilisées).
8. Première réception réelle : effectuée par vous sur une commande réelle (pas de donnée fictive en production). Vérification en lecture seule : stock +quantité exacte, cumul, une ligne de journal « reception.commande ».

## 5. Retour arrière

Deux procédures, selon qu'une vraie réception de commande a déjà été enregistrée. Aucune n'est appliquée sans votre accord.

- **A — retrait complet** : `supabase/retours/achats_receptions_partielles_retour.sql`. Utilisable **uniquement** tant qu'aucune réception rattachée à une commande, annulation ou changement de quantité n'existe. Dans le cas contraire le script s'arrête (`RETOUR_REFUSE`) sans rien modifier. Testé : le schéma redevient identique à l'avant-migration, les données sont inchangées, le script est rejouable.
- **B — désactivation** : `supabase/retours/achats_receptions_partielles_desactivation.sql`. À utiliser dès qu'une vraie réception existe. Ne supprime rien ; retire le droit d'exécuter les trois fonctions d'écriture. Les protections restent actives, les quantités et l'historique restent consultables. Réversible par un `GRANT` (fourni en commentaire). Testé.

Si de vraies réceptions existent, le stock a déjà été mis à jour : on ne « défait » pas la migration, on désactive et on corrige en avant. Redéployer l'ancienne interface n'est pas recommandé dans ce cas : elle écrivait directement le cumul des lignes, ce que les déclencheurs refusent désormais pour toute ligne concernée.

## 6. Annulation d'une réception quand le stock a déjà été vendu ou réservé

Règle appliquée par `reception_commande_annuler` (administrateur uniquement, motif obligatoire) :

1. La base verrouille la commande, la réception, les lignes de commande puis les produits concernés (dans cet ordre, pour éviter tout interblocage avec une réception simultanée).
2. Pour **chaque produit** de la réception, elle compare la quantité à retirer avec le **disponible** du produit (`product_availability.available` = stock physique − stock réservé par les commandes clients).
3. **Si le disponible est inférieur à la quantité à retirer, l'annulation est refusée** (`STOCK_DEJA_ENGAGE`, avec le détail) : rien n'est modifié, ni stock, ni cumul, ni statut, ni journal. L'écran l'explique : « une partie de cette marchandise a déjà été vendue, réservée ou déplacée ».
4. Sinon, dans une seule transaction : les lignes sont archivées puis retirées de la réception active, la réception est marquée annulée (auteur, date, motif), le cumul des lignes de commande diminue, le stock diminue de la quantité exacte, le PUMP est recalculé, le statut logistique « réceptionné » est restauré à sa valeur d'avant si la commande n'est plus soldée, et le journal reçoit « reception.annulation ».

Il n'y a **jamais de régularisation partielle ni de stock négatif**. Limite à connaître : le stock est comparé par produit, pas par lot (le système ne suit pas de lot par réception). S'il reste assez de stock d'une autre origine, l'annulation est acceptée, et le disponible reste positif. Quand une réception ne peut pas être annulée parce que la marchandise est partie, le traitement est une décision de gestion : ajuster le stock par l'écran d'ajustement habituel, avec son propre motif et son journal, sans toucher à la réception d'origine.

Les réceptions historiques (non rattachées à une commande) ne passent pas par cette fonction ; elles gardent leur correction existante.

## 7. Risques résiduels

- Une réception de commande met toujours le stock à jour (pas de réception « historique » rattachée à une commande).
- Une commande déjà reçue ne se supprime plus et ses lignes ne se recréent plus depuis l'écran de modification ; ajouter un produit à une commande déjà reçue n'est plus possible.
- Les commandes closes avant le suivi par quantités sont « intégrales historiques » : consultables, jamais rouvertes, non réceptionnables.
- Les tests de concurrence réelle (PostgreSQL 17, 12 connexions simultanées) ont tourné sur une base locale, pas sur Supabase : le comportement des verrous est celui de PostgreSQL, mais la charge réelle de production n'a pas été simulée.
- Une migration de production reste une opération humaine : sauvegarde confirmée et accord explicite requis.
- **Évolution reportée** : clôture administrative d'un reliquat non livré (motif et historique, sans mouvement de stock), validée en principe, volontairement séparée de cette mise en production.
