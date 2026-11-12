# Panier et commande : ne jamais faire perdre le panier en cas de rupture

Branche : `fix/panier-rupture-stock` (issue de `main`). **Rien n'est appliqué en production** : ni migration, ni déploiement.

## 1. Diagnostic (code en production, commit 6befb09)

Le panier est enregistré côté serveur (table `cart_items`) : il survit à un rechargement et à un changement de session. Il n'est pas « supprimé » par la validation. Ce qui oblige le client à recommencer, ce sont plusieurs défauts de conception :

1. **Le test de stock de la page utilise le stock physique, pas le disponible.** La base refuse une commande quand `quantité > physique − réservé` ; la page, elle, ne signalait une ligne que si `physique < quantité`. Quand le manque vient des réservations d'autres clients, **aucune ligne n'était marquée** : le client voyait « Ajustez les quantités » sans savoir quoi ajuster ni disposer d'un bouton.
2. **Le détail du refus passait par l'adresse, tronqué à 300 caractères.** Avec 20 à 30 références, la liste des produits concernés était coupée.
3. **Un ajustement = un clic + un rechargement complet de la page**, ligne par ligne. Aucune action groupée, aucun aperçu.
4. **Retrait silencieux** : un produit masqué du catalogue était supprimé du panier au simple affichage, le message ne disait pas lequel.
5. **Aucune protection contre le double clic** : le bouton n'était pas verrouillé ; deux envois rapprochés pouvaient créer deux commandes (le panier n'est vidé qu'après la création).
6. **Réponse perdue** : si la commande était créée puis la réponse perdue, le panier vide renvoyait silencieusement au catalogue, sans dire que la commande existait.
7. **Le vidage du panier n'était pas vérifié** : une erreur de suppression laissait le panier plein après une commande réussie, d'où un risque de doublon au clic suivant.
8. **Catalogue** : les mises à jour du panier ignoraient la réponse du serveur et les coupures réseau. Le panier affiché pouvait différer du panier enregistré (quantité réduite en silence, produit refusé).
9. **Ajout au panier plafonné au stock physique**, pas au disponible réel.
10. La page de succès affichait le contenu de **n'importe quelle commande** dont on connaissait l'identifiant.

## 2. Fonctionnement corrigé

**À chaque affichage de `/commande`**, le serveur calcule pour chaque ligne le **disponible réel** (vue `product_availability`, la même définition que la création contrôlée de la base) :

- `ok`, `stock insuffisant` (« 6 cartons demandés, 3 disponibles »), `épuisé`, ou `plus proposé` (produit masqué non autorisé pour ce client).
- Un encadré en haut de page liste **précisément** les produits concernés, avec les quantités demandée et disponible, et rappelle que **le panier est conservé** et que rien ne change sans l'accord du client.
- **Par ligne** : « Réduire à N » (quantité recalculée par le serveur) et « Retirer ce produit ».
- **« Continuer avec les produits disponibles »** : affiche d'abord un **aperçu** (« Sprite : retiré, Monster : 6 → 3… ; 22 autres produits inchangés »), puis « Confirmer les ajustements » ou « Annuler, ne rien changer ». Le plan confirmé n'est appliqué que s'il est encore **exactement** celui qui serait calculé à cet instant ; sinon l'aperçu est remontré (« la disponibilité a encore changé ») et **rien n'est appliqué**.
- Après chaque action, un message visible récapitule ce qui a été fait.
- Le bouton « Envoyer ma commande » reste grisé tant qu'il y a des produits à ajuster ; le contrôle **final** reste fait par la base, au moment de la création (verrous sur les produits, même transaction). Un refus à l'envoi ramène à la même page, panier intact, avec les lignes à ajuster recalculées (pas de retour au catalogue).

**Envoi sûr** :
- Une **clé d'envoi** par affichage de la page. La même clé ne crée **jamais deux commandes** (double clic, nouvel essai).
- Le bouton se verrouille (« Envoi en cours… ») ; en cas de coupure réseau, le navigateur **vérifie auprès du serveur** si la commande a été enregistrée avant de proposer de réessayer.
- Le panier n'est vidé **qu'après** la création confirmée, et le vidage est **vérifié**. S'il échoue, la page indique « votre commande n° … est enregistrée, ne la renvoyez pas » et propose de vider le panier.
- Panier vide à l'envoi : si une commande vient d'être enregistrée, on le dit (au lieu de renvoyer au catalogue).
- Pas de second e-mail ni de second PDF sur un doublon.

