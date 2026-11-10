/**
 * Badge « Nouveau » — règles (src/lib/nouveau.ts) et migration (supabase/migrations/products_nouveau.sql).
 * Base LOCALE uniquement (PGlite) : aucune écriture sur Supabase.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { estNouveau, decider, finParDefaut, finDepuisDate, dateReunion, finAffichee } from '../src/lib/nouveau';

const SQL = readFileSync('supabase/migrations/products_nouveau.sql', 'utf8');
const J = 86_400_000;
const T0 = new Date('2026-11-10T08:00:00Z');
const iso = (d: Date) => d.toISOString();
const plus = (d: Date, jours: number) => new Date(d.getTime() + jours * J);

test.describe('Affichage', () => {
  const p = (mode: string, debut: Date | null, fin: Date | null) => ({ nouveau_mode: mode, nouveau_debut: debut && iso(debut), nouveau_fin: fin && iso(fin) });
  test('affiché dans la fenêtre, disparaît tout seul à la date de fin (sans tâche planifiée)', () => {
    const v = p('auto', T0, plus(T0, 30));
    expect(estNouveau(v, T0)).toBe(true);
    expect(estNouveau(v, plus(T0, 29.99))).toBe(true);
    expect(estNouveau(v, plus(T0, 30))).toBe(false);
    expect(estNouveau(v, plus(T0, 31))).toBe(false);
    expect(estNouveau(v, plus(T0, -1))).toBe(false);   // pas avant le début
  });
  test('désactivation volontaire prioritaire, produit sans fenêtre ou données illisibles : jamais affiché', () => {
    expect(estNouveau(p('desactive', T0, plus(T0, 30)), plus(T0, 1))).toBe(false);
    expect(estNouveau(p('auto', null, null), T0)).toBe(false);
    expect(estNouveau({ nouveau_mode: 'auto', nouveau_debut: 'x', nouveau_fin: 'y' }, T0)).toBe(false);
    expect(estNouveau(null, T0)).toBe(false);
    expect(estNouveau({}, T0)).toBe(false);   // colonnes absentes (migration pas encore appliquée)
  });
});

test.describe('Fiche produit — décisions', () => {
  const vide = { nouveau_mode: 'auto', nouveau_debut: null, nouveau_fin: null };
  const actif = (mode = 'manuel') => ({ nouveau_mode: mode, nouveau_debut: iso(plus(T0, -3)), nouveau_fin: iso(plus(T0, 20)) });

  test('activer un produit ancien : début = maintenant, fin = +30 jours, mode manuel', () => {
    const d = decider(vide, true, finAffichee(vide, T0), T0);
    expect(d.change).toBe(true);
    expect(d.mode).toBe('manuel');
    expect(d.debut).toEqual(T0);
    expect(d.fin).toEqual(finParDefaut(T0));
    expect(d.fin!.getTime() - d.debut!.getTime()).toBe(30 * J);
  });
  test('activer avec une fin modifiée : la date choisie est incluse (23 h 59 min 59 à La Réunion)', () => {
    const d = decider(vide, true, '2026-12-01', T0);
    expect(iso(d.fin!)).toBe('2026-12-01T19:59:59.000Z');
    expect(d.mode).toBe('manuel');
  });
  test('activer avec une fin passée ou illisible : retombe sur +30 jours', () => {
    expect(decider(vide, true, '2026-11-01', T0).fin).toEqual(finParDefaut(T0));
    expect(decider(vide, true, 'n\'importe quoi', T0).fin).toEqual(finParDefaut(T0));
    expect(decider(vide, true, '', T0).fin).toEqual(finParDefaut(T0));
  });
  test('désactiver immédiatement : mode desactive, fin = maintenant, plus affiché', () => {
    const d = decider(actif(), false, dateReunion(actif().nouveau_fin), T0);
    expect(d.mode).toBe('desactive');
    expect(d.fin).toEqual(T0);
    expect(estNouveau({ nouveau_mode: d.mode, nouveau_debut: iso(d.debut!), nouveau_fin: iso(d.fin!) }, plus(T0, 0.001))).toBe(false);
    expect(decider(actif('auto'), false, '', T0).mode).toBe('desactive');   // aussi pour un badge automatique
  });
  test('enregistrer la fiche sans toucher au badge ne change RIEN (case décochée sur un produit non affiché, ou badge inchangé)', () => {
    expect(decider(vide, false, '', T0).change).toBe(false);
    expect(decider({ nouveau_mode: 'desactive', nouveau_debut: iso(plus(T0, -9)), nouveau_fin: iso(plus(T0, -1)) }, false, '', T0).change).toBe(false);
    expect(decider({ nouveau_mode: 'auto', nouveau_debut: iso(plus(T0, -40)), nouveau_fin: iso(plus(T0, -10)) }, false, '', T0).change).toBe(false);   // expiré
    expect(decider(actif(), true, finAffichee(actif(), T0), T0).change).toBe(false);
    expect(decider(actif('auto'), true, finAffichee(actif('auto'), T0), T0).change).toBe(false);   // un badge automatique reste automatique
  });
  test('modifier la fin d\'un badge affiché : début conservé ; une fin passée désactive', () => {
    const a = actif();
    const d = decider(a, true, '2026-12-24', T0);
    expect(d.mode).toBe('manuel');
    expect(d.debut).toEqual(new Date(a.nouveau_debut));
    expect(iso(d.fin!)).toBe('2026-12-24T19:59:59.000Z');
    expect(decider(a, true, '2026-11-02', T0).mode).toBe('desactive');
  });
  test('réactiver après désactivation ou expiration : nouveau cycle de 30 jours', () => {
    const expire = { nouveau_mode: 'auto', nouveau_debut: iso(plus(T0, -40)), nouveau_fin: iso(plus(T0, -10)) };
    const d = decider(expire, true, finAffichee(expire, T0), T0);
    expect(d.debut).toEqual(T0);
    expect(d.fin).toEqual(finParDefaut(T0));
    const off = { nouveau_mode: 'desactive', nouveau_debut: iso(plus(T0, -5)), nouveau_fin: iso(T0) };
    expect(decider(off, true, finAffichee(off, T0), plus(T0, 1)).mode).toBe('manuel');
  });
  test('dates : fuseau de La Réunion', () => {
    expect(dateReunion('2026-11-10T21:00:00Z')).toBe('2026-11-11');   // 01 h le lendemain à La Réunion
    expect(finDepuisDate('2026-02-30')).toBeNull();
    expect(finDepuisDate('10/11/2026')).toBeNull();
  });
});

// ── Migration sur une base locale ─────────────────────────────────────────
const PRODUITS = `
  CREATE TABLE products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, stock_quantity integer NOT NULL DEFAULT 0,
    price_ht numeric, in_stock boolean DEFAULT true, created_at timestamptz DEFAULT now());
  INSERT INTO products (name, stock_quantity, price_ht) VALUES ('Ancien en stock', 50, 12.5), ('Ancien épuisé', 0, 8), ('Ancien jamais reçu', 0, 9);`;
const un = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows[0];

test.describe.serial('Migration products_nouveau.sql (base locale)', () => {
  let db: PGlite;
  let avant: string;
  const instantane = async () => JSON.stringify((await db.query(`SELECT id, name, stock_quantity, price_ht, in_stock FROM products ORDER BY name`)).rows);
  test.beforeAll(async () => { db = new PGlite(); await db.exec(PRODUITS); avant = await instantane(); await db.exec(SQL); });
  test.afterAll(async () => { await db.close(); });

  test('produits existants : tous historiques, aucune date fictive, stock et prix inchangés ; migration rejouable', async () => {
    await db.exec(SQL);
    expect(await instantane()).toBe(avant);
    const r = await un(db, `SELECT count(*)::int total, count(*) FILTER (WHERE nouveau_eligible)::int eligibles, count(*) FILTER (WHERE premiere_entree_stock_le IS NOT NULL OR nouveau_debut IS NOT NULL OR nouveau_fin IS NOT NULL)::int dates FROM products`);
    expect(r).toEqual({ total: 3, eligibles: 0, dates: 0 });
    expect((await un(db, `SELECT column_default FROM information_schema.columns WHERE table_name='products' AND column_name='nouveau_eligible'`)).column_default).toBe('true');
  });

  test('réassort d\'un produit historique (en stock, épuisé, jamais reçu) : jamais « nouveau »', async () => {
    await db.exec(`UPDATE products SET stock_quantity = stock_quantity + 40 WHERE name = 'Ancien en stock'`);
    await db.exec(`UPDATE products SET stock_quantity = 25 WHERE name IN ('Ancien épuisé', 'Ancien jamais reçu')`);
    const r = (await db.query<any>(`SELECT premiere_entree_stock_le, nouveau_debut, nouveau_fin, nouveau_mode FROM products`)).rows;
    for (const x of r) expect(x).toEqual({ premiere_entree_stock_le: null, nouveau_debut: null, nouveau_fin: null, nouveau_mode: 'auto' });
  });

  test('produit inédit créé à stock 0 : rien tant qu\'il n\'est pas en stock ; première entrée = badge 30 jours', async () => {
    const id = (await un(db, `INSERT INTO products (name) VALUES ('Inédit') RETURNING id`)).id;
    expect(await un(db, `SELECT nouveau_eligible e, premiere_entree_stock_le p, nouveau_fin f FROM products WHERE id=$1`, [id])).toEqual({ e: true, p: null, f: null });
    await db.query(`UPDATE products SET price_ht = 5 WHERE id=$1`, [id]);   // autre modification : sans effet
    expect((await un(db, `SELECT nouveau_fin f FROM products WHERE id=$1`, [id])).f).toBeNull();
    await db.query(`UPDATE products SET stock_quantity = 24 WHERE id=$1`, [id]);
    const r = await un(db, `SELECT premiere_entree_stock_le p, nouveau_debut d, nouveau_fin f, nouveau_mode m, extract(epoch FROM (nouveau_fin - nouveau_debut))/86400 jours FROM products WHERE id=$1`, [id]);
    expect(r.p).not.toBeNull();
    expect(r.d).toEqual(r.p);
    expect(Number(r.jours)).toBe(30);
    expect(r.m).toBe('auto');
  });

  test('réassort : la date de première entrée et la fenêtre ne bougent jamais, même après rupture puis nouvelle entrée', async () => {
    const id = (await un(db, `INSERT INTO products (name, stock_quantity) VALUES ('Inédit 2', 10) RETURNING id`)).id;   // créé directement en stock
    const premier = await un(db, `SELECT premiere_entree_stock_le p, nouveau_debut d, nouveau_fin f FROM products WHERE id=$1`, [id]);
    expect(premier.p).not.toBeNull();
    await db.query(`UPDATE products SET stock_quantity = 0 WHERE id=$1`, [id]);
    await db.query(`UPDATE products SET stock_quantity = 100 WHERE id=$1`, [id]);
    expect(await un(db, `SELECT premiere_entree_stock_le p, nouveau_debut d, nouveau_fin f FROM products WHERE id=$1`, [id])).toEqual(premier);
  });

  test('badge arrivé à expiration puis réassort : pas de réactivation', async () => {
    const id = (await un(db, `INSERT INTO products (name, stock_quantity) VALUES ('Inédit 3', 10) RETURNING id`)).id;
    await db.query(`UPDATE products SET nouveau_fin = now() - interval '1 day', nouveau_debut = now() - interval '31 days' WHERE id=$1`, [id]);
    await db.query(`UPDATE products SET stock_quantity = 0 WHERE id=$1`, [id]);
    await db.query(`UPDATE products SET stock_quantity = 60 WHERE id=$1`, [id]);
    expect((await un(db, `SELECT nouveau_fin < now() AS expire FROM products WHERE id=$1`, [id])).expire).toBe(true);
  });

  test('désactivation volontaire AVANT la première entrée en stock : l\'automatisme ne la contourne pas', async () => {
    const id = (await un(db, `INSERT INTO products (name, nouveau_mode) VALUES ('Inédit 4', 'desactive') RETURNING id`)).id;
    await db.query(`UPDATE products SET stock_quantity = 30 WHERE id=$1`, [id]);
    const r = await un(db, `SELECT nouveau_mode m, nouveau_debut d, nouveau_fin f, premiere_entree_stock_le p FROM products WHERE id=$1`, [id]);
    expect(r.m).toBe('desactive');
    expect(r.d).toBeNull();
    expect(r.f).toBeNull();
    expect(r.p).not.toBeNull();   // la première entrée est tout de même enregistrée
  });

  test('activation manuelle d\'un produit historique en stock : possible, sans effet sur le stock ni le prix', async () => {
    await db.exec(`UPDATE products SET nouveau_mode='manuel', nouveau_debut=now(), nouveau_fin=now() + interval '30 days' WHERE name='Ancien en stock'`);
    const r = await un(db, `SELECT stock_quantity s, price_ht p, nouveau_eligible e FROM products WHERE name='Ancien en stock'`);
    expect(r).toEqual({ s: 90, p: '12.5', e: false });
  });

  test('contraintes : mode inconnu et fenêtre inversée refusés', async () => {
    await expect(db.exec(`UPDATE products SET nouveau_mode='autre' WHERE name='Ancien épuisé'`)).rejects.toThrow(/check/i);
    await expect(db.exec(`UPDATE products SET nouveau_debut=now(), nouveau_fin=now() - interval '1 day' WHERE name='Ancien épuisé'`)).rejects.toThrow(/check/i);
  });

  test('statique : migration additive (aucune suppression, aucune écriture de stock ou de prix, aucune date fictive)', () => {
    const code = SQL.split(/\r?\n/).map(l => l.replace(/--.*$/, '')).join('\n');
    expect(code).not.toMatch(/\b(DROP TABLE|DELETE FROM|TRUNCATE|UPDATE\s+products)\b/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/NEW\.(stock_quantity|price_ht)\s*:=/);
  });
});
