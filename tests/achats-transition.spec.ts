/**
 * Transition sécurisée vers les réceptions partielles : états, sonde de migration, gel au niveau de la base, contrôle « aucune opération en cours »,
 * gardes SERVEUR sur chaque point d'écriture, et ancienne interface (page restée ouverte). Tout est LOCAL (PGlite, code source) : aucune connexion à Supabase.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { baseAchats, MIGRATION, un, exec, produit, commande } from './helpers/achatsBase';
import { creerAchats } from '../src/lib/achatsReception';
import { traiterReception, traiterCorrection } from '../src/lib/achatsActions';
import { estFonctionAbsente, etatTransition, lireEtat, oublierSonde, receptionLibreAutorisee, ecritureAutorisee, sonderMigration, MESSAGE_TRANSITION } from '../src/lib/achatsTransition';
import type { DepotPortefeuille } from '../src/lib/portefeuille';

const lire = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const GEL = lire('supabase/transition/achats_gel_receptions_base.sql');
const DEGEL = lire('supabase/transition/achats_degel_receptions_base.sql');
const AVANT_MIGRATION = lire('supabase/verifications/achats_receptions_partielles_avant_migration.sql');
const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const ADMIN = { id: ADMIN_ID, email: 'admin@inca.re', app_metadata: { role: 'admin' } };

const as = async (db: PGlite, role: string, q: string, p: unknown[] = []) => {
  await db.exec(`SET ROLE ${role}`);
  try { return { rows: (await db.query<any>(q, p)).rows as any[], error: '' }; }
  catch (e: any) { return { rows: [] as any[], error: String(e.message ?? e), code: e.code as string | undefined }; }
  finally { await db.exec('RESET ROLE'); }
};
const srv = (db: PGlite, q: string, p: unknown[] = []) => as(db, 'service_role', q, p);
/** Client « Supabase » branché sur la base locale, comme le site : rôle service_role, appel de fonction par son nom. */
const clientLocal = (db: PGlite) => ({
  async rpc(nom: string, args: Record<string, unknown>) {
    await db.exec('SET ROLE service_role');
    try { const r = await db.query<any>(`SELECT ${nom}($1::uuid) AS r`, [Object.values(args)[0]]); return { data: r.rows[0]?.r ?? null, error: null }; }
    catch (e: any) { return { data: null, error: { code: e.code ?? null, message: String(e.message ?? e) } }; }
    finally { await db.exec('RESET ROLE'); }
  },
});
const ids = (db: PGlite) => ({
  produits: exec(db, `SELECT id, stock_quantity FROM products ORDER BY id`), lignes: exec(db, `SELECT id, quantity, received_quantity FROM shipment_items ORDER BY id`),
  receptions: exec(db, `SELECT id, notes, stock_applied FROM stock_receptions ORDER BY id`),
});
const photo = async (db: PGlite) => { const o = ids(db); return { produits: await o.produits, lignes: await o.lignes, receptions: await o.receptions }; };

