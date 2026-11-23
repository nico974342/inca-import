# Commande fournisseur FA/1 (SDR) — rapprochement des réceptions existantes

**Statut : PROPOSITION. Rien n'est régularisé, aucune écriture n'a été faite en production.** Relevé en lecture seule du 2026-11-23 (base `uixmsrrprgvoejsuuaat`).
Version 2 : corrige l'erreur de la version 1 (le « reste 47 » supposait les milkshakes du 24/08 déjà reçus ; sans cette hypothèse : **590 − 383 = 207**).

## 1. Le risque

FA/1 (créée le 2026-09-09, départ fournisseur le 2026-09-08, ETA 2026-10-30, 590 cartons, statut logistique « commande ») a un cumul reçu **NULL** sur ses 16 lignes, alors qu'une partie de la marchandise
a été reçue par l'ancien parcours (réceptions libres, stock déjà compté). Après la migration, FA/1 s'afficherait « En attente, 0/590 » et le nouveau parcours accepterait de recevoir une seconde fois la
même marchandise : double entrée en stock.

## 2. Règles de rapprochement retenues (décidées par l'administrateur)
1. Les milkshakes du 24/08 ne sont **pas** rattachés automatiquement : ils ne comptent pas pour FA/1 tant qu'une preuve ne les rattache pas (§4).
2. Les 10 coconut du 16/09 sont **provisoirement une réception distincte** (note : « coconut 1ere commande »), sauf preuve contraire.
3. Les 7 « Triple Vanille » du 10/11 **ne sont pas** des Triple Chocolate, faute de justificatif de substitution par le fournisseur.
4. Seul le stock déjà appliqué (`stock_applied = true`) compte ; les réceptions historiques non appliquées (30/06, 04/09) sont ignorées. Une ligne ne peut jamais dépasser sa quantité commandée.

## 3. Solde exact de chaque référence (cartons)

| Produit | Commandé | Reçu 16/09 | Reçu 10/11 | **Reçu retenu** | **Reste à recevoir** | Reçu mais non rattaché à FA/1 |
|---|---:|---:|---:|---:|---:|---|
| Maxx Circus Melon & Gooseberry | 20 | 0 | 0 | 0 | **20** | |
| Maxx Circus Pinneberry & Guava | 20 | 0 | 0 | 0 | **20** | |
| Milkshake Banane | 60 | 0 | 0 | 0 | **60** | 60 reçus le 24/08 (règle 1) |
| Milkshake Café | 60 | 0 | 0 | 0 | **60** | 60 reçus le 24/08 (règle 1) |
| Milkshake Chocolat | 70 | 8 | 62 | 70 | 0 | |
| Milkshake Fraise | 40 | 0 | 0 | 0 | **40** | 40 reçus le 24/08 (règle 1) |
| Milkshake Vanille Extra Crémeux | 55 | 0 | 55 | 55 | 0 | |
| Barre Active Coconut | 20 | 10 | 20 | 20 | 0 | 10 reçus le 16/09 (règle 2) |
| Barre Delight Cookies & cream | 25 | 25 | 0 | 25 | 0 | |
| Barre Delight Crunchy Brownie | 35 | 35 | 0 | 35 | 0 | |
| Barre Lo Carb Stracciatella | 35 | 21 | 14 | 35 | 0 | |
| Barre Maxx Choco Mousse | 40 | 14 | 26 | 40 | 0 | |
| Barre Maxx Cookies and Cream | 40 | 3 | 37 | 40 | 0 | |
| Barre Power Dubai Chocolate | 30 | 30 | 0 | 30 | 0 | |
| Barre Power Crunchy Choco | 20 | 20 | 0 | 20 | 0 | |
| Cookie Triple Chocolate | 20 | 5 | 8 | 13 | **7** | |
| *(Cookie Triple Vanille — hors FA/1)* | — | 0 | 7 | — | — | 7 reçus le 10/11 (règle 3) |
| **Total** | **590** | 171 | 229 | **383** | **207** | 160 + 10 + 7 = 177 |

Contrôles : 590 = somme des 16 lignes ; 383 + 207 = 590 ; reste = 20 + 20 + 60 + 60 + 40 + 7 = 207 ; reçu 16/09 + 10/11 = 400 = 383 retenus + 10 coconut + 7 Triple Vanille.
**6 lignes** ont encore un reste : 2 Maxx Circus (20 + 20), 3 milkshakes Banane, Café, Fraise (60 + 60 + 40) et Triple Chocolate (7).

## 4. Les milkshakes Banane / Café / Fraise du 24/08 : éléments pour trancher

Aucun document fournisseur (facture, bon de livraison, bon de commande) n'est stocké dans la base : les fichiers de Supabase sont des bons de livraison **clients**, des images produits et une facture de juin.
La décision repose donc sur des indices, tous concordants dans le même sens (« non rattachés à FA/1 », les 160 cartons restent attendus) :

