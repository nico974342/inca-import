/**
 * Réceptions : modifier ou supprimer une réception n'applique QUE la différence de quantité. Base locale PGlite (vrai PostgreSQL) avec les VRAIES migrations ;
 * l'ANCIENNE fonction est d'abord reproduite (anomalie), puis la migration receptions_stock_differentiel.sql est appliquée. Aucune écriture en production.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import type { PGlite } from '@electric-sql/pglite';
import { baseAchats, lire, un, exec, produit } from './helpers/receptionsBase';

const MIGRATION = lire('receptions_stock_differentiel.sql');
let n = 0;

const stock = async (db: PGlite, p: string) => (await un(db, `SELECT stock_quantity, in_stock, prix_achat_moyen_ht FROM products WHERE id=$1`, [p]));
const creer = async (db: PGlite, lignes: { p: string; q: number; c?: number }[], appliquee = true) =>
  (await un(db, `SELECT reception_create('Fournisseur', '2026-10-28', NULL, $1, $2::jsonb) AS id`, [appliquee, JSON.stringify(lignes.map(l => ({ product_id: l.p, quantity: l.q, unit_cost_ht: l.c ?? 5 })))])).id as string;
const modifier = (db: PGlite, rec: string, lignes: { p: string; q: number; c?: number }[], appliquee = true) =>
  db.query(`SELECT reception_update($1, 'Fournisseur', '2026-10-28', NULL, $2, $3::jsonb)`, [rec, appliquee, JSON.stringify(lignes.map(l => ({ product_id: l.p, quantity: l.q, unit_cost_ht: l.c ?? 5 })))]);
/** Vente livrée : le stock physique baisse (comme order_set_status → livree). */
const livrer = (db: PGlite, p: string, q: number) => db.query(`UPDATE products SET stock_quantity = stock_quantity - $2, in_stock = stock_quantity - $2 > 0 WHERE id=$1`, [p, q]);
/** Commande en cours : réserve q cartons sans toucher au stock physique. */
const reserver = async (db: PGlite, p: string, q: number, statut = 'en_attente') => {
  const o = (await un(db, `INSERT INTO orders (status) VALUES ($1) RETURNING id`, [statut])).id;
  await db.query(`INSERT INTO order_items (order_id, product_id, product_name, quantity) VALUES ($1,$2,'x',$3)`, [o, p, q]);
};
const reserve = async (db: PGlite, p: string) => (await un(db, `SELECT coalesce(reserved,0)::int AS r, available::int AS a FROM product_availability WHERE product_id=$1`, [p]));
const refuse = async (f: Promise<unknown>) => { let msg = ''; try { await f; } catch (e: any) { msg = e.message; } return msg; };
const nom = () => `Bum-Bum ${++n}`;

test.describe('Anomalie reproduite sur l\'ancienne fonction', () => {
  test('ANCIEN : 120 reçus, 90 vendus, simple correction de prix → le stock remonte à 120 (90 cartons recréés)', async () => {
    const db = await baseAchats(false);
    try {
      const p = await produit(db, nom(), 0); const r = await creer(db, [{ p, q: 120, c: 7.92 }]);
      await livrer(db, p, 90); expect((await stock(db, p)).stock_quantity).toBe(30);
      await modifier(db, r, [{ p, q: 120, c: 8.5 }]);                      // prix seul
      expect((await stock(db, p)).stock_quantity).toBe(120);               // ← l'anomalie
    } finally { await db.close(); }
  });
});