test.describe('États de la transition', () => {
  test('matrice des états : actif UNIQUEMENT si la migration est appliquée ET le drapeau vaut 1 ; invérifiable = suspendu', () => {
    expect(lireEtat('non', '1')).toBe('migration_absente');                 // même avec le drapeau, sans migration rien ne s'ouvre
    expect(lireEtat('inconnu', '1')).toBe('inconnu');
    expect(lireEtat('oui', undefined)).toBe('gele'); expect(lireEtat('oui', '')).toBe('gele'); expect(lireEtat('oui', '0')).toBe('gele'); expect(lireEtat('oui', 'true')).toBe('gele'); expect(lireEtat('oui', 'oui')).toBe('gele');
    expect(lireEtat('oui', '1')).toBe('actif'); expect(lireEtat('oui', ' 1 ')).toBe('actif');
    expect(['migration_absente', 'inconnu', 'gele', 'actif'].filter(e => ecritureAutorisee(e as any))).toEqual(['actif']);
    expect(['migration_absente', 'inconnu', 'gele', 'actif'].filter(e => receptionLibreAutorisee(e as any))).toEqual(['migration_absente', 'actif']);
    for (const e of ['migration_absente', 'inconnu', 'gele'] as const) expect(MESSAGE_TRANSITION[e].length, e).toBeGreaterThan(40);
  });

  test('détection de la fonction absente : codes PostgreSQL et PostgREST', () => {
    expect(estFonctionAbsente({ code: '42883' })).toBe(true); expect(estFonctionAbsente({ code: 'PGRST202' })).toBe(true);
    expect(estFonctionAbsente({ message: 'Could not find the function public.shipment_reception_etat(p_shipment_id) in the schema cache' })).toBe(true);
    expect(estFonctionAbsente({ code: '42501', message: 'permission denied for function shipment_reception_etat' })).toBe(false);   // droits : invérifiable, pas « absente »
    expect(estFonctionAbsente({ code: '08006', message: 'connection failure' })).toBe(false); expect(estFonctionAbsente(null)).toBe(false);
  });

  test('sonde et mémoire : une erreur réseau ou une exception = « inconnu » ; un résultat positif est gardé 30 s, tout autre 3 s', async () => {
    expect(await sonderMigration({ rpc: async () => { throw new Error('réseau'); } })).toBe('inconnu');
    expect(await sonderMigration({ rpc: async () => ({ data: null, error: { code: '57014', message: 'timeout' } }) })).toBe('inconnu');
    expect(await sonderMigration({ rpc: async () => ({ data: {}, error: null }) })).toBe('oui');
    let appels = 0; let reponse: 'oui' | 'non' = 'non';
    const c = { rpc: async () => { appels++; return reponse === 'oui' ? { data: {}, error: null } : { data: null, error: { code: 'PGRST202', message: 'x' } }; } };
    oublierSonde();
    expect(await etatTransition({ client: c, drapeau: '1', maintenant: 1000 })).toBe('migration_absente');
    expect(await etatTransition({ client: c, drapeau: '1', maintenant: 2000 })).toBe('migration_absente'); expect(appels).toBe(1);        // gardé 3 s
    reponse = 'oui';
    expect(await etatTransition({ client: c, drapeau: '1', maintenant: 5000 })).toBe('actif'); expect(appels).toBe(2);                    // relu après 3 s
    reponse = 'non';
    expect(await etatTransition({ client: c, drapeau: '1', maintenant: 30_000 })).toBe('actif'); expect(appels).toBe(2);                  // résultat positif gardé 30 s
    expect(await etatTransition({ client: c, drapeau: '1', maintenant: 40_000 })).toBe('migration_absente'); expect(appels).toBe(3);
    expect(await etatTransition({ client: c, drapeau: undefined, maintenant: 40_100 })).toBe('migration_absente');
    oublierSonde();
  });

  test('sonde sur une vraie base : avant la migration = absente ; après = présente (sans rien écrire) ; fonction fermée = invérifiable (suspendu par sécurité)', async () => {
    const avant = await baseAchats(false); const p = await produit(avant, 'A', 5); await commande(avant, [{ p, q: 10, recu: 4 }]);
    const instantane = await photo(avant);
    expect(await sonderMigration(clientLocal(avant))).toBe('non');
    await avant.exec(MIGRATION);
    expect(await sonderMigration(clientLocal(avant))).toBe('oui');
    expect(await photo(avant)).toEqual(instantane);                                                       // la sonde n'a rien écrit
    await avant.exec(`REVOKE EXECUTE ON FUNCTION shipment_reception_etat(uuid) FROM service_role`);
    expect(await sonderMigration(clientLocal(avant))).toBe('inconnu');
    await avant.close();
  });
});

