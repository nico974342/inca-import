/**
 * Migration orders_idempotence_cle.sql (NON appliquée en production) : additive, ne modifie ni les commandes existantes ni order_create_checked, et garantit
 * qu'une même clé d'envoi ne crée jamais deux commandes. Base locale (PGlite) avec les vraies fonctions de la production. Aucune connexion à Supabase.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { basePanier, nouveauClient, produitStock, MIGRATION_IDEMPOTENCE } from './helpers/panierBase';
import { exec, un } from './helpers/panierBaseCommun';

const as = async (db: PGlite, role: string, q: string, p: unknown[] = []) => {
  await db.exec(`SET ROLE ${role}`);
  try { return { rows: (await db.query<any>(q, p)).rows as any[], error: '' }; }
  catch (e: any) { return { rows: [] as any[], error: String(e.message ?? e) }; }
  finally { await db.exec('RESET ROLE'); }
};
const srv = (db: PGlite, q: string, p: unknown[] = []) => as(db, 'service_role', q, p);
const items = (p: string, q: number) => JSON.stringify([{ product_id: p, product_name: 'P', quantity: q, unit: null, price_ht_snapshot: 5, tva_rate_snapshot: 0.085, pump_snapshot: null }]);
const entete = (c: { id: string; email: string }) => JSON.stringify({ user_id: c.id, nom: 'N', societe: '', telephone: '', email: c.email, notes: null });
const idem = (db: PGlite, k: string | null, c: { id: string; email: string }, p: string, q: number) => srv(db, `SELECT * FROM order_create_idempotent($1::uuid, $2::jsonb, $3::jsonb)`, [k, entete(c), items(p, q)]);

test.describe('Migration d\'idempotence des commandes (base locale)', () => {
  test('additive : les commandes existantes, leurs lignes et order_create_checked sont strictement identiques ; rejouable', async () => {
    const db = await basePanier(false);
    const c = await nouveauClient(db, 1), c2 = await nouveauClient(db, 2); const A = await produitStock(db, 'A', 100), B = await produitStock(db, 'B', 100);
    for (const [cl, p, q] of [[c, A, 3], [c2, B, 5], [c, B, 2]] as const) expect((await srv(db, `SELECT * FROM order_create_checked($1::jsonb, $2::jsonb)`, [entete(cl), items(p, q)])).error).toBe('');
    const photo = async () => ({
      commandes: await exec(db, `SELECT id, user_id, nom, email, status, notes, created_at FROM orders ORDER BY id`),
      lignes: await exec(db, `SELECT id, order_id, product_id, quantity, price_ht_snapshot, tva_rate_snapshot FROM order_items ORDER BY id`),
      fonction: (await un(db, `SELECT md5(pg_get_functiondef('order_create_checked(jsonb, jsonb)'::regprocedure)) m`)).m,
      stock: await exec(db, `SELECT product_id, available FROM product_availability ORDER BY product_id`),
    });
    const avant = await photo();
    await db.exec(MIGRATION_IDEMPOTENCE); expect(await photo()).toEqual(avant);
    await db.exec(MIGRATION_IDEMPOTENCE); expect(await photo()).toEqual(avant);                            // rejeu : aucun effet
    expect((await exec(db, `SELECT cle_commande FROM orders`)).every(r => r.cle_commande === null)).toBe(true);   // aucune commande existante n'a de clé
    await db.close();
  });

  test('fermeture : réservée au serveur (service_role), jamais à anon, authenticated ni PUBLIC ; invoker, chemin de recherche figé', async () => {
    const db = await basePanier(true); const c = await nouveauClient(db, 1); const A = await produitStock(db, 'A', 10);
    const f = await un(db, `SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'order_create_idempotent'`);
    expect(f.prosecdef).toBe(false); expect(JSON.stringify(f.proconfig)).toContain('search_path=public, pg_temp');
    for (const r of ['anon', 'authenticated']) expect((await as(db, r, `SELECT * FROM order_create_idempotent(gen_random_uuid(), '{}'::jsonb, '[]'::jsonb)`)).error).toContain('permission denied');
    expect((await un(db, `SELECT has_function_privilege('service_role', 'order_create_idempotent(uuid, jsonb, jsonb)', 'EXECUTE') a`)).a).toBe(true);
    expect((await idem(db, crypto.randomUUID(), c, A, 1)).error).toBe('');
    await db.close();
  });

  test('sonde SANS EFFET : sans clé, la fonction s\'arrête (CLE_REQUISE) avant toute lecture ou écriture', async () => {
    const db = await basePanier(true); const c = await nouveauClient(db, 1); const A = await produitStock(db, 'A', 10);
    const avant = (await un(db, `SELECT count(*)::int n FROM orders`)).n;
    expect((await idem(db, null, c, A, 1)).error).toContain('CLE_REQUISE');
    expect((await srv(db, `SELECT * FROM order_create_idempotent(NULL, '{}'::jsonb, '[]'::jsonb)`)).error).toContain('CLE_REQUISE');
    expect((await un(db, `SELECT count(*)::int n FROM orders`)).n).toBe(avant);
    await db.close();
  });

  test('la MÊME clé ne crée jamais deux commandes ; un autre client ne peut pas la réutiliser ; un refus de stock ne consomme pas la clé', async () => {
    const db = await basePanier(true); const c = await nouveauClient(db, 1), autre = await nouveauClient(db, 2);
    const A = await produitStock(db, 'A', 10); const k = crypto.randomUUID();
    const r1 = await idem(db, k, c, A, 4); expect(r1.error).toBe(''); expect(r1.rows[0].r_deja).toBe(false);
    const r2 = await idem(db, k, c, A, 4); expect(r2.rows[0]).toMatchObject({ r_order_id: r1.rows[0].r_order_id, r_deja: true });
    const r3 = await idem(db, k, c, A, 9); expect(r3.rows[0]).toMatchObject({ r_order_id: r1.rows[0].r_order_id, r_deja: true });   // même clé, même commande, même si le panier a changé
    expect((await un(db, `SELECT count(*)::int n FROM orders WHERE user_id = $1`, [c.id])).n).toBe(1);
    expect((await un(db, `SELECT available FROM product_availability WHERE product_id = $1`, [A])).available).toBe(6);       // 4 réservés une seule fois
    expect((await idem(db, k, autre, A, 1)).error).toContain('CLE_DEJA_UTILISEE');
    const k2 = crypto.randomUUID();
    const refus = await idem(db, k2, c, A, 50); expect(refus.rows[0].r_order_id).toBeNull(); expect(refus.rows[0].r_conflicts).toHaveLength(1);
    expect((await un(db, `SELECT count(*)::int n FROM orders WHERE cle_commande = $1`, [k2])).n).toBe(0);              // clé non consommée
    expect((await idem(db, k2, c, A, 2)).rows[0].r_deja).toBe(false);                                                  // le même formulaire, ajusté, peut être renvoyé
    expect((await srv(db, `UPDATE orders SET cle_commande = $1 WHERE user_id = $2 AND cle_commande <> $1`, [k, c.id])).error).toContain('duplicate key');   // index unique
    await db.close();
  });

  test('erreurs de la création contrôlée remontées telles quelles (compte non actif) ; rien n\'est écrit', async () => {
    const db = await basePanier(true); const c = await nouveauClient(db, 1, 'suspendu'); const A = await produitStock(db, 'A', 10);
    expect((await idem(db, crypto.randomUUID(), c, A, 1)).error).toContain('COMPTE_NON_ACTIF');
    expect((await un(db, `SELECT count(*)::int n FROM orders`)).n).toBe(0);
    await db.close();
  });

  test('sécurité du fichier : additif seulement (aucun effacement, aucune modification de commande existante, aucun changement des fonctions existantes)', () => {
    const sql = readFileSync('supabase/migrations/orders_idempotence_cle.sql', 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|DELETE)\b/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION (?!order_create_idempotent)/i);
    expect(sql).not.toMatch(/\bUPDATE orders SET (?!cle_commande)/i);
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS cle_commande'); expect(sql).toContain('BEGIN;'); expect(sql).toContain('COMMIT;');
  });
});
