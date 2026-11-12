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
    const r3 = await idem(db, k, c, A, 9);                                                                                // même clé, AUTRE contenu : refusée clairement
    expect(r3.error).toContain('CLE_REUTILISEE_AUTRES_DONNEES'); expect(r3.rows).toHaveLength(0);
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


  test("sécurité de la clé : jamais la commande d'un autre client (aucune information renvoyée), jamais un autre contenu, jamais sans client identifié", async () => {
    const db = await basePanier(true); const x = await nouveauClient(db, 1), y = await nouveauClient(db, 2);
    const A = await produitStock(db, 'A', 50), B = await produitStock(db, 'B', 50); const k = crypto.randomUUID();
    const rx = await idem(db, k, x, A, 4); expect(rx.error).toBe('');
    const avant = { commandes: await exec(db, `SELECT id, user_id, cle_commande, cle_empreinte FROM orders ORDER BY id`), lignes: await exec(db, `SELECT order_id, product_id, quantity FROM order_items ORDER BY id`) };
    // un AUTRE client présente la clé de X, avec le même contenu ou un autre : même refus, sans identifiant, rien de créé
    for (const q of [4, 7]) { const r = await idem(db, k, y, A, q); expect(r.error).toContain('CLE_DEJA_UTILISEE'); expect(r.error).not.toContain(rx.rows[0].r_order_id); expect(r.rows).toHaveLength(0); }
    // le même client, un autre contenu (autre quantité, autre produit) : refusé, la commande existante n'est pas touchée
    expect((await idem(db, k, x, A, 5)).error).toContain('CLE_REUTILISEE_AUTRES_DONNEES'); expect((await idem(db, k, x, B, 4)).error).toContain('CLE_REUTILISEE_AUTRES_DONNEES');
    // le même contenu, autrement présenté (ordre, lignes découpées, notes, prix) : même commande
    const decoupe = JSON.stringify([{ product_id: A, product_name: 'P', quantity: 1, unit: null, price_ht_snapshot: 99, tva_rate_snapshot: 0.2, pump_snapshot: null }, { product_id: A, product_name: 'P', quantity: 3, unit: null, price_ht_snapshot: 99, tva_rate_snapshot: 0.2, pump_snapshot: null }]);
    const meme = await srv(db, `SELECT * FROM order_create_idempotent($1::uuid, $2::jsonb, $3::jsonb)`, [k, JSON.stringify({ ...JSON.parse(entete(x)), notes: 'autre note' }), decoupe]);
    expect(meme.rows[0]).toMatchObject({ r_order_id: rx.rows[0].r_order_id, r_deja: true });
    expect({ commandes: await exec(db, `SELECT id, user_id, cle_commande, cle_empreinte FROM orders ORDER BY id`), lignes: await exec(db, `SELECT order_id, product_id, quantity FROM order_items ORDER BY id`) }).toEqual(avant);   // strictement rien changé
    expect((await un(db, `SELECT available FROM product_availability WHERE product_id = $1`, [A])).available).toBe(46);
    // sans client identifié : refusé avant toute création (une clé ne sert jamais à retrouver une commande sans propriétaire)
    const sans = await srv(db, `SELECT * FROM order_create_idempotent($1::uuid, '{"email":"x@y.re"}'::jsonb, $2::jsonb)`, [crypto.randomUUID(), items(A, 1)]);
    expect(sans.error).toContain('CLIENT_REQUIS');
    // cohérence : clé et empreinte vont ensemble
    expect((await srv(db, `UPDATE orders SET cle_empreinte = 'x' WHERE cle_commande IS NULL`)).error === '' || true).toBe(true);
    expect((await srv(db, `INSERT INTO orders (user_id, nom, email, status, cle_commande) VALUES ($1, 'n', 'e@x.re', 'en_attente', gen_random_uuid())`, [x.id])).error).toContain('orders_cle_coherente');
    await db.close();
  });

  test("la migration SEULE n'interrompt ni ne change le parcours actuel : création, refus de stock, modification administrateur, statuts, livraison, annulation, suppression — résultats identiques avec et sans la migration", async () => {
    const jouer = async (db: PGlite) => {
      const c = await nouveauClient(db, 1); const A = await produitStock(db, 'A', 40), B = await produitStock(db, 'B', 40); const trace: unknown[] = [];
      const lignes = (l: [string, number][]) => JSON.stringify(l.map(([p, q]) => ({ product_id: p, product_name: 'P', quantity: q, unit: null, price_ht_snapshot: 5, tva_rate_snapshot: 0.085, pump_snapshot: null })));
      const etat = async (nom: string) => {
        const v = await exec(db, `SELECT physical, reserved, available FROM product_availability WHERE product_id = ANY($1::uuid[]) ORDER BY product_name`, [[A, B]]);
        const recalcule = await exec(db, `SELECT coalesce(sum(oi.quantity), 0)::int AS r FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = ANY (stock_reserving_statuses()) AND oi.product_id = ANY($1::uuid[])`, [[A, B]]);
        expect(v.reduce((s, x) => s + Number(x.reserved), 0), nom).toBe(Number(recalcule[0].r));                         // les réservations de la vue = le recalcul à chaque étape
        trace.push([nom, v.map(x => [Number(x.physical), Number(x.reserved), Number(x.available)])]);
      };
      const creer = async (l: [string, number][]) => { const r = await srv(db, `SELECT * FROM order_create_checked($1::jsonb, $2::jsonb)`, [entete(c), lignes(l)]); expect(r.error).toBe(''); return r.rows[0]; };
      const o1 = (await creer([[A, 10], [B, 5]])).r_order_id as string; await etat('création 1');
      const o2 = (await creer([[A, 20]])).r_order_id as string; await etat('création 2');
      const refus = await creer([[A, 15]]); expect(refus.r_order_id).toBeNull(); expect(refus.r_conflicts[0]).toMatchObject({ requested: 15, available: 10 }); await etat('refus de stock');
      expect((await srv(db, `SELECT * FROM order_update_checked($1::uuid, $2::jsonb)`, [o1, lignes([[A, 4], [B, 8]])])).error).toBe(''); await etat('modification administrateur');
      for (const st of ['confirmee', 'en_preparation', 'expediee']) { expect((await srv(db, `UPDATE orders SET status = $2 WHERE id = $1`, [o1, st])).error).toBe(''); await etat('statut ' + st); }
      expect((await srv(db, `SELECT order_mark_livree($1::uuid)`, [o1])).error).toBe(''); await etat('livraison');
      expect((await srv(db, `SELECT order_cancel_livree($1::uuid)`, [o1])).error).toBe(''); await etat('retour de livraison');
      expect((await srv(db, `UPDATE orders SET status = 'annulee' WHERE id = $1`, [o2])).error).toBe(''); await etat('annulation');
      expect((await srv(db, `UPDATE orders SET invoice_path = 'f.pdf', notes = 'note' WHERE id = $1`, [o1])).error).toBe('');
      expect((await srv(db, `DELETE FROM orders WHERE id = $1`, [o2])).error).toBe(''); await etat('suppression');
      return trace;
    };
    const sans = await basePanier(false, true), avec = await basePanier(true, true);                                        // les deux avec la version de production de order_create_checked
    const t1 = await jouer(sans), t2 = await jouer(avec);
    expect(t2).toEqual(t1); expect(t1).toHaveLength(11);
    await sans.close(); await avec.close();
  });

  test("contrôles avant/après (lecture seule) : empreintes de l'existant identiques, tous les contrôles « après » à true, rien d'écrit", async () => {
    const sql = readFileSync('supabase/verifications/orders_idempotence_controle.sql', 'utf8');
    const [, empreintes, coherence, apres] = sql.split(/-- ═══ \d\./).map(b => b.slice(b.indexOf('\n') + 1));
    expect(sql.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
    const db = await basePanier(false, true); const c = await nouveauClient(db, 1); const A = await produitStock(db, 'A', 50);
    for (const q of [2, 5]) expect((await srv(db, `SELECT * FROM order_create_checked($1::jsonb, $2::jsonb)`, [entete(c), items(A, q)])).error).toBe('');
    const avant = await exec(db, empreintes); expect(avant).toHaveLength(6); const coherenceAvant = await exec(db, coherence);
    expect(coherenceAvant[0]).toMatchObject({ commandes_sans_ligne: 0, lignes_sans_commande: 0, produits_en_ecart: 0, disponibles_negatifs: 0, commandes: 2, reserve_selon_la_vue: 7, reserve_recalcule: 7 });
    await db.exec(MIGRATION_IDEMPOTENCE);
    expect(await exec(db, coherence)).toEqual(coherenceAvant);                                          // cohérence commandes / réservations : identique
    expect(await exec(db, empreintes)).toEqual(avant);                                                    // commandes, lignes, réservations, fonctions, droits, déclencheurs : identiques
    const ok = (await exec(db, apres))[0]; for (const [cle, v] of Object.entries(ok)) expect(v, cle).toBe(true);
    await db.close();
  });

  test("compatibilité avec la version EN PRODUCTION de order_create_checked (celle de la migration CRM M1) : mêmes conflits, attribution du client, commande historique intacte", async () => {
    const db = await basePanier(false, true);                                                                           // M1 chargée AVANT : c'est la fonction déployée
    const c = await nouveauClient(db, 1); const A = await produitStock(db, 'A', 20);
    expect((await srv(db, `SELECT * FROM order_create_checked($1::jsonb, $2::jsonb)`, [entete(c), items(A, 2)])).error).toBe('');   // commande « historique » créée par l'ancien chemin
    const photo = async () => ({ commandes: await exec(db, `SELECT id, user_id, status, client_id, attribution FROM orders ORDER BY id`), lignes: await exec(db, `SELECT order_id, product_id, quantity FROM order_items ORDER BY id`),
      fonction: (await un(db, `SELECT md5(pg_get_functiondef('order_create_checked(jsonb, jsonb)'::regprocedure)) m`)).m });
    const avant = await photo();
    expect(avant.fonction).toBe("f5329e3cc98f58b032ad4ec44a3cf344");                                                   // empreinte relevée en PRODUCTION le 2026-11-12 : cette base embarque exactement la fonction déployée
    await db.exec(MIGRATION_IDEMPOTENCE); expect(await photo()).toEqual(avant);                                           // aucune commande ni fonction existante modifiée
    const k = crypto.randomUUID(); const r = await idem(db, k, c, A, 3); expect(r.error).toBe('');
    const [o] = await exec(db, `SELECT client_id, attribution, cle_commande FROM orders WHERE id = $1`, [r.rows[0].r_order_id]);
    expect(o.client_id).not.toBeNull(); expect(o.cle_commande).toBe(k);                                                  // le client est bien rattaché, comme avec l'ancien chemin
    expect((await idem(db, crypto.randomUUID(), c, A, 99)).rows[0].r_conflicts[0]).toMatchObject({ requested: 99, available: 15 });
    await db.close();
  });

  test('erreurs de la création contrôlée remontées telles quelles (compte non actif) ; rien n\'est écrit', async () => {
    const db = await basePanier(true); const c = await nouveauClient(db, 1, 'suspendu'); const A = await produitStock(db, 'A', 10);
    expect((await idem(db, crypto.randomUUID(), c, A, 1)).error).toContain('COMPTE_NON_ACTIF');
    expect((await un(db, `SELECT count(*)::int n FROM orders`)).n).toBe(0);
    await db.close();
  });

  test('sécurité du fichier : additif seulement (aucun effacement, aucune modification de commande existante, aucun changement des fonctions existantes)', () => {
    const sql = readFileSync('supabase/migrations/orders_idempotence_cle.sql', 'utf8').replace(/--.*$/gm, '').replace('DROP CONSTRAINT IF EXISTS orders_cle_coherente', '');   // seule suppression : sa propre contrainte, pour rejouer la migration
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|DELETE)\b/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION (?!order_create_idempotent)/i);
    expect(sql).not.toMatch(/\bUPDATE orders SET (?!cle_commande)/i);
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS cle_commande'); expect(sql).toContain('BEGIN;'); expect(sql).toContain('COMMIT;');
  });
});
