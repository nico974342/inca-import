/**
 * Proposition de correctifs de sécurité (supabase/propositions/securite_supabase.sql), testée sur une base LOCALE (PGlite)
 * qui reproduit les rôles Supabase et l'état constaté en production. Aucune base distante touchée.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const SQL = readFileSync('supabase/propositions/securite_supabase.sql', 'utf8');
const ETAT = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE TABLE commande_fournisseur_drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_email text, quantity int);
  INSERT INTO commande_fournisseur_drafts (admin_email, quantity) VALUES ('a@b.fr', 3);
  CREATE SEQUENCE bl_number_seq START 85;
  CREATE FUNCTION next_bl_number() RETURNS text LANGUAGE sql SECURITY DEFINER AS $$ SELECT 'BL-' || lpad(nextval('bl_number_seq')::text, 4, '0') $$;
  CREATE FUNCTION recalc_pump(p uuid[]) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
  CREATE FUNCTION reception_delete(p uuid) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
  CREATE FUNCTION order_mark_livree(p uuid) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
  CREATE FUNCTION order_cancel_livree(p uuid) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
  CREATE FUNCTION stock_reserving_statuses() RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY['confirmee'] $$;
  CREATE FUNCTION product_adjust_stock(p uuid, d integer) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
  CREATE FUNCTION price_group_set_default(p uuid) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
  CREATE FUNCTION order_create_checked(o jsonb, i jsonb) RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE FUNCTION order_update_checked(o uuid, i jsonb) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
  CREATE FUNCTION reception_create(a text, b date, c text, d boolean, e jsonb, f uuid) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
  CREATE FUNCTION reception_update(a uuid, b text, c date, d text, e boolean, f jsonb, g uuid) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;`;

const as = async (db: PGlite, role: string, q: string) => {
  await db.exec(`SET ROLE ${role}`);
  try { const r = await db.query(q); return { rows: r.rows as any[], error: '' }; }
  catch (e: any) { return { rows: [] as any[], error: String(e.message ?? e) }; }
  finally { await db.exec('RESET ROLE'); }
};

test.describe.serial('Correctifs de sécurité proposés', () => {
  let db: PGlite;
  test.beforeAll(async () => { db = new PGlite(); await db.exec(ETAT); });
  test.afterAll(async () => { await db.close(); });

  test('avant correction : le défaut existe (anon lit les brouillons et consomme un numéro de BL)', async () => {
    expect((await as(db, 'anon', `SELECT count(*)::int n FROM commande_fournisseur_drafts`)).rows[0].n).toBe(1);
    expect((await as(db, 'anon', `SELECT next_bl_number() AS bl`)).rows[0].bl).toBe('BL-0085');
  });

  test('après correction : anon et authenticated sont refusés ; service_role fonctionne toujours', async () => {
    await db.exec(SQL);
    for (const role of ['anon', 'authenticated']) {
      expect((await as(db, role, `SELECT 1 FROM commande_fournisseur_drafts`)).error, role).toMatch(/permission denied/i);
      expect((await as(db, role, `DELETE FROM commande_fournisseur_drafts`)).error, role).toMatch(/permission denied/i);
      expect((await as(db, role, `SELECT next_bl_number()`)).error, role).toMatch(/permission denied/i);
      expect((await as(db, role, `SELECT order_update_checked(gen_random_uuid(), '[]')`)).error, role).toMatch(/permission denied/i);
    }
    expect((await as(db, 'service_role', `SELECT count(*)::int n FROM commande_fournisseur_drafts`)).rows[0].n).toBe(1);
    expect((await as(db, 'service_role', `SELECT next_bl_number() AS bl`)).rows[0].bl).toBe('BL-0086');   // le numéro 85 de anon a bien été « brûlé » avant, la suite reste cohérente
    expect((await as(db, 'service_role', `SELECT order_update_checked(gen_random_uuid(), '[]')`)).error).toBe('');
  });

  test('les 12 fonctions ont un search_path figé ; RLS actif sur les brouillons', async () => {
    const f = (await db.query<any>(`SELECT proname, proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('next_bl_number','recalc_pump','reception_delete','order_mark_livree','order_cancel_livree','stock_reserving_statuses','product_adjust_stock','price_group_set_default','order_create_checked','order_update_checked','reception_create','reception_update')`)).rows;
    expect(f.length).toBe(12);
    for (const r of f) expect(String(r.proconfig), r.proname).toContain('search_path=public, pg_temp');
    expect((await db.query<any>(`SELECT relrowsecurity FROM pg_class WHERE relname='commande_fournisseur_drafts'`)).rows[0].relrowsecurity).toBe(true);
  });

  test('rejouable sans erreur', async () => { await db.exec(SQL); });

  test('statique : aucune suppression de donnée dans la proposition', () => {
    const code = SQL.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
    expect(code).not.toMatch(/\b(DROP|DELETE FROM|TRUNCATE|UPDATE)\b/i);
  });
});