**Catalogue** : réponse du serveur prise en compte (quantité réduite au disponible, produit indisponible), trois essais en cas de coupure, message visible ; plus d'échec silencieux. Ajout au panier plafonné au disponible réel.

## 3. Migration d'idempotence — OBLIGATOIRE

 (**non appliquée**) : deux colonnes facultatives sur  (, ), un index unique partiel, une contrainte de cohérence et une fonction  qui **délègue à  sans la modifier** (même contrôle de compte actif, mêmes verrous, mêmes conflits). Aucune donnée existante n'est touchée.

Règles garanties par la base :
- **Un client ne retrouve ni ne réutilise la commande d'un autre** : une clé déjà utilisée par un autre client donne , sans aucun identifiant de commande dans la réponse.
- **Même clé, autre contenu = refus clair** () : aucune nouvelle commande, la précédente n'est pas modifiée. Le contenu est comparé par une empreinte des lignes « produit : quantité » (ordre, découpage des lignes, notes et prix n'y changent rien).
- **Même clé, même contenu = la même commande** (jamais de doublon), même pour des envois simultanés (verrou de transaction propre à la clé). Un refus pour stock ne consomme pas la clé.
- Un client identifié est exigé (). Fonction réservée au serveur du site.

**Sans la fonction, le site REFUSE l'envoi** (message « momentanément indisponible », panier conservé) : il ne retombe jamais sur une création moins sûre. D'où l'ordre de mise en ligne : **migration d'abord, code ensuite**. La migration seule est sans effet sur le code actuellement en production (colonnes et fonction inutilisées).

## 4. Tests

- 39 tests spécifiques (`panier-commande`, `panier-pages`, `orders-idempotence-migration`) sur une base locale qui embarque les **vraies fonctions SQL de la production** : un produit épuisé, plusieurs épuisés, quantité > stock, 25 références dont une seule indisponible, rupture entre l'affichage et la validation, changement entre l'aperçu et la confirmation, double clic, erreur réseau avant et après la création, panier conservé après refus, vidage uniquement après création confirmée, produit masqué, compte non actif, sans la migration.
- Concurrence **réelle** sur PostgreSQL 17 (12 connexions simultanées) : même clé × 10 = une commande ; 12 clients × 3 sur un stock de 10 = 3 commandes, jamais de sur-réservation ; commandes croisées sans interblocage.
- 16 altérations volontaires du code : 15 détectées, la 16ᵉ (droits par défaut de la fonction) est équivalente car les droits par défaut du projet ferment déjà l'accès.
- Suite complète locale : 380 tests verts ; build OK ; captures téléphone et ordinateur vérifiées.

## 5. Interactions

- **Commande rapide** et **modification d'une commande** (administrateur) : inchangées, elles utilisent toujours `createOrderChecked` / `updateOrderChecked` ; un test vérifie qu'aucun fichier administrateur ne dépend du nouveau code.
- Prix (remise négociée, groupes tarifaires), conditionnements et permissions : inchangés (les lignes de commande reprennent les mêmes instantanés qu'avant).

## 6. Risques résiduels

- Si la fonction sécurisée devient indisponible (incident de base, retrait de la migration), les clients ne peuvent plus envoyer de commande jusqu'à son retour : choix assumé (refus propre, panier conservé) plutôt qu'une création sans protection. Le retour arrière de la migration ne doit être utilisé qu'avec l'ancien code.
- Le second filet « panier identique à une commande créée il y a moins de 2 minutes » peut, dans un cas très rare, bloquer une recommande volontairement identique dans ce délai (message explicite, commande déjà enregistrée affichée).
- Le message d'ajustement transite par un cookie court (120 s) limité à 12 lignes ; au-delà, « … et N autres ».

## 7. Mise en ligne (chaque étape qui écrit en production attend un accord explicite)

1. **Sauvegarde** : confirmer la date et l'heure de la dernière sauvegarde Supabase Pro.
2. **Avant** : relever en lecture seule  (section 1 : empreintes de , , réservations, fonctions de commande, droits, déclencheurs) ; vérifier qu'aucune commande n'est en cours de création.
3. **Migration** : appliquer **uniquement**  après contrôle de son SHA-256.
4. **Après** : section 1 identique à l'avant ; section 2 entièrement à . Arrêt si la moindre différence.
5. **Déploiement du code** (fusion, push, déploiement : accords séparés). Contrôle : une commande réelle par un compte de test fourni par l'administrateur (pas de donnée fictive en production sans accord).
6. **Retour arrière** : le code ne nécessite pas de retrait de la migration ; en cas de problème applicatif, redéployer la version précédente (la migration reste inoffensive).