test.describe('Gel des réceptions au niveau de la base', () => {
  test('le gel ferme les trois fonctions historiques, quel que soit le code appelant ; le dégel rend l\'état exact d\'avant ; aucune donnée touchée', async () => {
    const db = await baseAchats(false);
    const p = await produit(db, 'A', 0);
    const items = JSON.stringify([{ product_id: p, quantity: 10, unit_cost_ht: 4 }]);
    const id = (await srv(db, `SELECT reception_create('Fournisseur', '2026-10-20'::date, 'avant gel', true, $1::jsonb) AS id`, [items])).rows[0].id;
    const avant = await photo(db);
    await db.exec(GEL);
    for (const [q, args] of [
      [`SELECT reception_create('F', '2026-10-21'::date, 'x', true, $1::jsonb)`, [items]],
      [`SELECT reception_update($1::uuid, 'F', '2026-10-21'::date, 'x', true, $2::jsonb)`, [id, items]],
      [`SELECT reception_delete($1::uuid)`, [id]],
    ] as [string, unknown[]][]) expect((await srv(db, q, args)).error, q).toContain('permission denied');
    for (const role of ['anon', 'authenticated']) expect((await as(db, role, `SELECT reception_delete($1::uuid)`, [id])).error).toContain('permission denied');
    expect(await photo(db)).toEqual(avant);                                                               // rien n'a bougé
    expect((await srv(db, `SELECT product_adjust_stock($1::uuid, 3)`, [p])).error).toBe('');            // les autres fonctions ne sont pas touchées
    await db.exec(GEL);                                                                                  // rejouable
    await db.exec(DEGEL);
    expect((await srv(db, `SELECT reception_update($1::uuid, 'F', '2026-10-20'::date, 'après dégel', true, $2::jsonb)`, [id, items])).error).toBe('');
    for (const role of ['anon', 'authenticated']) expect((await as(db, role, `SELECT reception_delete($1::uuid)`, [id])).error).toContain('permission denied');   // jamais ouvert au public
    await db.close();
  });

  test('gel + migration : la migration s\'applique sur une base gelée, le gel reste actif, les nouvelles fonctions sont indépendantes du gel ; le dégel ne rouvre que les anciennes', async () => {
    const db = await baseAchats(false);
    const p = await produit(db, 'A', 0); const c = await commande(db, [{ p, q: 100 }]);
    await db.exec(GEL); await db.exec(MIGRATION);
    expect((await srv(db, `SELECT reception_create('F', '2026-10-21'::date, 'x', true, '[]'::jsonb)`)).error).toContain('permission denied');   // toujours gelé après la migration
    const r = await srv(db, `SELECT reception_commande_enregistrer($1::uuid, $2::uuid, ((now() AT TIME ZONE 'UTC') + interval '4 hours')::date, NULL, NULL, $3::jsonb, $4::uuid, 'admin@inca.re', 'admin')`,
      [crypto.randomUUID(), c.s, JSON.stringify([{ shipment_item_id: c.ids[0], quantity: 10, unit_cost_ht: 5 }]), ADMIN_ID]);
    expect(r.error).toBe('');                                                                             // (le nouveau parcours est protégé par le drapeau SERVEUR, pas par ce gel)
    await db.exec(DEGEL);
    expect((await srv(db, `SELECT reception_create('F', '2026-10-21'::date, 'x', true, $1::jsonb)`, [JSON.stringify([{ product_id: p, quantity: 1, unit_cost_ht: 4 }])])).error).toBe('');
    await db.close();
  });

  test('les scripts de gel vivent hors des migrations, avec transaction explicite, sans effacement ni écriture de données', () => {
    for (const s of [GEL, DEGEL]) {
      expect(s).toContain('BEGIN;'); expect(s).toContain('COMMIT;');
      expect(s.replace(/--.*$/gm, '')).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i);
    }
    expect(GEL).toMatch(/REVOKE EXECUTE ON FUNCTION[\s\S]*reception_create[\s\S]*reception_update[\s\S]*reception_delete/); expect(DEGEL).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role;/);
  });
});

/**
 * Portage fidèle de src/pages/api/admin/reception/create.ts du commit 6befb09 — le code ACTUELLEMENT DÉPLOYÉ en production (vérifié dans Vercel : déploiement READY de main).
 * Même ordre d'opérations : 1. reception_create (stock + réception + PUMP) ; si l'appel échoue → redirection immédiate ; 2. seulement ensuite, mise à jour NON atomique du cumul
 * de chaque ligne, puis passage de la commande à « receptionne » si tout est couvert.
 */