| # | Indice | Source | Ce que cela indique |
|---|---|---|---|
| 1 | La réception du 24/08 est saisie le **24/08 à 05 h 56 UTC**, FA/1 est créée le **09/09** (12 lignes, portées à 16 le même jour) | journal d'audit | la réception précède FA/1 de 16 jours |
| 2 | FA/1 a une **date de départ du 08/09** et une ETA du 30/10 | table `shipments` | une marchandise partie le 08/09 ne peut pas être reçue le 24/08 |
| 3 | Libellé : « Livraison Partiel - **21.08.26** - Milshake » ; une réception « RAL du 21.08.26 » (88 cartons, 9 produits) existe aussi, même fournisseur | `stock_receptions` | livraison partielle d'une commande **antérieure** |
| 4 | Entrées corrigées le jour même : deux saisies de départ supprimées (stock non touché) puis modification du coût de la réception conservée (total 3 936 → 2 624 €, soit 24,60 → 16,40 € le carton, déduit des totaux du journal) | journal d'audit | saisie rectifiée, pas rattachée à une commande ; coûts 16,40 contre 17,00 (Banane, Fraise) et 16,38 (Café) dans FA/1 |
| 5 | La réception du 10/11 (« MILKSHAKE + BARRES ») apporte Chocolat 62 et Vanille 55, **jamais** Banane, Café ni Fraise | `stock_reception_items` | ces 3 lignes de FA/1 n'ont pas encore été livrées |
| 6 | Stocks actuels : Banane **13**, Café **0**, Fraise **5**, contre Chocolat 42 et Vanille 42 ; aucune entrée sur ces 3 produits depuis le 24/08 | `products`, `stock_reception_items` | ils n'ont pas été réapprovisionnés (Café : 70 vendus depuis le 24/08 pour 60 entrés) |

**Ce qui reste à confirmer par un document ou un contrôle physique** (je ne peux pas le déduire de la base) :
- la facture / le bon de commande de FA/1 (et « BC/8 – Acompte FA/1 », cité le 16/09) pour savoir si les 3 milkshakes y figuraient comme une 2ᵉ commande identique ;
- les bons de livraison fournisseur du 21/08 (ou 24/08) et du 10/11 ;
- un comptage physique de Banane, Café et Fraise (pour vérifier qu'aucun carton n'est arrivé sans être saisi).

Conclusion provisoire : **ne pas rattacher** ; les 160 cartons restent « à recevoir » sur FA/1. Si la réponse documentaire était inverse (ces 160 cartons sont bien ceux de FA/1), le reste passerait à **47** et le reçu retenu à **543**.

## 5. Méthode : rattacher le CUMUL sans mouvement de stock

Testée en local (`tests/achats-fa1-regularisation.spec.ts`, base PGlite à la forme de FA/1) : **aucun mouvement de stock** ; FA/1 passe de « 0 reçu » à l'état réel ; une ligne soldée refuse tout nouvel apport
(`DEPASSEMENT_COMMANDE`) ; le reste exact est accepté ; sans le drapeau d'écriture la base refuse (`CUMUL_PROTEGE`).

Une seule transaction, après validation écrite des quantités du §3 :

```sql
BEGIN;
SELECT set_config('inca.achats_ecriture', '1', true);       -- drapeau local à la transaction : sans lui la base refuse (CUMUL_PROTEGE)
UPDATE shipment_items SET received_quantity = <reçu retenu §3> WHERE id = '<ligne>' AND shipment_id = '2f1712b0-dff2-416d-b2e1-8293061af20b';   -- 11 lignes ; les 5 autres restent NULL
INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
VALUES ('<administrateur>', 'reception.regularisation_cumul', 'shipment', '2f1712b0-dff2-416d-b2e1-8293061af20b', 'FA/1',
        '{"motif":"rattachement du cumul des réceptions saisies avant le suivi par quantités, sans mouvement de stock","receptions":["24c21a2d-3376-4555-affe-263b784f7e74","74b9606f-575d-4824-b82d-eadd62040180"],"lignes":[…]}'::jsonb);
SELECT set_config('inca.achats_ecriture', '', true);
-- contrôles AVANT validation : stock_quantity de chaque produit inchangé (relevé s4) ; shipment_reception_etat(FA/1) = reçu 383 / reste 207 / « partielle » ; ROLLBACK au moindre écart
COMMIT;
```

- Ne touche ni `products`, ni `stock_receptions`, ni `stock_reception_items` : le stock, le PUMP et le CUMP restent exactement ce qu'ils sont.
- Limite assumée : les réceptions d'origine restent « libres » ; leur traçabilité est portée par l'entrée du journal. Le rattachement ligne à ligne des réceptions est **refusé par la migration validée**
  (`RECEPTION_IMMUABLE`, même avec le drapeau) ; il exigerait une seconde migration additive, non proposée.
- Réversible : remettre `received_quantity` à NULL (même drapeau) ; aucune autre donnée n'est concernée.
- À exécuter **après** la migration et **avant** l'activation, avec un accord explicite et un relevé avant/après.

## 6. Commandes voisines (relevé lecture seule du 2026-11-23)
- **MSMU6919953 (Big Brand)** : cumul 2 291 = commandé 2 291, « Réceptionnée » ; cohérente, rien à régulariser.
- **Commande ECO OI (dédouanement)** : 1 300 cartons, cumul 0, aucune réception depuis sa création ; rien à rattacher.
