# Réceptions partielles — déploiement coordonné (procédure)

État : **rien n'est appliqué en production**. Aucune étape ci-dessous n'est exécutée sans votre accord explicite, étape par étape. Chaque étape qui écrit en production (SQL, push, fusion, déploiement, variable d'environnement) est une **porte** : on s'arrête, on présente le résultat de la porte précédente, vous autorisez la suivante.

Objectif : aucune période pendant laquelle une opération pourrait fausser les stocks.

## 1. Principe : deux verrous indépendants, plus la base qui se défend seule

1. **Gel au niveau de la base** (`supabase/transition/achats_gel_receptions_base.sql`) : retire à `service_role` le droit d'exécuter `reception_create`, `reception_update`, `reception_delete`. Effet immédiat, quel que soit le code qui appelle : ancienne version du site, onglet resté ouvert, autre route. La base répond « permission denied » et n'écrit rien. Réversible (`achats_degel_receptions_base.sql`). Ne touche à aucune donnée.
2. **Interrupteur côté serveur du site** (`src/lib/achatsTransition.ts`) : à chaque requête d'écriture, le serveur calcule l'état. Les réceptions par commande, les corrections de commandes et la modification des commandes existantes ne sont autorisées que dans l'état **actif**. L'état ne dépend ni de l'URL, ni d'un cookie, ni d'un champ de formulaire : seulement de la base (la migration est-elle appliquée ?) et d'un drapeau d'environnement du serveur.

| État | Condition | Réceptions par commande, corrections, modification de commande | Réceptions libres (hors commande) |
|---|---|---|---|
| `migration_absente` | fonction `shipment_reception_etat` introuvable | refusé | permis (rien n'a changé pour elles) |
| `inconnu` | base injoignable ou droits refusés lors de la vérification | refusé | refusé |
| `gele` | migration appliquée, drapeau absent | refusé | refusé |
| `actif` | migration appliquée **et** `ACHATS_RECEPTIONS_ACTIVES=1` | permis | permis |

La création d'une **nouvelle** commande reste possible dans tous les états (aucune réception n'y est liée). Le changement de statut logistique et la suppression d'une commande existante suivent l'état de la table (refusés hors `actif`).

3. **La base se défend seule** (migration elle-même) : même si un ancien code atteignait la base, l'écriture à la main du cumul (`CUMUL_PROTEGE`), la suppression d'une ligne reçue (`LIGNE_RECUE_NON_SUPPRIMABLE`) et celle d'une commande reçue sont refusées.

## 2. Pourquoi cet ordre

Le code actuellement en production ne peut pas être modifié sans déploiement : avant le déploiement, **seule la base** peut bloquer l'ancienne interface. D'où le gel de la base en premier, puis la migration, puis le déploiement du nouveau code (qui arrive fermé : drapeau absent), puis les tests, puis la réouverture.

Variante possible (à votre choix) : déployer le nouveau code **avant** la migration. Il est sûr dans l'état `migration_absente` (réceptions par commande et corrections refusées, réceptions libres permises) et supprime toute fenêtre où l'ancien code est en ligne avec une base migrée. Le gel de la base reste utile pour la vérification « rien en cours ».

## 3. Déroulement

Chaque étape indique son **point de contrôle** et sa **condition d'arrêt**. Une condition d'arrêt atteinte = on s'arrête, on vous informe, rien d'autre n'est fait.

**Étape 0 — Préparation (aucun effet en production)**
- Vous confirmez la dernière sauvegarde Supabase Pro (date et heure).
- Je relève en lecture seule : le relevé complet (`supabase/verifications/achats_receptions_partielles_releve.sql`, 7 sections) et la section 1 du contrôle ; je recalcule le SHA-256 de la migration et le compare à `d4109ea23ea0536f8efa905c8524d1d0b264bbc90ee393960c2f4d30ac35698c`.
- Je vérifie dans Vercel que la variable `ACHATS_RECEPTIONS_ACTIVES` **n'existe pas**.
- Arrêt si : empreinte différente, variable déjà présente, branche non propre, tests en échec.

**Étape 1 — Gel des réceptions (SQL n° 1, autorisation requise)**
- Exécuter `achats_gel_receptions_base.sql` (instantané).
- Contrôle : section 5 de `achats_receptions_partielles_avant_migration.sql` = `gel_actif: true`.
- Arrêt si : erreur SQL, `gel_actif` à `false`.

**Étape 2 — Vérifier qu'aucune opération n'est en cours**
- Lecture seule : sections 1 à 4 de `achats_receptions_partielles_avant_migration.sql` (requêtes en cours, transactions ouvertes, verrous d'écriture, écritures des 15 dernières minutes) : **zéro ligne, zéro compteur**.
- Journaux d'exécution Vercel des 15 dernières minutes : aucune requête POST sur `/api/admin/reception/*` ni sur `/admin/achats*`.
- Si une ligne apparaît : attendre quelques minutes (les transactions en cours se terminent) et relancer. Arrêt si l'anomalie persiste plus de 10 minutes : on enquête avant de continuer.

**Étape 3 — Migration (SQL n° 2, autorisation requise, uniquement `achats_receptions_partielles.sql`)**
- Application du fichier à l'identique (une transaction : en cas d'erreur, rien n'est appliqué).
- Le schéma de l'API peut mettre quelques secondes à reconnaître les nouvelles fonctions ; le site relit l'état toutes les 3 secondes tant qu'il n'est pas « migration appliquée ».
- Arrêt si : erreur (voir scénario A).

**Étape 4 — Vérification immédiate, lecture seule**
- Relevé complet : sections 1 à 6 **strictement identiques** à celles de l'étape 0 ; section 7 : 10 fonctions, 11 colonnes, 2 tables, 7 déclencheurs.
- Contrôle (`achats_receptions_partielles_controle.sql`) : section 1 identique, section 2 entièrement à `true`, section 3 : MSMU6919953 « integrale » (2 291 / 2 291), FA/1 et la commande en dédouanement « attente ».
- Contrôle section 5 de `…_avant_migration.sql` : le gel est toujours actif.
- Arrêt si : la moindre différence sur les sections 1 à 6. Aucun déploiement. Voir scénario A.

**Étape 5 — Déploiement du nouveau code (autorisation requise : fusion, push, déploiement)**
- Le drapeau est absent : le site démarre à l'état `gele`.
- Contrôles : déploiement « Ready » ; aucune erreur dans les journaux d'exécution ; les trois commandes s'affichent.
- Arrêt si : build en échec, erreurs d'exécution. Voir scénario B.

**Étape 6 — Tester les routes et les droits sans créer de réception**
- Sans session : les pages d'administration et les routes d'écriture renvoient à la connexion ou refusent (aucune donnée).
- Avec votre session administrateur : la liste, le détail et le formulaire s'affichent ; le bandeau « suspendues » apparaît ; aucun bouton d'écriture ; l'ancienne adresse `/admin/reception/new?shipment=…` renvoie vers le détail avec le message. Un compte commercial n'a accès à aucune de ces pages.
- Aucune réception n'est créée pendant ces tests. Vérification en lecture seule : nombre de réceptions, cumuls et stock identiques à l'étape 4.

**Étape 7 — Réouverture progressive (autorisation requise à chaque sous-étape)**
- **7a.** Ajouter `ACHATS_RECEPTIONS_ACTIVES=1` dans Vercel (Production) et redéployer. L'état passe à `actif`. Le gel de la base reste en place : les anciennes fonctions restent fermées.
- **7b.** Test sans réception : sur une commande, envoyer le formulaire avec toutes les quantités à 0 : la base refuse (« Saisissez au moins une quantité »), rien n'est enregistré. Vérification en lecture seule : aucune ligne nouvelle.
- **7c.** Première réception **réelle**, faite par vous, sur une vraie livraison. Vérification en lecture seule : une réception rattachée à la commande, stock + quantité exacte, cumul de la ligne, une ligne de journal « reception.commande », ni doublon ni modification ailleurs.
- **7d.** Seulement ensuite : exécuter `achats_degel_receptions_base.sql` (SQL n° 3) pour reprendre les réceptions libres.
- Arrêt à n'importe quelle sous-étape si : écart de stock, erreur inattendue, résultat différent de l'attendu → gel immédiat (voir « Frein d'urgence »).

## 4. Incidents

**A — La migration échoue, avant toute nouvelle réception**
- La migration est une transaction unique : une erreur laisse la base à l'état précédent. Contrôle : section 7 du relevé = tout à 0, sections 1 à 6 identiques.
- Si l'état est douteux ou partiel : procédure testée `supabase/retours/achats_receptions_partielles_retour.sql` (retrait complet). Elle **refuse de s'exécuter** (`RETOUR_REFUSE`) si une réception rattachée à une commande, une annulation ou un changement de quantité existe : aucun retour arrière ne peut donc supprimer une vraie réception.
- Le gel de la base reste actif pendant l'analyse. Dégel (`achats_degel_receptions_base.sql`) seulement quand l'état est confirmé conforme.
- Aucun retour arrière automatique : chaque script est lancé à la main, après votre accord.

**B — La migration réussit mais le déploiement applicatif échoue**
- Les données sont conservées. Le gel de la base reste actif : l'ancien code ne peut écrire aucune réception, et les protections de la migration refusent toute écriture à la main du cumul.
- On corrige ou on restaure la version précédente du site (retour instantané Vercel) : elle fonctionne en lecture ; ses écritures de réception sont refusées par le gel ; la modification d'une commande déjà reçue y est refusée par la base.
- **Règle absolue : tout retour à une version antérieure du site (retour instantané Vercel) est précédé d'un NOUVEAU GEL de la base** si le dégel a déjà eu lieu. L'ancien code ne doit jamais tourner sur une base dégelée.
- On ne dégèle qu'une fois le bon code en ligne et vérifié (étapes 5 à 7). Rien n'est supprimé.

**Frein d'urgence (à tout moment, instantané, sans redéploiement)**
- Nouvelles réceptions, annulations, changements de quantité : `supabase/retours/achats_receptions_partielles_desactivation.sql` (retire l'exécution des trois fonctions d'écriture, réversible, ne supprime rien).
- Anciennes réceptions : `achats_gel_receptions_base.sql`.
- Côté site : retirer `ACHATS_RECEPTIONS_ACTIVES` et redéployer ramène l'état à `gele`.

## 5. Protection contre une ancienne page restée ouverte

| Ancienne page | Ce qui se passe maintenant |
|---|---|
| Ancien formulaire « Réceptionner cette commande » (`product_id[]`, `shipment_id`) | Le serveur détourne la requête vers le nouveau parcours **avant tout accès aux données** ; rien n'est écrit. Si elle atteint le nouveau gestionnaire, elle est refusée (« Formulaire incomplet ») sans appeler la base. |
| Ancienne page de modification d'une commande déjà reçue | Les lignes ne sont jamais recréées (cumul préservé) ; hors état `actif`, la requête est refusée avant tout traitement ; la base refuse de toute façon la suppression d'une ligne reçue. |
| Ancienne page de réception libre, avec le gel | La base refuse (`permission denied`) ; le site affiche « réceptions suspendues », rien n'est enregistré. |
| Ancien changement de statut ou suppression d'une commande | Refusé par le serveur hors état `actif` ; suppression d'une commande reçue refusée par la base. |

Tout cela est vérifié par des tests locaux (`tests/achats-transition.spec.ts`, `tests/achats-receptions-ancienne-interface.spec.ts`) et par 9 altérations volontaires du code, toutes détectées.

## 6. Contrôles conservés avant et après

Commandes et lignes, quantités commandées et reçues, stocks (physique, réservé, disponible), prix d'achat moyen, réceptions et leurs lignes, journal, permissions des tables et des fonctions, et empreintes des fonctions existantes (`recalc_pump`, `reception_*`, `product_adjust_stock`, vue `product_availability`) : `achats_receptions_partielles_releve.sql`. Modules non concernés (commandes clients, CRM, BL, TVA, facturation) : aucune de leurs tables ni fonctions n'est touchée ; les empreintes des fonctions et les permissions (sections 5 et 6) le confirment, et les tests des autres modules sont inclus dans la suite locale.

## 7. Conditions de reprise du service

Réouverture complète seulement si : relevé identique (étape 4) ; étape 6 conforme ; 7b sans enregistrement ; 7c conforme (stock, cumul, journal) ; aucune erreur dans les journaux d'exécution depuis le déploiement. Le dégel des anciennes fonctions (7d) vient en dernier.

## 8. Risques résiduels

- Entre le gel et le dégel, les réceptions libres (hors commande) sont suspendues : durée à garder courte (de l'étape 1 à 7d).
- Le gel et l'interrupteur côté site sont deux mécanismes manuels : un oubli de dégel laisse les réceptions libres fermées (le site l'indique par « réceptions suspendues »).
- L'activation passe par une variable d'environnement Vercel et un redéploiement (1 à 2 minutes) ; le retour instantané, lui, se fait dans la base.
- L'état est mis en mémoire jusqu'à 30 secondes dans une instance du site : un retour arrière du côté base peut mettre jusqu'à 30 secondes à être vu par les pages (mais la base, elle, refuse immédiatement).
- Les tests de concurrence ont été faits sur un PostgreSQL local, pas sur Supabase.
- Une réception faite entre la migration et l'étape 7 par un autre chemin que ceux décrits n'est pas possible : le gel et le serveur la refusent.

## 9. Vérifications complémentaires (code réellement déployé, droits effectifs, transition réelle)

- **Code en production** : déploiement Vercel « Ready » du commit `6befb09` (branche main). Ses seuls chemins qui écrivent une réception sont `reception_create`, `reception_update` et `reception_delete` ; le cumul n'est écrit qu'**après** un `reception_create` réussi, et la route redirige immédiatement si cet appel échoue. Avec le gel, la base refuse l'appel avant d'exécuter la moindre instruction : ni stock, ni réception, ni PUMP, ni cumul, ni statut. Les autres écritures de stock du code déployé (ajustement manuel de stock, commandes clients, produits) ne sont **pas** des parcours de réception : elles continuent, par conception.
- **Droits effectifs en production (lecture seule)** : les trois fonctions ont pour seule ACL `postgres` (propriétaire) et `service_role` ; aucun droit hérité de PUBLIC ; aucun autre rôle (hors super-utilisateurs) ne peut les exécuter.
- **Scripts auto-vérifiés** : le gel contrôle les droits **effectifs** (PUBLIC, rôle hérité) et s'annule avec `GEL_INEFFICACE` si un autre rôle peut encore exécuter ; le dégel ne rend que `service_role`, et s'annule avec `DEGEL_REFUSE` si un autre rôle a un droit inattendu. Testés, y compris dans les cas défavorables (fonction ouverte à PUBLIC, droit hérité).
- **Transition réelle** (PostgreSQL 17, 3 connexions, rôles réels) : le gel se pose en 13 ms malgré une opération en cours ; le contrôle « rien en cours » la détecte (transaction ouverte, verrous) ; la migration lancée à ce moment est refusée par le verrou et ne laisse rien ; l'opération se termine une seule fois ; la migration passe ensuite ; la nouvelle opération atomique fonctionne pendant que les anciennes sont gelées ; après le dégel, une réception libre fonctionne, et la réception de commande ne peut être ni corrigée ni supprimée par les anciennes fonctions, ni son cumul écrit à la main.
- **Instances du site** : le gel, les protections de la migration et les refus de la base valent pour toutes les instances (ils sont dans la base). La garde applicative est calculée à chaque requête ; sa mémoire (30 s au plus) est propre à chaque instance et ne peut pas rouvrir ce que la base refuse. Le drapeau appartient à un déploiement : tant qu'un déploiement fermé est actif, toutes ses instances sont fermées.
- **Anciennes adresses de déploiement** : la protection Vercel du projet (`all_except_custom_domains`) exige une connexion Vercel pour ouvrir les anciennes adresses de déploiement ; seul un membre de l'équipe, connecté **et** administrateur du site, pourrait y atteindre l'ancien code. Risque résiduel faible ; mitigation : ne jamais utiliser ces adresses, et regeler avant tout retour à une ancienne version.