const ancienParcours = async (db: PGlite, shipmentId: string, lignes: { product_id: string; quantity: number; unit_cost_ht: number }[]) => {
  const r = await srv(db, `SELECT reception_create('Fournisseur', '2026-11-11'::date, NULL, true, $1::jsonb) AS id`, [JSON.stringify(lignes)]);
  if (r.error || !r.rows[0]?.id) return { redirect: 'new', erreur: r.error, avertissement: false };
  let avertissement = false; let toutCouvert = true;
  const items = (await srv(db, `SELECT id, product_id, quantity, received_quantity FROM shipment_items WHERE shipment_id = $1`, [shipmentId])).rows;
  for (const it of items) {
    const recu = lignes.find(l => l.product_id === it.product_id)?.quantity ?? 0; const nouveau = (it.received_quantity ?? 0) + recu;
    if (recu > 0) { const u = await srv(db, `UPDATE shipment_items SET received_quantity = $1 WHERE id = $2`, [nouveau, it.id]); if (u.error) avertissement = true; }
    if (nouveau < it.quantity) toutCouvert = false;
  }
  if (toutCouvert) { const s = await srv(db, `UPDATE shipments SET status = 'receptionne' WHERE id = $1`, [shipmentId]); if (s.error) avertissement = true; }
  return { redirect: 'receptions', erreur: '', avertissement };
};
const acl = async (db: PGlite) => (await exec(db, `SELECT p.proname, (SELECT string_agg(coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY a.grantee::regrole::text) FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) AS droits
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('reception_create', 'reception_update', 'reception_delete') ORDER BY 1`));