test.describe('Réception modifiée : seule la différence est appliquée (après migration)', () => {
  let db: PGlite;
  test.beforeEach(async () => { db = await baseAchats(false); await db.exec(MIGRATION); });
  test.afterEach(async () => { await db.close(); });

  test('prix seul : stock et réservations inchangés, coût moyen recalculé', async () => {
    const p = await produit(db, nom(), 0); const r = await creer(db, [{ p, q: 120, c: 7.92 }]);
    await livrer(db, p, 90); await reserver(db, p, 10);
    const avant = await reserve(db, p);
    await modifier(db, r, [{ p, q: 120, c: 8.5 }]);
    const s = await stock(db, p);
    expect(s.stock_quantity).toBe(30); expect(s.in_stock).toBe(true); expect(Number(s.prix_achat_moyen_ht)).toBe(8.5);
    expect(await reserve(db, p)).toEqual(avant);
  });

  test('quantité en plus ou en moins : uniquement l\'écart, les ventes intermédiaires sont conservées', async () => {
    const p = await produit(db, nom(), 0); const r = await creer(db, [{ p, q: 120 }]);
    await livrer(db, p, 90);                                               // 30
    await modifier(db, r, [{ p, q: 130 }]); expect((await stock(db, p)).stock_quantity).toBe(40);
    await livrer(db, p, 15);                                               // 25
    await modifier(db, r, [{ p, q: 110 }]); expect((await stock(db, p)).stock_quantity).toBe(5);   // 25 − 20
    expect((await un(db, `SELECT quantity FROM stock_reception_items WHERE reception_id=$1`, [r])).quantity).toBe(110);
  });

  test('deux réceptions du même produit : modifier l\'une ne touche pas ce que l\'autre a apporté', async () => {
    const p = await produit(db, nom(), 0); const r1 = await creer(db, [{ p, q: 100, c: 5 }]); await creer(db, [{ p, q: 50, c: 6 }]);
    await livrer(db, p, 120);                                              // 30
    await modifier(db, r1, [{ p, q: 100, c: 4 }]);
    expect((await stock(db, p)).stock_quantity).toBe(30);
    expect(Number((await stock(db, p)).prix_achat_moyen_ht)).toBeCloseTo((100 * 4 + 50 * 6) / 150, 3);
  });

  test('quantité réduite au-delà du stock restant : REFUSÉ, rien n\'est écrit', async () => {
    const p = await produit(db, nom(), 0); const r = await creer(db, [{ p, q: 120, c: 7.92 }]);
    await livrer(db, p, 90);
    const msg = await refuse(modifier(db, r, [{ p, q: 20, c: 9 }]));       // retirerait 100, il en reste 30
    expect(msg).toContain('STOCK_INSUFFISANT_RECEPTION');
    expect((await stock(db, p)).stock_quantity).toBe(30);
    expect(Number((await stock(db, p)).prix_achat_moyen_ht)).toBe(7.92);   // le prix non plus n'a pas bougé
    expect((await un(db, `SELECT quantity, unit_cost_ht FROM stock_reception_items WHERE reception_id=$1`, [r])).quantity).toBe(120);
  });

  test('ne descend jamais sous les quantités réservées', async () => {
    const p = await produit(db, nom(), 0); const r = await creer(db, [{ p, q: 100 }]);
    await livrer(db, p, 50); await reserver(db, p, 40);                    // physique 50, réservé 40, disponible 10
    expect(await refuse(modifier(db, r, [{ p, q: 80 }]))).toContain('STOCK_INSUFFISANT_RECEPTION');   // 50 − 20 = 30 < 40
    await modifier(db, r, [{ p, q: 90 }]);                                                            // 50 − 10 = 40 ≥ 40
    expect((await stock(db, p)).stock_quantity).toBe(40); expect((await reserve(db, p)).a).toBe(0);
    await reserver(db, p, 5, 'annulee'); await reserver(db, p, 5, 'livree');                          // statuts non réservants : sans effet
    expect((await reserve(db, p)).r).toBe(40);
  });

  test('plusieurs produits : si UN seul est refusé, aucun produit n\'est modifié (atomique)', async () => {
    const a = await produit(db, nom(), 0), b = await produit(db, nom(), 0); const r = await creer(db, [{ p: a, q: 50 }, { p: b, q: 50 }]);
    await livrer(db, b, 45);                                               // a : 50, b : 5
    expect(await refuse(modifier(db, r, [{ p: a, q: 60 }, { p: b, q: 30 }]))).toContain('STOCK_INSUFFISANT_RECEPTION');   // a +10 serait bon, b −20 impossible
    expect((await stock(db, a)).stock_quantity).toBe(50); expect((await stock(db, b)).stock_quantity).toBe(5);
    await modifier(db, r, [{ p: a, q: 60 }, { p: b, q: 48 }]);             // a +10, b −2
    expect((await stock(db, a)).stock_quantity).toBe(60); expect((await stock(db, b)).stock_quantity).toBe(3);
  });

  test('produit retiré ou ajouté dans la réception : seul son effet propre', async () => {
    const a = await produit(db, nom(), 0), b = await produit(db, nom(), 0), c = await produit(db, nom(), 0); const r = await creer(db, [{ p: a, q: 20 }, { p: b, q: 10 }]);
    await modifier(db, r, [{ p: a, q: 20 }, { p: c, q: 7 }]);              // b retiré (−10), c ajouté (+7)
    expect((await stock(db, a)).stock_quantity).toBe(20); expect((await stock(db, b)).stock_quantity).toBe(0); expect((await stock(db, b)).in_stock).toBe(false); expect((await stock(db, c)).stock_quantity).toBe(7);
  });

  test('réception historique (sans effet sur le stock) : jamais de mouvement ; passage historique ↔ appliquée = effet réel seulement', async () => {
    const p = await produit(db, nom(), 12); const r = await creer(db, [{ p, q: 100 }], false);
    expect((await stock(db, p)).stock_quantity).toBe(12);
    await modifier(db, r, [{ p, q: 150, c: 9 }], false); expect((await stock(db, p)).stock_quantity).toBe(12);
    await modifier(db, r, [{ p, q: 150 }], true);  expect((await stock(db, p)).stock_quantity).toBe(162);     // devient appliquée : +150
    await modifier(db, r, [{ p, q: 150 }], false); expect((await stock(db, p)).stock_quantity).toBe(12);      // redevient historique : −150
  });

  test('entrées invalides refusées (aucune ligne, quantité nulle)', async () => {
    const p = await produit(db, nom(), 0); const r = await creer(db, [{ p, q: 10 }]);
    expect(await refuse(db.query(`SELECT reception_update($1,'F','2026-10-28',NULL,true,'[]'::jsonb)`, [r]))).toContain('RECEPTION_VIDE');
    expect(await refuse(modifier(db, r, [{ p, q: 0 }]))).toContain('QUANTITE_INVALIDE');
    expect((await stock(db, p)).stock_quantity).toBe(10);
  });
});

