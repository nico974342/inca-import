/**
 * Retour arrière des réceptions partielles, et configuration des tests locaux. Tout est LOCAL (PGlite en mémoire) : aucune connexion à Supabase.
 *  A) retrait complet : rend le schéma d'avant, sans toucher aux données, et REFUSE (sans rien modifier) dès qu'une vraie réception de commande existe ;
 *  B) désactivation : conserve toutes les traces et retire seulement le droit d'écriture ; réversible.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { baseAchats, MIGRATION, un, exec, produit, commande } from './helpers/achatsBase';

const RETOUR = readFileSync('supabase/retours/achats_receptions_partielles_retour.sql', 'utf8');
const DESACTIVATION = readFileSync('supabase/retours/achats_receptions_partielles_desactivation.sql', 'utf8');
const ADMIN = '11111111-1111-1111-1111-111111111111';

const as = async (db: PGlite, role: string, q: string, p: unknown[] = []) => {
  await db.exec(`SET ROLE ${role}`);
  try { return { rows: (await db.query<any>(q, p)).rows as any[], error: '' }; }
  catch (e: any) { return { rows: [] as any[], error: String(e.message ?? e) }; }
  finally { await db.exec('RESET ROLE'); }
};
const srv = (db: PGlite, q: string, p: unknown[] = []) => as(db, 'service_role', q, p);
const recevoir = (db: PGlite, s: string, ligne: string, q: number, cle = crypto.randomUUID()) =>
  srv(db, `SELECT reception_commande_enregistrer($1::uuid, $2::uuid, ((now() AT TIME ZONE 'UTC') + interval '4 hours')::date, NULL, NULL, $3::jsonb, $4::uuid, 'admin@inca.re', 'admin') AS r`,
    [cle, s, JSON.stringify([{ shipment_item_id: ligne, quantity: q, unit_cost_ht: 5 }]), ADMIN]);

// Signature du schéma touché : colonnes des 4 tables, fonctions, déclencheurs, tables d'historique.
const schema = async (db: PGlite) => ({
  colonnes: await exec(db, `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name IN ('stock_receptions', 'stock_reception_items', 'shipments', 'shipment_items') ORDER BY 1, ordinal_position`),
  fonctions: await exec(db, `SELECT p.oid::regprocedure::text s FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'reception\\_commande%' OR p.proname LIKE 'shipment\\_reception%'
    OR p.proname LIKE 'shipment\\_item%\\_modifier' OR p.proname LIKE '%\\_proteger') AND p.proname IN ('reception_commande_enregistrer', 'reception_commande_annuler', 'shipment_item_quantite_modifier', 'shipment_reception_etat',
    'shipment_reception_quantites', 'shipment_items_proteger', 'shipments_proteger', 'stock_receptions_proteger', 'stock_reception_items_proteger', 'achats_historique_proteger') ORDER BY 1`),
  declencheurs: await exec(db, `SELECT tgrelid::regclass::text t, tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text IN ('stock_receptions', 'stock_reception_items', 'shipments', 'shipment_items',
    'stock_reception_items_annulees', 'shipment_item_quantites_historique') ORDER BY 1, 2`),
  tables: await exec(db, `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1`),
  contraintes: await exec(db, `SELECT conrelid::regclass::text t, conname FROM pg_constraint WHERE conrelid::regclass::text IN ('stock_receptions', 'stock_reception_items', 'shipments', 'shipment_items') ORDER BY 1, 2`),
  index: await exec(db, `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('stock_receptions', 'stock_reception_items', 'shipments', 'shipment_items') ORDER BY 1`),
});
const donnees = async (db: PGlite) => ({
  produits: await exec(db, `SELECT id, stock_quantity, in_stock, prix_achat_moyen_ht FROM products ORDER BY id`),
  commandes: await exec(db, `SELECT id, supplier_name, reference, status FROM shipments ORDER BY id`),
  lignes: await exec(db, `SELECT id, quantity, received_quantity, unit_cost_ht FROM shipment_items ORDER BY id`),
  receptions: await exec(db, `SELECT id, supplier_name, received_at, notes, stock_applied FROM stock_receptions ORDER BY id`),
  items: await exec(db, `SELECT id, reception_id, product_id, quantity, unit_cost_ht FROM stock_reception_items ORDER BY id`),
});

test.describe('Retour arrière des réceptions partielles (base locale)', () => {
  test('A — aucune réception de commande enregistrée : le retrait complet rend EXACTEMENT le schéma d\'avant, sans toucher aux données ; rejouable', async () => {
    const db = await baseAchats(false);
    const p = await produit(db, 'Cola', 100); const c = await commande(db, [{ p, q: 100, recu: 30 }], { statut: 'en_transit' });
    expect((await srv(db, `SELECT reception_create('Fournisseur', now()::date, 'ancienne', true, $1::jsonb)`, [JSON.stringify([{ product_id: p, quantity: 30, unit_cost_ht: 4 }])])).error).toBe('');
    const schemaAvant = await schema(db); const donneesAvant = await donnees(db);
    await db.exec(MIGRATION);
    expect(await schema(db)).not.toEqual(schemaAvant);                                                    // la migration a bien ajouté des objets
    await db.exec(RETOUR);
    expect(await schema(db)).toEqual(schemaAvant);                                                        // colonnes, fonctions, déclencheurs, tables, contraintes, index : identiques à l'avant-migration
    expect(await donnees(db)).toEqual(donneesAvant);                                                      // aucune donnée touchée
    await db.exec(RETOUR);                                                                               // rejeu : aucun effet, aucune erreur
    expect(await schema(db)).toEqual(schemaAvant);
    expect(c.ids).toHaveLength(1);
    await db.close();
  });

  test('A — dès qu\'une vraie réception de commande existe : le script s\'arrête (RETOUR_REFUSE) et ne modifie RIEN', async () => {
    const db = await baseAchats(true);
    const p = await produit(db, 'Cola', 0); const c = await commande(db, [{ p, q: 100 }]);
    expect((await recevoir(db, c.s, c.ids[0], 40)).error).toBe('');
    const schemaAvant = await schema(db); const donneesAvant = await donnees(db);
    let erreur = ''; try { await db.exec(RETOUR); } catch (e: any) { erreur = String(e.message ?? e); }
    await db.exec('ROLLBACK');                                                                            // comme psql : la transaction interrompue est annulée, rien n'a été appliqué
    expect(erreur).toContain('RETOUR_REFUSE');
    expect(await schema(db)).toEqual(schemaAvant); expect(await donnees(db)).toEqual(donneesAvant);
    expect((await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s).toBe(40);       // le stock reçu est intact
    await db.close();
  });

  test('B — désactivation avec de vraies réceptions : plus aucune écriture, toutes les traces conservées et protégées, lecture disponible ; réversible', async () => {
    const db = await baseAchats(true);
    const p = await produit(db, 'Cola', 0); const c = await commande(db, [{ p, q: 100 }]);
    const r = await recevoir(db, c.s, c.ids[0], 40); expect(r.error).toBe('');
    const donneesAvant = await donnees(db); const schemaAvant = await schema(db);
    await db.exec(DESACTIVATION);
    expect((await recevoir(db, c.s, c.ids[0], 10)).error).toContain('permission denied');                  // plus de nouvelle réception
    expect((await srv(db, `SELECT reception_commande_annuler($1::uuid, 'test de retour', $2::uuid, 'admin@inca.re', 'admin')`, [r.rows[0].r.reception_id, ADMIN])).error).toContain('permission denied');
    expect((await srv(db, `SELECT shipment_item_quantite_modifier($1::uuid, 120, 'test de retour', $2::uuid, 'admin@inca.re', 'admin')`, [c.ids[0], ADMIN])).error).toContain('permission denied');
    expect((await srv(db, `SELECT shipment_reception_etat($1::uuid) e`, [c.s])).rows[0].e).toMatchObject({ statut: 'partielle', recu: 40, reste: 60 });   // la lecture reste disponible
    expect((await srv(db, `UPDATE shipment_items SET received_quantity = 0 WHERE id = $1`, [c.ids[0]])).error).toContain('CUMUL_PROTEGE');          // protections toujours actives
    expect((await srv(db, `DELETE FROM stock_receptions WHERE id = $1`, [r.rows[0].r.reception_id])).error).not.toBe('');
    expect(await donnees(db)).toEqual(donneesAvant); expect(await schema(db)).toEqual(schemaAvant);        // rien n'a été supprimé ni modifié
    await db.exec(`GRANT EXECUTE ON FUNCTION reception_commande_enregistrer(uuid, uuid, date, text, text, jsonb, uuid, text, text),
      reception_commande_annuler(uuid, text, uuid, text, text), shipment_item_quantite_modifier(uuid, integer, text, uuid, text, text) TO service_role`);
    expect((await recevoir(db, c.s, c.ids[0], 10)).error).toBe('');                                         // réactivation à l'identique
    expect((await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s).toBe(50);
    await db.close();
  });

  test('les scripts de retour vivent hors de supabase/migrations (jamais rejoués par erreur) ; transactions explicites ; aucun effacement de données', () => {
    for (const f of ['supabase/retours/achats_receptions_partielles_retour.sql', 'supabase/retours/achats_receptions_partielles_desactivation.sql']) {
      expect(existsSync(f), f).toBe(true);
      const s = readFileSync(f, 'utf8'); expect(s).toContain('BEGIN;'); expect(s).toContain('COMMIT;');
      expect(s.replace(/--.*$/gm, '')).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bUPDATE\s+\w+\s+SET\b/i);
    }
    expect(existsSync('supabase/migrations/achats_receptions_partielles_retour.sql')).toBe(false);
  });
});

test.describe('Configuration des tests locaux', () => {
  const cfg = readFileSync('playwright.local.config.ts', 'utf8');
  test('ne charge pas .env, ne lance aucun serveur, force une adresse locale et REFUSE de démarrer si l\'environnement vise une base distante', () => {
    const code = cfg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');
    expect(code).not.toMatch(/dotenv|loadEnv|['"`]\.env/);                 // aucun chargement du fichier .env (process.env.XXX reste permis : c'est la lecture de l'environnement du shell)
    expect(code).not.toMatch(/webServer/);
    expect(code).toContain("process.env.SUPABASE_URL = 'http://127.0.0.1:9'");
    expect(code).toMatch(/throw new Error\(/); expect(code).toContain("['SUPABASE_URL', 'TEST_URL']");
    for (const exclu of ['**/ecriture/**', '**/private/**', '**/e2e.spec.ts']) expect(cfg, exclu).toContain(`'${exclu}'`);
    expect(readFileSync('package.json', 'utf8')).toContain('"test:local": "playwright test -c playwright.local.config.ts"');
    expect(cfg).not.toMatch(/uixmsrrprgvoejsuuaat|eyJ[A-Za-z0-9_-]{20,}|sk_live|service_role\s*=\s*['"][A-Za-z0-9]/);   // ni référence de production, ni clé
  });
});

