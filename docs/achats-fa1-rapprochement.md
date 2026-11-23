# Commande fournisseur FA/1 (SDR) — rapprochement des réceptions existantes

**Statut : PROPOSITION. Rien n'est régularisé, aucune écriture n'a été faite en production.** Relevé en lecture seule du 2026-11-23 (base `uixmsrrprgvoejsuuaat`).

## 1. Le risque

FA/1 (créée le 2026-09-09, 590 cartons, statut logistique « commande ») a un cumul reçu **NULL** sur ses 16 lignes. Une grande partie de la marchandise a pourtant déjà été reçue par l'ancien
parcours (réceptions « libres », stock déjà compté). Après la migration, FA/1 s'afficherait « En attente de réception, 0/590 » et le nouveau parcours accepterait de **recevoir une seconde fois**
la même marchandise : double entrée en stock. Il faut donc rattacher ces réceptions à la commande **avant l'activation**, **sans** mouvement de stock.

## 2. Réceptions SDR de la base (toutes) et leur traitement

| Date | Notes | Stock appliqué | Cartons | Rôle dans le rapprochement |
|---|---|---|---|---|
| 2026-06-30 | BL2026/06/1 | non (historique) | 578 | avant la commande, stock d'ouverture : **ignorée** |
| 2026-08-21 | RAL du 21.08.26 | oui | 88 | aucun produit de FA/1 : **ignorée** |
| 2026-08-24 | Livraison Partiel - 21.08.26 - Milshake | oui | 160 | **à trancher** (voir §4, décision 1) |
| 2026-09-04 (saisie 09-09) | P3 | non (historique) | 88 | stock non appliqué : **ignorée** |
| **2026-09-16** | BC/8-Acompte FA/1 + coconut 1ere commande | oui | 171 | **FA/1** (sauf 10 coconut, décision 2) |
| **2026-11-10** | Livraison Partiel - MILKSHAKE + BARRES | oui | 229 | **FA/1** (sauf 7 Triple Vanille, décision 3) |

## 3. Rapprochement ligne par ligne (en cartons)

| Produit | Commandé | 16/09 | 10/11 | Reçu depuis la création | **Retenu** (≤ commandé) | **Reste** |
|---|---:|---:|---:|---:|---:|---:|
| Maxx Circus Melon & Gooseberry | 20 | 0 | 0 | 0 | 0 | **20** |
| Maxx Circus Pinneberry & Guava | 20 | 0 | 0 | 0 | 0 | **20** |
| Milkshake Banane | 60 | 0 | 0 | 0 *(60 le 24/08)* | 0 ou 60 | 60 ou 0 |
| Milkshake Café | 60 | 0 | 0 | 0 *(60 le 24/08)* | 0 ou 60 | 60 ou 0 |
| Milkshake Fraise | 40 | 0 | 0 | 0 *(40 le 24/08)* | 0 ou 40 | 40 ou 0 |
| Milkshake Chocolat | 70 | 8 | 62 | 70 | **70** | 0 |
| Milkshake Vanille Extra Crémeux | 55 | 0 | 55 | 55 | **55** | 0 |
| Barre Active Coconut | 20 | 10 | 20 | 30 | **20** | 0 *(10 en trop, décision 2)* |
| Barre Delight Cookies & cream | 25 | 25 | 0 | 25 | **25** | 0 |
| Barre Delight Crunchy Brownie | 35 | 35 | 0 | 35 | **35** | 0 |
| Barre Lo Carb Stracciatella | 35 | 21 | 14 | 35 | **35** | 0 |
| Barre Maxx Choco Mousse | 40 | 14 | 26 | 40 | **40** | 0 |
| Barre Maxx Cookies and Cream | 40 | 3 | 37 | 40 | **40** | 0 |
| Barre Power Dubai Chocolate | 30 | 30 | 0 | 30 | **30** | 0 |
| Barre Power Crunchy Choco | 20 | 20 | 0 | 20 | **20** | 0 |
| Cookie Triple Chocolate | 20 | 5 | 8 | 13 | **13** | **7** *(décision 3)* |
| **Total** | **590** | 171 | 229 | 393 | **383** (+160 si décision 1 = oui) | **47** (ou 207) |