test.describe('Réception supprimée', () => {
  let db: PGlite;
  test.beforeEach(async () => { db = await baseAchats(false); await db.exec(MIGRATION); });
  test.afterEach(async () => { await db.close(); });

  test('stock suffisant : retire exactement la quantité reçue ; la suite des ventes est conservée', async () => {
    const p = await produit(db, nom(), 0); const r1 = await creer(db, [{ p, q: 40 }]); await creer(db, [{ p, q: 100 }]); await livrer(db, p, 30);   // 110
    await db.query(`SELECT reception_delete($1)`, [r1]);
    expect((await stock(db, p)).stock_quantity).toBe(70);
    expect((await un(db, `SELECT count(*)::int n FROM stock_receptions WHERE id=$1`, [r1])).n).toBe(0);
  });

  test('marchandise déjà vendue : suppression REFUSÉE (plus de retrait partiel silencieux), réception et stock intacts', async () => {
    const p = await produit(db, nom(), 0); const r = await creer(db, [{ p, q: 120 }]); await livrer(db, p, 90);
    expect(await refuse(db.query(`SELECT reception_delete($1)`, [r]))).toContain('STOCK_INSUFFISANT_RECEPTION');
    expect((await stock(db, p)).stock_quantity).toBe(30); expect((await un(db, `SELECT count(*)::int n FROM stock_receptions WHERE id=$1`, [r])).n).toBe(1);
  });

  test('réservé : refusée si le stock descendrait sous le réservé ; réception historique : toujours supprimable sans mouvement', async () => {
    const p = await produit(db, nom(), 0); const r = await creer(db, [{ p, q: 50 }]); await reserver(db, p, 30);
    expect(await refuse(db.query(`SELECT reception_delete($1)`, [r]))).toContain('STOCK_INSUFFISANT_RECEPTION');   // 50 − 50 < 30
    const q = await produit(db, nom(), 8); const h = await creer(db, [{ p: q, q: 100 }], false);
    await db.query(`SELECT reception_delete($1)`, [h]); expect((await stock(db, q)).stock_quantity).toBe(8);
  });

  test('réception introuvable : message « not found » conservé (l\'interface s\'en sert)', async () => {
    expect(await refuse(db.query(`SELECT reception_delete(gen_random_uuid())`))).toContain('not found');
  });
});