test.describe('Gel vs code actuellement déployé : aucun stock, aucune réception, aucun cumul ne peut être écrit par l\'ancien parcours', () => {
  const lignesDe = (c: { ids: string[] }, p: string, q: number) => [{ product_id: p, quantity: q, unit_cost_ht: 5 }];
  for (const migre of [false, true]) {
    test(`ancien parcours, base GELÉE ${migre ? 'APRÈS' : 'AVANT'} la migration : la base refuse avant la moindre écriture (ni stock, ni réception, ni PUMP, ni cumul, ni statut)`, async () => {
      const db = await baseAchats(false); const p = await produit(db, 'A', 7); const c = await commande(db, [{ p, q: 100 }]);
      await db.exec(GEL); if (migre) await db.exec(MIGRATION);
      const avant = await photo(db); const statut = (await un(db, `SELECT status FROM shipments WHERE id = $1`, [c.s])).status;
      for (const q of [10, 100]) {                                                                             // 100 = la quantité qui aurait soldé la commande
        const r = await ancienParcours(db, c.s, lignesDe(c, p, q));
        expect(r.redirect).toBe('new'); expect(r.erreur).toContain('permission denied');                         // refusé au niveau de la base, avant d'exécuter la fonction
      }
      expect(await photo(db)).toEqual(avant);                                                                  // stock, réceptions, cumuls : strictement inchangés
      expect((await un(db, `SELECT status FROM shipments WHERE id = $1`, [c.s])).status).toBe(statut);
      expect((await un(db, `SELECT prix_achat_moyen_ht FROM products WHERE id = $1`, [p])).prix_achat_moyen_ht).toBeNull();   // le PUMP non plus
      for (const [q, a] of [[`SELECT reception_update($1::uuid, 'F', '2026-11-11'::date, 'x', true, '[]'::jsonb)`, [ADMIN_ID]], [`SELECT reception_delete($1::uuid)`, [ADMIN_ID]]] as [string, unknown[]][])
        expect((await srv(db, q, a)).error).toContain('permission denied');                                    // correction et suppression : idem
      await db.close();
    });
  }

  test('PREUVE de la nécessité du gel : sans lui, après la migration, l\'ancien parcours augmente le stock puis échoue sur le cumul (et peut même marquer la commande « receptionne »)', async () => {
    const db = await baseAchats(true); const p = await produit(db, 'A', 0); const c = await commande(db, [{ p, q: 100 }]);
    const r = await ancienParcours(db, c.s, lignesDe(c, p, 100));
    expect(r.redirect).toBe('receptions'); expect(r.avertissement).toBe(true);
    expect((await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s).toBe(100);           // stock modifié...
    expect((await un(db, `SELECT received_quantity r FROM shipment_items WHERE id = $1`, [c.ids[0]])).r).toBeNull();   // ...mais cumul non écrit (CUMUL_PROTEGE)
    expect((await un(db, `SELECT status FROM shipments WHERE id = $1`, [c.s])).status).toBe('receptionne');    // et statut posé : c'est exactement ce que le gel empêche
    await db.close();
  });

  test('droits EFFECTIFS : même si une fonction était ouverte à PUBLIC, le gel la ferme à tous (service_role, anon, authenticated, PUBLIC)', async () => {
    const db = await baseAchats(false);
    await db.exec(`GRANT EXECUTE ON FUNCTION reception_create(text, date, text, boolean, jsonb, uuid), reception_update(uuid, text, date, text, boolean, jsonb, uuid), reception_delete(uuid) TO PUBLIC`);
    expect((await un(db, `SELECT has_function_privilege('anon', 'reception_delete(uuid)', 'EXECUTE') a`)).a).toBe(true);   // état de départ du cas défavorable : ouvert à tous
    await db.exec(GEL);
    for (const f of ['reception_create(text, date, text, boolean, jsonb, uuid)', 'reception_update(uuid, text, date, text, boolean, jsonb, uuid)', 'reception_delete(uuid)'])
      for (const r of ['anon', 'authenticated', 'service_role']) expect((await un(db, `SELECT has_function_privilege('${r}', '${f}', 'EXECUTE') a`)).a, `${r} ${f}`).toBe(false);
    expect((await acl(db)).every(x => !String(x.droits).includes('PUBLIC'))).toBe(true);
    await db.close();
  });

  test('droit HÉRITÉ : si service_role appartenait à un autre rôle autorisé, le script s\'arrête (GEL_INEFFICACE) et n\'applique RIEN — on le sait avant d\'aller plus loin', async () => {
    const db = await baseAchats(false);
    await db.exec(`CREATE ROLE relais NOLOGIN; GRANT EXECUTE ON FUNCTION reception_create(text, date, text, boolean, jsonb, uuid) TO relais; GRANT relais TO service_role`);
    let erreur = ''; try { await db.exec(GEL); } catch (e: any) { erreur = String(e.message ?? e); }
    await db.exec('ROLLBACK');
    expect(erreur).toContain('GEL_INEFFICACE'); expect(erreur).toContain('relais');
    expect((await un(db, `SELECT has_function_privilege('service_role', 'reception_create(text, date, text, boolean, jsonb, uuid)', 'EXECUTE') a`)).a).toBe(true);   // rien n'a changé : gel NON posé
    await db.close();
  });

  test('DÉGEL : ne rend que service_role, restaure exactement les droits d\'avant le gel, et refuse (DEGEL_REFUSE, tout annulé) si un autre rôle a un droit inattendu', async () => {
    const db = await baseAchats(false);
    const origine = await acl(db);
    await db.exec(GEL); expect((await acl(db)).every(x => !String(x.droits).includes('service_role'))).toBe(true);
    await db.exec(DEGEL);
    expect(await acl(db)).toEqual(origine);                                                                // droits strictement identiques à l'état d'avant le gel
    for (const r of ['anon', 'authenticated']) expect((await un(db, `SELECT has_function_privilege('${r}', 'reception_create(text, date, text, boolean, jsonb, uuid)', 'EXECUTE') a`)).a).toBe(false);
    await db.exec(GEL);
    await db.exec(`GRANT EXECUTE ON FUNCTION reception_delete(uuid) TO authenticated`);                      // état inattendu pendant le gel
    let erreur = ''; try { await db.exec(DEGEL); } catch (e: any) { erreur = String(e.message ?? e); }
    await db.exec('ROLLBACK');
    expect(erreur).toContain('DEGEL_REFUSE');
    expect((await srv(db, `SELECT reception_delete(gen_random_uuid())`)).error).toContain('permission denied');   // les fonctions restent gelées
    await db.close();
  });

  test('APRÈS le dégel (base migrée, nouveau code) : aucun contournement — les fonctions historiques ne rattachent rien à une commande, ne touchent ni cumul ni lignes de commande, et ne modifient pas une réception de commande', async () => {
    const db = await baseAchats(true); const p = await produit(db, 'A', 0); const c = await commande(db, [{ p, q: 100 }]);
    await db.exec(GEL); await db.exec(DEGEL);
    // la nouvelle opération atomique reste la seule voie pour une réception de commande
    const r = await srv(db, `SELECT reception_commande_enregistrer($1::uuid, $2::uuid, ((now() AT TIME ZONE 'UTC') + interval '4 hours')::date, NULL, NULL, $3::jsonb, $4::uuid, 'admin@inca.re', 'admin') AS r`,
      [crypto.randomUUID(), c.s, JSON.stringify([{ shipment_item_id: c.ids[0], quantity: 40, unit_cost_ht: 5 }]), ADMIN_ID]);
    expect(r.error).toBe(''); const liee = r.rows[0].r.reception_id as string;
    const avant = await photo(db);
    expect((await srv(db, `SELECT reception_update($1::uuid, 'F', '2026-11-11'::date, 'x', true, $2::jsonb)`, [liee, JSON.stringify([{ product_id: p, quantity: 5, unit_cost_ht: 5 }])])).error).not.toBe('');   // correction d'une réception de commande : refusée
    expect((await srv(db, `SELECT reception_delete($1::uuid)`, [liee])).error).not.toBe('');                // suppression : refusée
    expect(await photo(db)).toEqual(avant);
    // une réception libre fonctionne normalement mais ne peut ni toucher la commande ni son cumul
    const s0 = (await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s;
    const libre = (await srv(db, `SELECT reception_create('Fournisseur', '2026-11-11'::date, 'libre', true, $1::jsonb) AS id`, [JSON.stringify([{ product_id: p, quantity: 12, unit_cost_ht: 5 }])])).rows[0].id as string;
    expect((await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s).toBe(s0 + 12);
    expect((await un(db, `SELECT shipment_id, cle_idempotence FROM stock_receptions WHERE id = $1`, [libre]))).toEqual({ shipment_id: null, cle_idempotence: null });   // jamais rattachée à une commande
    expect((await un(db, `SELECT received_quantity r FROM shipment_items WHERE id = $1`, [c.ids[0]])).r).toBe(40);                                     // cumul inchangé
    expect((await srv(db, `UPDATE stock_receptions SET shipment_id = $1 WHERE id = $2`, [c.s, libre])).error).not.toBe('');                           // impossible de la rattacher après coup
    await db.close();
  });
});

test.describe('Contrôle « aucune opération en cours » (lecture seule)', () => {
  const sections = AVANT_MIGRATION.split(/-- ═══ \d\./).slice(1).map(b => b.slice(b.indexOf('\n') + 1));
  test('lecture seule ; renvoie 0 ligne quand tout est calme ; détecte une transaction ouverte, une réception récente et l\'absence de gel', async () => {
    expect(sections).toHaveLength(5);
    expect(AVANT_MIGRATION.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
    const db = await baseAchats(false);
    const p = await produit(db, 'A', 0);
    const verifier = async () => { const r: any[][] = []; for (const s of sections) r.push((await db.exec(s))[0].rows); return r; };
    let r = await verifier();
    expect(r[3][0]).toEqual({ receptions_15min: 0, commandes_15min: 0, journal_achats_15min: 0 });
    expect(r[4][0]).toEqual({ gel_actif: false });                                                        // pas encore gelé : le contrôle le dit
    await db.exec(GEL); expect((await verifier())[4][0]).toEqual({ gel_actif: true });
    await db.exec(DEGEL);
    await srv(db, `SELECT reception_create('F', now()::date, 'récente', true, $1::jsonb)`, [JSON.stringify([{ product_id: p, quantity: 1, unit_cost_ht: 4 }])]);
    r = await verifier(); expect(r[3][0].receptions_15min).toBe(1);                                      // une réception de moins de 15 minutes est signalée
    await db.close();
  });
});

test.describe('Gardes SERVEUR : chaque point d\'écriture contrôle l\'état avant d\'agir', () => {
  const ordre = (src: string, avant: string | RegExp, apres: string | RegExp, nom: string) => {
    const a = typeof avant === 'string' ? src.indexOf(avant) : src.search(avant); const b = typeof apres === 'string' ? src.indexOf(apres) : src.search(apres);
    expect(a, `${nom} : garde absente`).toBeGreaterThan(-1); expect(b, `${nom} : action absente`).toBeGreaterThan(-1); expect(a, `${nom} : la garde doit précéder l'action`).toBeLessThan(b);
  };
  test('pages : réception, détail (corrections), modification, liste (statut, suppression)', () => {
    const rc = lire('src/pages/admin/achats/[id]/reception.astro');
    ordre(rc, 'await etatTransition()', 'chargerCommande(id)', 'reception.astro'); ordre(rc, 'ecritureAutorisee(transition)', 'traiterReception(', 'reception.astro (envoi)');
    const dt = lire('src/pages/admin/achats/[id]/index.astro');
    ordre(dt, 'await etatTransition()', 'traiterCorrection(', 'détail'); ordre(dt, 'if (!ecritureOk) return Astro.redirect', 'traiterCorrection(', 'détail (envoi)');
    expect(dt).toContain('{ecritureOk && c.status !== \'annule\' && !e.historique && ('); expect(dt).toContain('{ecritureOk && !r.annulee_le && (');           // aucun bouton d'écriture hors état actif
    const ed = lire('src/pages/admin/achats/[id]/edit.astro');
    ordre(ed, 'ecritureAutorisee(transition)', /Astro\.request\.method === 'POST'/, 'modification'); ordre(ed, 'ecritureAutorisee(transition)', /supabaseAdmin\s*\./, 'modification (1er accès aux données)');
    const li = lire('src/pages/admin/achats.astro');
    ordre(li, "(action === 'set_status' || action === 'delete') && !ecritureOk", "if (action === 'set_status') {", 'liste (statut)'); ordre(li, "(action === 'set_status' || action === 'delete') && !ecritureOk", "if (action === 'delete') {", 'liste (suppression)');
    expect(lire('src/components/admin/CommandeAccordeon.astro')).toContain("ecritureOk && s.etat.statut !== 'integrale'");     // le bouton vit dans le composant de la liste
  });

  test('routes historiques de réception (création, correction, suppression) : garde après le contrôle administrateur et avant tout accès aux données', () => {
    for (const f of ['src/pages/api/admin/reception/create.ts', 'src/pages/api/admin/reception/[id]/update.ts', 'src/pages/api/admin/reception/[id]/delete.ts']) {
      const s = lire(f);
      ordre(s, '!isAdmin(user)', 'receptionLibreAutorisee(await etatTransition())', f + ' (admin d\'abord)');
      ordre(s, 'receptionLibreAutorisee(await etatTransition())', /formData\(\)|supabaseAdmin\s*\./, f);
    }
  });

  test('aucun contournement : l\'état ne dépend ni de l\'URL, ni d\'un cookie, ni d\'un champ de formulaire ; il est lu SANS argument dans chaque page', () => {
    const fichiers = ['src/pages/admin/achats.astro', 'src/pages/admin/achats/[id]/index.astro', 'src/pages/admin/achats/[id]/reception.astro', 'src/pages/admin/achats/[id]/edit.astro',
      'src/pages/api/admin/reception/create.ts', 'src/pages/api/admin/reception/[id]/update.ts', 'src/pages/api/admin/reception/[id]/delete.ts'];
    for (const f of fichiers) { const s = lire(f); const appels = s.match(/etatTransition\([^)]*\)/g) ?? []; expect(appels.length, f).toBeGreaterThan(0); for (const a of appels) expect(a, f).toBe('etatTransition()'); }
    const m = lire('src/lib/achatsTransition.ts').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(m).not.toMatch(/searchParams|cookies|formData|headers/);
  });
});

test.describe('Gel de la base : message clair côté site', () => {
  test('quand la base refuse une réception libre (gel, permission denied 42501), le site l\'explique et n\'enregistre rien', () => {
    for (const f of ['src/pages/api/admin/reception/create.ts', 'src/pages/api/admin/reception/[id]/update.ts', 'src/pages/api/admin/reception/[id]/delete.ts']) {
      const s = lire(f); expect(s, f).toContain("rpcErr?.code === '42501'"); expect(s, f).toContain('/admin/reception?err=suspendu');
    }
    expect(lire('src/pages/admin/reception.astro')).toContain("get('err') === 'suspendu'");
  });
});

test.describe('Ancienne page encore ouverte dans un navigateur', () => {
  test('l\'ancien formulaire de réception d\'une commande (product_id[], shipment_id) ne déclenche AUCUNE écriture : le nouveau serveur le détourne avant tout accès aux données', () => {
    const s = lire('src/pages/api/admin/reception/create.ts');
    const garde = s.indexOf("form.get('shipment_id')"); expect(garde, 'le champ shipment_id de l\'ancien formulaire est lu').toBeGreaterThan(-1);
    const redirige = s.slice(garde, garde + 700); expect(redirige).toMatch(/Response\.redirect\(new URL\(`\/admin\/achats\/\$\{[^}]*\}\/reception`/);   // renvoi vers le nouveau parcours
    const premiereEcriture = s.search(/supabaseAdmin\s*\.\s*(rpc|from)\(/); expect(garde).toBeLessThan(premiereEcriture);
    expect(lire('src/pages/admin/reception/new.astro')).toMatch(/if \(shipmentId\) return Astro\.redirect\(`\/admin\/achats\/\$\{encodeURIComponent\(shipmentId\)\}\/reception`\)/);
  });

  test('l\'ancien formulaire posté vers le nouveau gestionnaire : refusé (« Formulaire incomplet ») sans aucun appel à la base', async () => {
    const appels: string[] = [];
    const depot: DepotPortefeuille = { async rpc(nom) { appels.push(nom); return { data: null, error: null }; }, async trouverCompte() { return { data: null, error: null }; } } as unknown as DepotPortefeuille;
    const a = creerAchats(depot);
    const F = class { constructor(private d: Record<string, unknown[]>) {} get(n: string) { return this.d[n]?.[0]; } getAll(n: string) { return this.d[n] ?? []; } };
    const ancien = new F({ supplier_name: ['Fournisseur'], received_at: ['2026-11-11'], shipment_id: ['2f1712b0-dff2-416d-b2e1-8293061af20b'], 'product_id[]': ['p1', 'p2'], 'quantity[]': ['10', '5'], 'unit_cost_ht[]': ['4', '5'], 'dlc[]': ['', ''] });
    const r = await traiterReception(a, ADMIN, '2f1712b0-dff2-416d-b2e1-8293061af20b', ancien as any);
    expect(r.ok).toBe(false); expect(r.message).toContain('Formulaire incomplet');
    expect((await traiterCorrection(a, ADMIN, new F({ operation: ['supprimer_cumul'], ligne_id: ['x'] }) as any)).ok).toBe(false);          // opération inconnue : refusée
    expect(appels).toEqual([]);                                                                           // aucune fonction de la base n'a été appelée
  });

  test('l\'ancien écran de modification d\'une commande déjà reçue ne recrée jamais les lignes (cumul préservé), même sans la garde de transition', () => {
    const s = lire('src/pages/admin/achats/[id]/edit.astro');
    expect(s.indexOf('if (verrouillee) {')).toBeGreaterThan(-1); expect(s.indexOf('if (verrouillee) {')).toBeLessThan(s.indexOf(".from('shipment_items')" + '.delete()'));
  });

  test('base de données : même si un ancien code atteignait la base, l\'écriture à la main du cumul et la suppression d\'une ligne reçue sont refusées', async () => {
    const db = await baseAchats(true);
    const p = await produit(db, 'A', 0); const c = await commande(db, [{ p, q: 100 }]);
    expect((await srv(db, `SELECT reception_commande_enregistrer($1::uuid, $2::uuid, ((now() AT TIME ZONE 'UTC') + interval '4 hours')::date, NULL, NULL, $3::jsonb, $4::uuid, 'admin@inca.re', 'admin')`,
      [crypto.randomUUID(), c.s, JSON.stringify([{ shipment_item_id: c.ids[0], quantity: 40, unit_cost_ht: 5 }]), ADMIN_ID])).error).toBe('');
    expect((await srv(db, `UPDATE shipment_items SET received_quantity = 100 WHERE id = $1`, [c.ids[0]])).error).toContain('CUMUL_PROTEGE');
    expect((await srv(db, `DELETE FROM shipment_items WHERE shipment_id = $1`, [c.s])).error).toContain('LIGNE_RECUE_NON_SUPPRIMABLE');
    await db.close();
  });
});
