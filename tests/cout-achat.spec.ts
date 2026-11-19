/** Garde-fou des coûts d'achat : paliers validés (moins de 20 % : rien ; 20 à 50 % : confirmation ; au-delà de 50 % ou supérieur au prix de vente : confirmation renforcée ; négatif refusé ; nul = offert). */
import { test, expect } from '@playwright/test';
import { evaluerCoutAchat } from '../src/lib/coutAchat';

test.describe('Alertes sur les coûts d\'achat', () => {
  test('variation inférieure à 20 % : aucune alerte, quelle que soit la direction', () => {
    expect(evaluerCoutAchat({ cout: 11, coutReference: 10 }).niveau).toBe('ok');          // +10 %
    expect(evaluerCoutAchat({ cout: 8.5, coutReference: 10 }).niveau).toBe('ok');         // −15 %
    expect(evaluerCoutAchat({ cout: 10, coutReference: 10 })).toMatchObject({ niveau: 'ok', variation: 0, message: '' });
    expect(evaluerCoutAchat({ cout: 11.99, coutReference: 10 }).niveau).toBe('ok');
  });

  test('de 20 % à 50 % : confirmation explicite (bornes incluses) ; une vraie hausse reste possible', () => {
    expect(evaluerCoutAchat({ cout: 12, coutReference: 10 }).niveau).toBe('confirmer');  // +20 % exactement
    expect(evaluerCoutAchat({ cout: 15, coutReference: 10 }).niveau).toBe('confirmer');  // +50 % exactement
    expect(evaluerCoutAchat({ cout: 7, coutReference: 10 }).niveau).toBe('confirmer');   // −30 %
    const v = evaluerCoutAchat({ cout: 13, coutReference: 10 }); expect(v.message).toContain('+30 %'); expect(v.message).toContain('Confirmation requise'); expect(v.niveau).not.toBe('refuse');
  });

  test('au-delà de 50 %, ou coût supérieur au prix de vente : confirmation renforcée (le cas de la saisie à 10 000 € par carton)', () => {
    expect(evaluerCoutAchat({ cout: 15.01, coutReference: 10 }).niveau).toBe('renforcee');
    expect(evaluerCoutAchat({ cout: 4.9, coutReference: 10 }).niveau).toBe('renforcee');           // −51 %
    const enorme = evaluerCoutAchat({ cout: 10000, coutReference: 7.92, prixVente: 20.4 }); expect(enorme.niveau).toBe('renforcee'); expect(enorme.raisons).toEqual(expect.arrayContaining(['variation_superieure_50', 'cout_superieur_prix_vente']));
    expect(enorme.message).toContain('retapez');
    expect(evaluerCoutAchat({ cout: 21, coutReference: 20, prixVente: 20.4 }).niveau).toBe('renforcee');   // +5 % seulement, mais plus cher que le prix de vente
    expect(evaluerCoutAchat({ cout: 21, prixVente: 20.4 }).niveau).toBe('renforcee');                      // sans référence : le prix de vente suffit
  });

  test('coût négatif ou invalide : refusé ; coût nul : confirmé seulement s\'il est marqué « offert » ; premier achat sans référence : pas d\'alerte', () => {
    for (const cout of [-0.01, -5, NaN, Infinity]) expect(evaluerCoutAchat({ cout, coutReference: 10 }).niveau).toBe('refuse');
    expect(evaluerCoutAchat({ cout: 0 }).niveau).toBe('confirmer');                                      // nul sans « offert » ni référence
    expect(evaluerCoutAchat({ cout: 0, coutReference: 10 }).niveau).toBe('renforcee');                     // nul sans « offert » face à un coût habituel : −100 %
    expect(evaluerCoutAchat({ cout: 0, coutReference: 10 }).message).toContain('Marchandise offerte');
    expect(evaluerCoutAchat({ cout: 0, coutReference: 10, offert: true })).toMatchObject({ niveau: 'ok', raisons: ['marchandise_offerte'], variation: null });
    expect(evaluerCoutAchat({ cout: 5, coutReference: 5, offert: true }).niveau).toBe('confirmer');         // offert mais un coût est saisi
    expect(evaluerCoutAchat({ cout: 8 })).toMatchObject({ niveau: 'ok', variation: null });
    expect(evaluerCoutAchat({ cout: 8, coutReference: 0 }).niveau).toBe('ok');                              // référence nulle : pas de division
  });
});