test.describe('Droits, verrous et compatibilité', () => {
  test('droits : service_role seul peut exécuter les fonctions (anon et authenticated refusés), search_path fixé, aucune élévation de droits', async () => {
    const db = await baseAchats(false);
    try {
      await db.exec(MIGRATION);
      const p = await produit(db, nom(), 0); const r = await creer(db, [{ p, q: 5 }]);
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        for (const q of [`SELECT reception_update('${r}','F','2026-10-28',NULL,true,'[]'::jsonb)`, `SELECT reception_delete('${r}')`, `SELECT * FROM reception_ecarts_stock('${r}',true,false,NULL)`])
          expect(await refuse(db.query(q)), `${role} : ${q}`).toMatch(/permission denied/);
        await db.exec('RESET ROLE');
      }
      const f = await exec(db, `SELECT proname, prosecdef, proconfig::text cfg, proacl::text acl FROM pg_proc WHERE proname IN ('reception_update','reception_delete','reception_ecarts_stock','reception_verifier_ecarts') ORDER BY 1`);
      expect(f).toHaveLength(4);
      for (const x of f) { expect(x.prosecdef).toBe(false); expect(x.cfg).toContain('search_path'); expect(x.acl).toContain('service_role'); expect(x.acl).not.toMatch(/anon|authenticated|(^\{|,)=X/); }
      await db.exec('SET ROLE service_role');
      await modifier(db, r, [{ p, q: 6 }]); expect((await stock(db, p)).stock_quantity).toBe(6);
      await db.exec('RESET ROLE');
    } finally { await db.close(); }
  });

  test('verrous : réception puis produits verrouillés dans l\'ordre des identifiants avant toute lecture du stock (pas d\'interblocage, pas de mise à jour perdue)', () => {
    const corps = (nom: string) => MIGRATION.slice(MIGRATION.indexOf(`FUNCTION public.${nom}(`));
    for (const f of ['reception_update', 'reception_delete']) {
      const c = corps(f); const rec = c.indexOf('FROM stock_receptions WHERE id = p_reception_id FOR UPDATE'); const prod = c.indexOf('FROM products WHERE id = ANY (v_pids) ORDER BY id FOR UPDATE');
      const verif = c.indexOf('reception_verifier_ecarts('); const maj = c.indexOf('UPDATE products p');
      expect(rec).toBeGreaterThan(-1); expect(prod).toBeGreaterThan(rec); expect(verif).toBeGreaterThan(prod); expect(maj).toBeGreaterThan(verif);
    }
    expect(MIGRATION).not.toMatch(/GREATEST\(0, p\.stock_quantity/);          // plus aucun blocage à 0 qui masque une différence
    expect(MIGRATION).toMatch(/stock_quantity \+ e\.ecart/);                  // mise à jour relative atomique, jamais une valeur lue puis réécrite
  });

  test('compatibilité avec la migration des réceptions partielles (branche feat/achats-receptions-partielles, non fusionnée) : les deux ordres d\'application', async () => {
    let partielles = '';
    try { partielles = execSync('git show feat/achats-receptions-partielles:supabase/migrations/achats_receptions_partielles.sql', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }); } catch { /* branche absente */ }
    test.skip(!partielles, 'branche des réceptions partielles absente');
    for (const ordre of ['correctif_puis_partielles', 'partielles_puis_correctif']) {
      const db = await baseAchats(false);
      try {
        if (ordre === 'correctif_puis_partielles') { await db.exec(MIGRATION); await db.exec(partielles); } else { await db.exec(partielles); await db.exec(MIGRATION); }
        // réception historique (non rattachée) : le correctif s'applique, les protections de la migration partielle ne la bloquent pas
        const p = await produit(db, nom(), 0); const r = await creer(db, [{ p, q: 120, c: 7.92 }]); await livrer(db, p, 90);
        await modifier(db, r, [{ p, q: 120, c: 8.5 }]); expect((await stock(db, p)).stock_quantity, ordre).toBe(30);
        expect(await refuse(modifier(db, r, [{ p, q: 20 }])), ordre).toContain('STOCK_INSUFFISANT_RECEPTION');
        // réception rattachée à une commande : la base refuse toute modification manuelle (inchangé), et le correctif ne la contourne pas
        await db.query(`INSERT INTO auth.users DEFAULT VALUES`); const s = (await un(db, `INSERT INTO shipments (supplier_name, reference, status) VALUES ('F','R-${ordre}','en_transit') RETURNING id`)).id;
        const l = (await un(db, `INSERT INTO stock_receptions (supplier_name, received_at, stock_applied, shipment_id, cle_idempotence, created_by, created_by_email) VALUES ('F','2026-10-28',true,$1, gen_random_uuid(), (SELECT id FROM auth.users LIMIT 1), 'a@test.local') RETURNING id`, [s])).id as string;
        await db.query(`SET inca.achats_ecriture='1'`); await db.query(`INSERT INTO stock_reception_items (reception_id, product_id, quantity, unit_cost_ht) VALUES ($1,$2,10,5)`, [l, p]); await db.query(`RESET inca.achats_ecriture`);
        await db.query(`UPDATE products SET stock_quantity = stock_quantity + 10 WHERE id=$1`, [p]);
        expect(await refuse(modifier(db, l, [{ p, q: 11 }])), ordre).toMatch(/RECEPTION_LIEE_COMMANDE/);
        expect(await refuse(db.query(`SELECT reception_delete($1)`, [l])), ordre).toMatch(/RECEPTION_LIEE_COMMANDE/);
        expect((await stock(db, p)).stock_quantity, ordre).toBe(40);
      } finally { await db.close(); }
    }
  });
});

