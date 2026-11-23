/**
 * Script définitif de régularisation de FA/1 (supabase/regularisation/achats_fa1_cumul.sql) et son retour arrière ciblé (supabase/retours/achats_fa1_cumul_retour.sql).
 * Base locale PGlite = schéma de PRODUCTION (migrations de main + réceptions partielles) avec les VRAIS identifiants des 16 lignes de FA/1 relevés en lecture seule le 2026-11-23.
 * Aucune connexion distante, aucune écriture en production. Les scripts ne sont PAS exécutés en production par ces tests.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { un, exec } from './helpers/achatsBase';
import { SHIP, SDR, LIGNES, TRIPLE_CHOC, ACTEUR, baseFA1 } from './helpers/fa1Base';

const SCRIPT = readFileSync('supabase/regularisation/achats_fa1_cumul.sql', 'utf8');
const RETOUR = readFileSync('supabase/retours/achats_fa1_cumul_retour.sql', 'utf8');
const empreintes = async (db: PGlite) => (await un(db, `SELECT
  (SELECT md5(string_agg(concat_ws('|', id, stock_quantity, coalesce(prix_achat_moyen_ht::text, '-'), in_stock), ',' ORDER BY id)) FROM products) AS produits,
  (SELECT count(*) FROM stock_receptions) AS receptions, (SELECT count(*) FROM stock_reception_items) AS lignes,
  (SELECT count(*) FROM cump_file) AS file, (SELECT count(*) FROM cump_sorties) AS sorties, (SELECT count(*) FROM cump_recalculs) AS recalculs, (SELECT count(*) FROM orders) AS commandes`));
const lancer = async (db: PGlite, sql: string) => { try { await db.exec(sql); return ''; } catch (e: any) { try { await db.exec('ROLLBACK'); } catch {} return String(e.message); } };
const etat = async (db: PGlite) => (await un(db, `SELECT shipment_reception_etat($1) e`, [SHIP])).e;
const cumuls = async (db: PGlite) => (await exec(db, `SELECT id, received_quantity FROM shipment_items WHERE shipment_id=$1 ORDER BY id`, [SHIP])).map(r => [r.id, r.received_quantity]);

test.describe('Régularisation de FA/1 : script définitif et retour arrière ciblé', () => {
  test('le script rattache 383 cartons, laisse 207 à recevoir, ne touche ni stock, ni PUMP, ni réceptions, ni file CUMP, ni marges ; il journalise ; il ne se rejoue pas', async () => {
    const db = await baseFA1(); const avant = await empreintes(db);
    expect((await etat(db)).statut).toBe('attente');
    expect(await lancer(db, SCRIPT)).toBe('');
    expect(await etat(db)).toMatchObject({ commande: 590, recu: 383, reste: 207, cumul: 383, statut: 'partielle', solde: false });
    expect(await empreintes(db)).toEqual(avant);                                                                                  // stock, PUMP, réceptions, file CUMP, marges : identiques
    expect((await exec(db, `SELECT 1 FROM shipment_items WHERE shipment_id=$1 AND received_quantity IS NOT NULL`, [SHIP])).length).toBe(11);
    const reste = await exec(db, `SELECT i.id, i.quantity - coalesce(i.received_quantity, 0) AS reste FROM shipment_items i WHERE i.shipment_id=$1 AND i.quantity > coalesce(i.received_quantity, 0) ORDER BY 2 DESC`, [SHIP]);
    expect(reste.map(r => Number(r.reste)).sort((a, b) => b - a)).toEqual([60, 60, 40, 20, 20, 7]);                              // Banane, Café, Fraise, 2 Maxx Circus, Triple Chocolate
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action='reception.regularisation_cumul' AND target_id=$1`, [SHIP])).n).toBe(1);
    const apres = await cumuls(db);
    expect(await lancer(db, SCRIPT)).toContain('DEJA_RENSEIGNEE'); expect(await cumuls(db)).toEqual(apres);                      // rejeu refusé, rien changé
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action='reception.regularisation_cumul'`)).n).toBe(1);
  });

  test('APRÈS régularisation : la ligne soldée refuse toute nouvelle réception (pas de double entrée), les 207 restants sont réceptionnables, le stock n\'augmente que du reçu', async () => {
    const db = await baseFA1(); await db.exec(SCRIPT);
    const enr = (ligne: string, q: number) => un(db, `SELECT reception_commande_enregistrer(gen_random_uuid(),$1,CURRENT_DATE,'BL',NULL,$2::jsonb,$3,$4,$5) r`, [SHIP, JSON.stringify([{ shipment_item_id: ligne, quantity: q, unit_cost_ht: 17 }]), ...ACTEUR]);
    await expect(enr('6476f9a2-1030-4ae8-88a4-1c6f10667930', 1)).rejects.toThrow(/DEPASSEMENT_COMMANDE/);                         // Chocolat : soldée
    await expect(enr(TRIPLE_CHOC.ligne, 8)).rejects.toThrow(/DEPASSEMENT_COMMANDE/);                                              // 7 restants
    await enr(TRIPLE_CHOC.ligne, 7); await enr('f65e1d30-70c9-4ef8-82db-26bfa870106c', 60);                                       // Triple Chocolate soldée ; Banane reçue en entier
    expect((await un(db, `SELECT stock_quantity q FROM products WHERE id=$1`, [TRIPLE_CHOC.produit])).q).toBe(107);
    expect((await un(db, `SELECT stock_quantity q FROM products WHERE id='c8740f1a-5e9d-4dfa-b61c-84f2ef7e2505'`)).q).toBe(160);
    expect(await etat(db)).toMatchObject({ recu: 450, reste: 140 });
  });

  test('retour arrière ciblé : remet exactement les 11 cumuls à NULL sans toucher au reste ; refusé si une réception a été rattachée depuis, ou si un cumul a changé', async () => {
    const db = await baseFA1(); const origine = await cumuls(db); const avant = await empreintes(db);
    await db.exec(SCRIPT); expect(await lancer(db, RETOUR)).toBe('');
    expect(await cumuls(db)).toEqual(origine); expect(await empreintes(db)).toEqual(avant); expect((await etat(db)).statut).toBe('attente');
    expect(await lancer(db, RETOUR)).toContain('CUMULS_DIFFERENTS');                                                              // rien à retirer : refusé
    // une réception du nouveau parcours existe : retour arrière refusé
    await db.exec(SCRIPT);
    await un(db, `SELECT reception_commande_enregistrer(gen_random_uuid(),$1,CURRENT_DATE,'BL',NULL,$2::jsonb,$3,$4,$5) r`, [SHIP, JSON.stringify([{ shipment_item_id: TRIPLE_CHOC.ligne, quantity: 7, unit_cost_ht: 17 }]), ...ACTEUR]);
    const apres = await cumuls(db); expect(await lancer(db, RETOUR)).toContain('RECEPTION_RATTACHEE'); expect(await cumuls(db)).toEqual(apres);
  });

  test('garde-fous : migration absente, commande modifiée, lignes différentes, réception déjà rattachée, cumul déjà posé : tout est refusé et rien n\'est écrit', async () => {
    const sansMigration = await baseFA1(false); expect(await lancer(sansMigration, SCRIPT)).toContain('MIGRATION_ABSENTE');
    const a = await baseFA1(); await a.query(`UPDATE shipments SET status='arrive_port' WHERE id=$1`, [SHIP]); expect(await lancer(a, SCRIPT)).toContain('COMMANDE_INATTENDUE');
    const b = await baseFA1(); await b.query(`UPDATE shipment_items SET quantity = 21 WHERE id='610602d3-4e16-488b-9c3d-5c497226303e'`); expect(await lancer(b, SCRIPT)).toContain('LIGNES_INATTENDUES');
    const c = await baseFA1(); await c.query(`DELETE FROM shipment_items WHERE id='610602d3-4e16-488b-9c3d-5c497226303e'`); expect(await lancer(c, SCRIPT)).toContain('LIGNES_INATTENDUES');
    const d = await baseFA1(); await un(d, `SELECT reception_commande_enregistrer(gen_random_uuid(),$1,CURRENT_DATE,'BL',NULL,$2::jsonb,$3,$4,$5) r`, [SHIP, JSON.stringify([{ shipment_item_id: '610602d3-4e16-488b-9c3d-5c497226303e', quantity: 5, unit_cost_ht: 17 }]), ...ACTEUR]);
    expect(await lancer(d, SCRIPT)).toContain('DEJA_RENSEIGNEE');                                                                 // un cumul existe déjà : arrêt
    for (const db of [a, b, c]) expect((await exec(db, `SELECT 1 FROM shipment_items WHERE received_quantity IS NOT NULL`)).length).toBe(0);   // rien d'écrit après refus
    expect((await un(a, `SELECT count(*)::int n FROM admin_audit_logs WHERE action='reception.regularisation_cumul'`)).n).toBe(0);
  });

  test('une réception SDR saisie depuis le rapprochement, ou modifiée, fait REFUSER la régularisation (le rapprochement serait périmé) ; rien n\'est écrit', async () => {
    const a = await baseFA1();
    await a.query(`INSERT INTO stock_receptions (supplier_name, supplier_id, received_at, notes, stock_applied) VALUES ('SDR', $1, '2026-11-24', 'livraison FA/1 saisie entre-temps', true)`, [SDR]);
    expect(await lancer(a, SCRIPT)).toContain('NOUVELLE_RECEPTION_SDR');
    const b = await baseFA1();
    await b.query(`UPDATE stock_reception_items SET quantity = quantity + 1 WHERE id = (SELECT id FROM stock_reception_items WHERE reception_id = '74b9606f-575d-4824-b82d-eadd62040180' LIMIT 1)`);
    expect(await lancer(b, SCRIPT)).toContain('RECEPTIONS_SDR_MODIFIEES');
    for (const db of [a, b]) expect((await exec(db, `SELECT 1 FROM shipment_items WHERE received_quantity IS NOT NULL`)).length).toBe(0);
  });

  test('le script et son retour : transaction explicite, aucune écriture hors shipment_items et journal, aucune mention de stock en écriture', () => {
    for (const s of [SCRIPT, RETOUR]) {
      expect(s).toMatch(/^BEGIN;/m); expect(s).toMatch(/^COMMIT;/m);
      expect(s).not.toMatch(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+(products|stock_receptions|stock_reception_items|cump_\w+|orders|order_items)\b/i);
      expect(s.replace(/ON COMMIT DROP/g, '')).not.toMatch(/\b(DROP|TRUNCATE|ALTER)\b/i);                // seules les tables temporaires de la transaction disparaissent à sa fin
    }
  });
});
