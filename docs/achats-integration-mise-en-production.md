# Réceptions partielles — mise en production après intégration à main (addendum)

À lire AVEC `docs/achats-deploiement-coordonne.md` (procédure en étapes 0 à 7, toujours valable). Cet addendum ne liste que ce que l'intégration avec le correctif des stocks et le moteur CUMP change.
Branche d'intégration locale : `feat/achats-receptions-integration` (à partir de `main` = f9e7cdd ; branche d'origine `feat/achats-receptions-partielles` conservée). Rien n'est appliqué, poussé ni déployé.

## État de production relevé en lecture seule (2026-11-23)
- Migrations déjà appliquées : `receptions_stock_differentiel`, `cump_glissant`, `cump_methode_v2`, `cump_recalcul_automatique` (19/11). Absentes : toutes celles des réceptions partielles (aucune colonne, aucune fonction `reception_commande_*` / `shipment_*`).
- Interrupteur du recalcul CUMP : **actif** (`cump_auto_actif() = true`) ; 10 déclencheurs CUMP ; file : 51 réussies, 3 en attente (traitées par le cron de 22 h 30 UTC).
- Droits : `reception_create/update/delete` et toutes les fonctions `cump_*` exécutables par `service_role` seulement (ni `authenticated`, ni `anon`, ni PUBLIC) ; signatures identiques à celles visées par le script de gel.
- Vercel : `ACHATS_RECEPTIONS_ACTIVES` **absente** (attendu) ; `CRON_SECRET` présente en Production.
- Commandes fournisseurs : 3 ; FA/1 (cumul NULL, à régulariser), Big Brand (2 291/2 291, cohérente), ECO OI (cumul 0, aucune réception depuis sa création).

## Ce que l'intégration change dans la procédure
1. **Empreintes** : calculer les SHA-256 sur le contenu **git** (`git show <commit>:<fichier> | sha256sum`), pas sur le fichier du disque Windows (retours à la ligne CRLF). Les trois scripts sont inchangés : migration `d4109ea2…5698c`, gel `91604f61…4b0`, dégel `1283fd8a…5c7`… (valeurs complètes dans la procédure d'origine). Appliquer le contenu LF d'origine.
2. **Étape 4** : la section 7 du relevé exclut désormais les déclencheurs CUMP (déjà présents) ; attendu inchangé : 10 fonctions, 11 colonnes, 2 tables, 7 déclencheurs de la migration.
3. **Étape 5** : le déploiement contient aussi le traitement immédiat de la file CUMP après chaque réception de commande et annulation. Le cron quotidien (f9e7cdd) est déjà en production.
4. **Nouvelle étape 6b — FA/1 (avant l'activation 7a)** : rattachement du cumul sans mouvement de stock (`docs/achats-fa1-rapprochement.md`), après validation écrite des trois décisions et du rapprochement, avec relevé avant/après des stocks (identiques). **Ne pas activer tant que FA/1 n'est pas régularisée.**
5. **Étape 7c** : la première réception réelle se fait sur une commande **sans réception ancienne** (ECO OI à son arrivée), jamais sur FA/1 tant que 6b n'est pas faite. Contrôles supplémentaires en lecture seule : la file CUMP est vidée (`cump_etat_file`), aucune demande en échec, le coût (PUMP) des produits reçus = moyenne attendue.
6. **Après 7d (dégel)** : vérifier une réception libre et sa correction (stock différentiel) ; vérifier la première exécution du cron CUMP dans les journaux Vercel (200 attendu).