Contrôles : 590 commandés = somme des 16 lignes ; 383 = 393 reçus − 10 coconut au-delà du commandé ; 47 = 40 Maxx Circus + 7 Triple Chocolate.

## 4. Trois décisions à prendre (je n'y réponds pas à votre place)

1. **Milkshakes Banane 60 / Café 60 / Fraise 40, reçus le 24/08 (avant la création de FA/1)** : mêmes quantités que les lignes de FA/1. Soit FA/1 est la commande de **cette** livraison, saisie après coup
   (alors 160 cartons sont déjà reçus : **reçu 543, reste 47**), soit c'est une commande distincte déjà livrée (alors **reçu 383, reste 207**, dont 160 milkshakes toujours attendus).
   Si vous recevez ces 160 cartons une seconde fois alors qu'ils sont déjà en stock, le stock est faux de 160. **Réponse indispensable avant toute régularisation.**
2. **Coconut : 10 cartons reçus le 16/09 (« coconut 1ere commande »)** en plus des 20 reçus le 10/11. La note indique une autre commande : on retient 20 pour FA/1 (soldée) et on ignore les 10. À confirmer.
3. **Cookie Triple Chocolate : 13 reçus sur 20**, alors que 7 « Triple Vanille » (produit absent de FA/1) ont été reçus le 10/11 (13 + 7 = 20). Erreur de produit à la saisie, ou autre produit ? Si c'est une
   erreur de saisie, la réception du 10/11 est à corriger (reception_update) **avant** de régulariser ; sinon il reste 7 Triple Chocolate à recevoir.

## 5. Méthode proposée : rattacher le CUMUL sans mouvement de stock

Testée en local (`tests/achats-fa1-regularisation.spec.ts`, base PGlite à la forme de FA/1) : **aucun mouvement de stock**, FA/1 passe de « 0 reçu » à l'état réel, une ligne soldée refuse tout nouvel
apport (`DEPASSEMENT_COMMANDE`), le reste exact est accepté.

Une seule transaction, après validation écrite des quantités retenues (§3) et du choix §4.1 :

```sql
BEGIN;
SELECT set_config('inca.achats_ecriture', '1', true);       -- drapeau local à la transaction : sans lui la base refuse (CUMUL_PROTEGE)
UPDATE shipment_items SET received_quantity = <retenu> WHERE id = '<ligne>' AND shipment_id = '2f1712b0-dff2-416d-b2e1-8293061af20b';   -- une instruction par ligne, valeurs du §3
INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
VALUES ('<administrateur>', 'reception.regularisation_cumul', 'shipment', '2f1712b0-dff2-416d-b2e1-8293061af20b', 'FA/1',
        '{"motif":"rattachement du cumul des réceptions saisies avant le suivi par quantités, sans mouvement de stock","receptions":["24c21a2d-…","74b9606f-…"],"lignes":[…]}'::jsonb);
SELECT set_config('inca.achats_ecriture', '', true);
-- contrôles AVANT validation : stock_quantity de chaque produit inchangé (comparer au relevé) ; shipment_reception_etat(FA/1) = reçu/reste attendus ; ROLLBACK au moindre écart
COMMIT;
```

- Ne touche ni `products`, ni `stock_receptions`, ni `stock_reception_items` : le stock, le PUMP et le CUMP restent exactement ce qu'ils sont.
- Limite assumée : les réceptions d'origine restent « libres » (non rattachées individuellement à la commande) ; leur traçabilité est portée par l'entrée du journal d'audit. Le rattachement ligne à ligne
  des réceptions elles-mêmes est **refusé par la migration validée** (`RECEPTION_IMMUABLE`, y compris avec le drapeau) : il exigerait une seconde migration additive, que je ne propose pas pour le moment.
- Réversible : remettre `received_quantity` à NULL (même drapeau) ; aucune autre donnée n'est concernée.
- À exécuter **après** la migration des réceptions partielles et **avant** l'activation (`ACHATS_RECEPTIONS_ACTIVES`), avec un accord explicite et un relevé avant/après.

## 6. Commandes voisines (relevé lecture seule)

- **MSMU6919953 (Big Brand)** : « Réceptionnée intégralement » (réceptionnée avant le suivi par quantités) ; cohérente, aucune régularisation.
- **Commande ECO OI (dédouanement)** : aucune réception postérieure à sa création ; rien à rattacher.
