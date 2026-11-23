# Réceptions partielles — plan d'exécution DÉFINITIF (version 2)

**Statut : à autoriser étape par étape. RIEN n'est appliqué, poussé, fusionné ni déployé.** Remplace la version 1. Code à déployer : tête de la branche locale `feat/achats-receptions-integration`
(main f9e7cdd + réceptions partielles + protection de FA/1). Base : Supabase `uixmsrrprgvoejsuuaat` (PostgreSQL 17.6, rôle d'exécution `postgres`). Site : Vercel `inca-import`, production = f9e7cdd READY.

## 0. Règles non négociables
1. **Une autorisation distincte par étape sensible** (A1 à A5 ci-dessous). Un accord ne vaut jamais pour l'étape suivante.
2. **Aucune double comptabilisation du stock** : aucun script ne touche `products.stock_quantity` ; FA/1 est protégée dans le nouveau parcours tant qu'elle n'est pas rapprochée (§3, point 3).
3. **Aucun changement des marges historiques** : coûts d'origine immuables, empreintes comparées à chaque étape.
4. **CUMP et cron conservés** : aucun script ne touche aux objets `cump_*` ; `vercel.json` inchangé (cron `30 22 * * *`).
5. **Retour arrière ciblé uniquement**, sans supprimer ni modifier de commandes, de réceptions ni de stocks ; jamais de restauration globale automatique.
6. **Toute condition d'arrêt = on s'arrête et on t'informe.** Rien n'est enchaîné automatiquement.

## 1. Réponses aux quatre demandes

### 1.1 Dégel immédiat sans attendre ECO OI : **oui, c'est sûr** (prouvé, `tests/achats-mise-en-production.spec.ts`)
Le gel n'existe que pour empêcher l'ANCIEN code d'écrire un cumul que la nouvelle base refuserait. Une fois le nouveau code déployé, ce chemin n'existe plus : une réception libre ne peut ni se rattacher à une commande
ni écrire un cumul (`CUMUL_PROTEGE`, `RECEPTION_LIEE_COMMANDE`), et `create.ts` redirige tout `shipment_id` vers le nouveau parcours. Sur la base locale au schéma de production : gel → migration → tests techniques sans stock →
**dégel immédiat** → réception libre (création, correction, suppression) et commandes clients/livraisons fonctionnent, droits d'avant rétablis au caractère près. **Condition unique** : le dégel se fait APRÈS le déploiement
du nouveau code. Règle inverse : tout retour à l'ancien déploiement est précédé d'un nouveau gel (le gel se rejoue sans effet).

### 1.2 Plan de retour (§5) : chaque échec ramène à un état fonctionnel
Vérifié sur base locale : retour A (échec après migration, sans réception de commande) → **schéma, droits et données identiques à l'état d'origine** ; retour B (après de vraies réceptions) → désactivation sans rien supprimer,
réceptions, cumuls et stocks intacts, réceptions libres et commandes clients opérationnelles ; le retrait complet est REFUSÉ s'il détruirait une trace. **Droits d'origine en production** (relevé 2026-11-23) :
`reception_create / update / delete` = `{postgres=X/postgres,service_role=X/postgres}` ; le dégel (exécuté par `postgres`) restitue exactement ce texte ; je le compare caractère par caractère après l'étape A5.

### 1.3 FA/1 : **aucune régularisation urgente** (§3, point 3)
Le déploiement inclut une protection : tant que FA/1 n'a ni cumul ni réception rattachée, le nouveau parcours REFUSE toute réception pour elle (page, formulaire et bibliothèque, avant toute écriture ; message explicite).
Elle se lève d'elle-même après la régularisation et se réarme si elle est annulée. Les livraisons de FA/1 reçues d'ici là se saisissent comme avant (« Nouvelle réception » libre) ; si c'est le cas, le script de
régularisation REFUSE de s'exécuter (réception SDR nouvelle ou modifiée) et le rapprochement est à refaire : rien de faux ne peut s'écrire. 383 reçus / 207 restants, milkshakes du 24/08 exclus, restent provisoires.

### 1.4 Fenêtre courte : **≈ 15 minutes entre le gel et le dégel** (§4)
Une seule construction Vercel si la variable est posée AVANT (A1, sans effet sur le code en ligne), contrôle immédiat après chaque opération (`supabase/verifications/achats_receptions_partielles_controle_rapide.sql`, une requête).

## 2. Préalables (faits)
| Préalable | État |
|---|---|
| Sauvegarde physique Supabase du 2026-11-23 05:19 UTC ; quotidiennes précédentes ; Restore disponible | confirmée |
| SHA-256 des 3 scripts (contenu git) : migration `d4109ea23ea0536f8efa905c8524d1d0b264bbc90ee393960c2f4d30ac35698c`, gel `91604f6142965ea1d6cc3af2f0e8703939690211468896298ba019d1ff37a4b0`, dégel `1283fd8a6ee2a256cc1ce3ad15f740bedc466c1f79d775a8997a6584727665fb` | confirmés |
| Tests locaux (suite complète), build, concurrence PostgreSQL réelle (21 contrôles), séquence de fenêtre, retours A/B, protection de FA/1 | verts |
| État de production : migrations CUMP appliquées, aucune migration achats, `ACHATS_RECEPTIONS_ACTIVES` absente, `CRON_SECRET` posé, aucune activité de réception, 0 transaction ouverte, file CUMP : 0 échec / 3 en attente (cron) | relevé à 06:54 UTC |
| Droits d'origine des 3 fonctions historiques consignés (texte exact ci-dessus) | oui |
| `main` = `origin/main` = f9e7cdd ; déploiement de production f9e7cdd READY | vérifié |

## 3. Plan d'exécution — autorisations distinctes

### Avant la fenêtre (lecture seule, sans autorisation spécifique)
1. Prévenir les administrateurs : **aucune réception libre pendant ≈ 20 minutes** (avec le code actuel, une réception échoue silencieusement après le gel) ; noter tout arrivage sur papier.
2. Relevés « avant » FRAIS : `…_controle_rapide.sql`, `…_releve_empreintes.sql`, `…_releve_marges.sql` (limite = heure du relevé), `cump_etat_file()`. Production vivante : on compare ce qui est immuable.
3. `git fetch` : `main` toujours = f9e7cdd ; `git rev-parse feat/achats-receptions-integration` = commit annoncé ; SHA des 3 scripts recalculés sur le contenu git ; `vercel crons list` = 1 cron.
4. Arrêt si : activité de réception en cours, file CUMP en échec, empreinte différente.

### A1 — Variable Vercel `ACHATS_RECEPTIONS_ACTIVES=1` (Production) — *facultative, raccourcit la fenêtre*
- **Exécuté** : `echo 1 | vercel env add ACHATS_RECEPTIONS_ACTIVES production --scope nico974342s-projects` (ou tableau de bord Vercel, au choix de l'administrateur). Aucun déploiement n'est déclenché.
- **Effet immédiat : nul** (le code en ligne f9e7cdd ne lit pas cette variable). Le nouveau code démarrera « actif » dès que la migration sera appliquée.
- **Contrôle après** : `vercel env ls` montre le NOM (jamais la valeur) ; production inchangée.
- **Variante prudente** (sans A1) : activation après les tests techniques = un second déploiement (≈ +2 min de fenêtre).
- **Retour** : `vercel env rm ACHATS_RECEPTIONS_ACTIVES production --scope nico974342s-projects`.

### A2 — Gel des anciennes réceptions (SQL n° 1)
- **Exécuté** : le contenu exact de `supabase/transition/achats_gel_receptions_base.sql` (SHA ci-dessus), via `execute_sql`, une transaction, instantané ; il vérifie les droits EFFECTIFS et annule tout s'il reste un accès.
- **Avant** : relevés frais, 0 requête en cours, 0 transaction ouverte, 0 verrou.
- **Contrôle immédiat** (`controle_rapide`) : `gel_actif = true` ; ACL des 3 fonctions = `{postgres=X/postgres}` ; `historiques_ouverts_a_un_autre_role = 0` ; `autres_fonctions_critiques` toutes à `true` ; `activite` : commandes clients toujours possibles. Puis ÉTAPE 2 (1 min) : 0 requête/transaction/verrou.
- **Arrêt si** : erreur, `gel_actif = false`, droit résiduel. **Retour** : dégel (A5).

### A3 — Migration (SQL n° 2)
- **Exécuté** : le contenu exact de `supabase/migrations/achats_receptions_partielles.sql` (SHA ci-dessus, 38 658 octets, contient son propre `BEGIN … COMMIT`), via `apply_migration` (nom `achats_receptions_partielles`, comme les migrations précédentes) ; repli : `execute_sql`. En cas d'erreur : rien n'est appliqué.
- **Avant** : A2 validée, étape 2 propre.
- **Contrôle immédiat** : `controle_rapide` → `objets_migration = {fonctions 10, colonnes 11, tables 2, declencheurs 7}` ; `nouvelles_fonctions_ecriture` : `service_role = true`, `anon/authenticated/public = false` ; gel toujours actif ; **empreintes s1 à s6 identiques** à l'avant (journal et stocks expliqués par l'activité réelle) ; **marges h1 à h5 identiques** ; MSMU6919953 « intégrale » 2 291/2 291, FA/1 et ECO OI « attente ».
- **Arrêt si** : la moindre différence en s1 à s6 ou h1 à h5 → pas de déploiement, retour A (§5).

### A4 — Fusion, push, déploiement
- **Exécuté** : `git checkout main && git merge --ff-only feat/achats-receptions-integration && git push origin main` (avance rapide depuis f9e7cdd, aucune autre branche) ; construction Vercel automatique (≈ 1 min).
- **Avant** : A3 validée. **Contrôle** : déploiement READY sur le commit annoncé et alias de production ; `vercel crons list` = `/api/cron/cump` `30 22 * * *` ; aucune erreur d'exécution.
- **Tests techniques (sans mouvement de stock)** : sans session, les routes d'écriture et pages d'administration refusent ; `/admin/achats` s'affiche ; FA/1 : message de rapprochement, pas de bouton de réception ; ECO OI : bouton présent ; envoi du formulaire d'ECO OI avec toutes les quantités à 0 : refus « Saisissez au moins une quantité » (fait par l'administrateur) ; ensuite `controle_rapide` + empreintes : **aucune donnée changée**.
- **Arrêt si** : build en échec, erreur d'exécution → scénario B (§5). Aucune donnée n'est en jeu.

### A5 — Dégel (SQL n° 3) — immédiatement après A4 et ses tests, sans attendre ECO OI
- **Exécuté** : le contenu exact de `supabase/transition/achats_degel_receptions_base.sql` (SHA ci-dessus) ; il vérifie : service_role peut exécuter, ni anon, ni authenticated, ni PUBLIC, aucun autre rôle ; sinon tout est annulé et les fonctions restent gelées.
- **Contrôle immédiat** : `gel_actif = false` ; **ACL des 3 fonctions = `{postgres=X/postgres,service_role=X/postgres}` caractère pour caractère** ; empreintes de données et marges inchangées ; `cump` : 0 échec, 10 déclencheurs, interrupteur actif ; la page « Réceptions » (libres) s'affiche ; aucune erreur d'exécution Vercel pendant 5 minutes.
- **Fin de fenêtre.** La première réception réelle (ECO OI ou autre) est faite ensuite par l'administrateur ; contrôles en lecture seule à ce moment (stock exact, cumul, PUMP, demande CUMP traitée, empreintes de coûts d'origine inchangées ; saisir la VRAIE date d'arrivée).
- **Arrêt si** : `DEGEL_REFUSE` ou ACL différente → les fonctions restent gelées ; on enquête avant de continuer.

### Plus tard, hors fenêtre — **A6 — régularisation de FA/1**, seulement après validation des justificatifs et des quantités
`supabase/regularisation/achats_fa1_cumul.sql` (transaction unique, garde-fous, contrôles internes), puis `…_releve_empreintes` : stocks identiques ; protection de FA/1 levée automatiquement. Retour : `supabase/retours/achats_fa1_cumul_retour.sql`.

## 4. Chronologie visée (≈ 18 minutes au total, ≈ 15 entre gel et dégel)
| Repère | Opération | Durée |
|---|---|---|
| T−15 | relevés frais, vérifications git/Vercel, équipe prévenue (+ A1 si retenue) | 10 min, hors fenêtre |
| T+0 | **A2 gel** + contrôle rapide + étape 2 | 3 min |
| T+3 | **A3 migration** + contrôle rapide + empreintes + marges | 4 min |
| T+7 | **A4 fusion / push / déploiement** + contrôles + tests techniques | 7 min |
| T+14 | **A5 dégel** + contrôles | 3 min |
| T+17 | fin ; surveillance 5 min ; première réception réelle quand elle arrive | — |

## 5. Retour arrière CIBLÉ (aucune restauration globale automatique)
| Situation | Action | Ce qui est touché |
|---|---|---|
| A1 faite, on renonce | `vercel env rm ACHATS_RECEPTIONS_ACTIVES production --scope nico974342s-projects` | variable seule |
| Après A2, on renonce | A5 (dégel) | droits de 3 fonctions |
| **A** — échec/écart après A3, aucune réception de commande | `supabase/retours/achats_receptions_partielles_retour.sql` puis dégel | objets de la migration ; schéma, droits et données identiques à l'origine (prouvé) |
| **B** — déploiement défectueux après A4 | rétablir le déploiement précédent dans Vercel (f9e7cdd) ; **le gel reste actif** | rien (aucune donnée) |
| Après le dégel, il faut revenir à l'ancien code | **NOUVEAU gel d'abord**, puis déploiement précédent | droits |
| Réception de commande erronée | annulation motivée (parcours prévu) : stock retiré seulement s'il est disponible | stock, cumul et état de CETTE commande |
| Arrêt d'urgence du nouveau parcours après de vraies réceptions | `…_desactivation.sql` (retire l'exécution des 3 fonctions d'écriture ; rien n'est supprimé) | droits ; le retrait complet est refusé |
| Après A6 | `supabase/retours/achats_fa1_cumul_retour.sql` | 11 cumuls de FA/1 remis à vide |
| Dernier recours | restauration Supabase, décidée par l'administrateur (perdrait les commandes clients intermédiaires) | globale — jamais automatique |

## 6. Risques résiduels
- **Silence des réceptions libres pendant le gel** (≈ 15 min) avec le code en ligne : mitigé par l'information préalable et la brièveté.
- **Livraison de FA/1 reçue avant la régularisation** : saisie libre possible ; le script refuse de s'exécuter jusqu'à ce que le rapprochement soit refait ; aucune urgence, aucune double entrée possible.
- **Écart de formatage PostgreSQL local (16.4) / production (17.6)** : les contrôles de production reposent sur les comptes d'objets, les droits et les empreintes de DONNÉES, pas sur la comparaison de texte de définitions.
- **Production vivante** : toutes les comparaisons se font sur des ensembles bornés par l'heure de référence ou expliquées par l'activité réelle.