test.describe('Contrôles avant/après (lecture seule)', () => {
  const sql = readFileSync('supabase/verifications/achats_receptions_partielles_controle.sql', 'utf8');
  const [, empreintes, apres, etats] = sql.split(/-- ═══ \d\./).map(b => b.slice(b.indexOf('\n') + 1));
  test('le fichier de contrôle est en lecture seule ; les empreintes sont identiques avant et après la migration ; les contrôles « après » valent tous true', async () => {
    expect(sql.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
    const db = await baseAchats(false);
    const p = await produit(db, 'Cola', 100); await commande(db, [{ p, q: 100, recu: 30 }]); await commande(db, [{ p, q: 20, recu: 20 }], { statut: 'receptionne' });
    expect((await srv(db, `SELECT reception_create('Fournisseur', now()::date, 'ancienne', true, $1::jsonb)`, [JSON.stringify([{ product_id: p, quantity: 30, unit_cost_ht: 4 }])])).error).toBe('');
    const avant = await exec(db, empreintes);
    expect(avant).toHaveLength(6);
    await db.exec(MIGRATION);
    expect(await exec(db, empreintes)).toEqual(avant);                                                    // l'existant est strictement identique
    const ok = (await exec(db, apres))[0]; for (const [cle, v] of Object.entries(ok)) expect(v, cle).toBe(true);
    const e = await exec(db, etats);
    expect(e.map(x => x.statut_reception).sort()).toEqual(['integrale', 'partielle']);                    // la commande déjà réceptionnée reste intégrale
    await db.close();
  });
});

test.describe('Relevé de production avant/après (lecture seule)', () => {
  const sql = readFileSync('supabase/verifications/achats_receptions_partielles_releve.sql', 'utf8');
  const sections = sql.split(/-- ═══ \d\./).slice(1).map(b => b.slice(b.indexOf('\n') + 1));
  test('le relevé est en lecture seule ; les sections 1 à 6 sont identiques avant et après la migration ; seule la section 7 (objets de la migration) change', async () => {
    expect(sections).toHaveLength(7);
    expect(sql.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
    const db = await baseAchats(false);
    const p = await produit(db, 'Cola', 100); await commande(db, [{ p, q: 100, recu: 30 }]); await commande(db, [{ p, q: 20, recu: 20 }], { statut: 'receptionne' });
    expect((await srv(db, `SELECT reception_create('Fournisseur', now()::date, 'ancienne', true, $1::jsonb)`, [JSON.stringify([{ product_id: p, quantity: 30, unit_cost_ht: 4 }])])).error).toBe('');
    const lire = async () => { const r: any[] = []; for (const b of sections) r.push((await db.exec(b)).map(x => x.rows)); return r; };
    const avant = await lire();
    expect(avant[6][1][0]).toEqual({ fonctions: 0, colonnes: 0, tables_: 0 }); expect(avant[6][0]).toEqual([]);   // rien de la migration n'existe encore
    await db.exec(MIGRATION);
    const apres = await lire();
    for (let i = 0; i < 6; i++) expect(apres[i], `section ${i + 1}`).toEqual(avant[i]);                      // commandes, lignes, réceptions, stocks, historiques, permissions : identiques
    expect(apres[6][1][0]).toEqual({ fonctions: 10, colonnes: 11, tables_: 2 }); expect(apres[6][0]).toHaveLength(7);
    expect(avant[3][0].length).toBeGreaterThan(0); expect(avant[2][0].length).toBe(1);                       // le relevé contient bien des données
    await db.close();
  });
});

test.describe('Retour arrière — cas limites', () => {
  test('même une réception ANNULÉE (archivée) interdit le retrait complet : la trace est conservée ; et un retrait fait avant toute réception permet de ré-appliquer la migration', async () => {
    const db = await baseAchats(true);
    const p = await produit(db, 'Cola', 0); const c = await commande(db, [{ p, q: 100 }]);
    const r = await recevoir(db, c.s, c.ids[0], 40); expect(r.error).toBe('');
    expect((await srv(db, `SELECT reception_commande_annuler($1::uuid, 'erreur de saisie', $2::uuid, 'admin@inca.re', 'admin')`, [r.rows[0].r.reception_id, ADMIN])).error).toBe('');
    let erreur = ''; try { await db.exec(RETOUR); } catch (e: any) { erreur = String(e.message ?? e); }
    await db.exec('ROLLBACK');
    expect(erreur).toContain('RETOUR_REFUSE');                                                             // le stock est revenu à 0, mais l'archive et le journal restent : on ne les supprime pas
    expect((await un(db, `SELECT count(*)::int n FROM stock_reception_items_annulees`)).n).toBe(1);
    await db.close();

    const db2 = await baseAchats(true);                                                                    // aucune réception : retrait puis nouvelle application
    const p2 = await produit(db2, 'Cola', 5); await commande(db2, [{ p: p2, q: 10, recu: 4 }]);
    const avant = await donnees(db2);
    await db2.exec(RETOUR); await db2.exec(MIGRATION);
    expect(await donnees(db2)).toEqual(avant);
    await db2.close();
  });
});