test.describe('Affichage du refus', () => {
  test('le refus de la base devient un message lisible sur la page des réceptions (modification et suppression), sans passer par une page blanche', async () => {
    const { messageRefusStock, urlRefusStock } = await import('../src/lib/receptionErreur');
    const db = await baseAchats(false);
    try {
      await db.exec(MIGRATION);
      const p = await produit(db, nom(), 0); const r = await creer(db, [{ p, q: 120 }]); await livrer(db, p, 90);
      const texte = messageRefusStock({ message: await refuse(modifier(db, r, [{ p, q: 20 }])) });
      expect(texte).toMatch(/retirerait 100 carton\(s\)/); expect(texte).toContain('stock est de 30'); expect(texte).not.toContain('STOCK_INSUFFISANT');
      expect(messageRefusStock({ message: 'autre erreur' })).toBeNull(); expect(messageRefusStock(null)).toBeNull();
      expect(urlRefusStock('/admin/reception', 'a b')).toBe('/admin/reception?err=stock&msg=a%20b');
    } finally { await db.close(); }
    const { readFileSync } = await import('node:fs'); const lire2 = (f: string) => readFileSync(f, 'utf8');
    for (const f of ['src/pages/api/admin/reception/[id]/update.ts', 'src/pages/api/admin/reception/[id]/delete.ts']) expect(lire2(f)).toContain('messageRefusStock(rpcErr)');
    expect(lire2('src/pages/admin/reception.astro')).toContain('data-testid="reception-refus-stock"');
  });
});
