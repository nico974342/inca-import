/**
 * Bouton « Appeler » : ouvre le téléphone (lien tel:) et, au retour dans l'application, propose DISCRÈTEMENT « Noter cet appel ».
 * Un appui sur le bouton ne prouve jamais qu'un appel a eu lieu : ce script n'enregistre RIEN, il ne fait que proposer. Seul l'envoi du
 * formulaire « Noter un appel » crée une activité. Tout est local au navigateur (stockage facultatif : sans lui, aucune proposition).
 */
const CLE = 'inca_appel_en_cours';
const VALIDITE_MS = 3 * 3600 * 1000;       // une proposition périmée au bout de 3 h
const ABSENCE_MINI_MS = 4000;              // l'application doit avoir quitté l'écran un instant (sinon aucun appel n'a démarré)

type Appel = { clientId: string; nom: string; ts: number; quitteLe?: number };

const lire = (): Appel | null => { try { const v = JSON.parse(localStorage.getItem(CLE) ?? 'null'); return v && typeof v.clientId === 'string' && Date.now() - v.ts < VALIDITE_MS ? v : null; } catch { return null; } };
const ecrire = (a: Appel | null) => { try { if (a) localStorage.setItem(CLE, JSON.stringify(a)); else localStorage.removeItem(CLE); } catch { /* stockage indisponible : pas de proposition */ } };

/** Appelée après l'envoi d'un formulaire : l'appel est noté (ou l'utilisateur a choisi autre chose), on n'insiste plus. */
export function oublierAppel() { ecrire(null); }

export function initRetourAppel() {
  const banniere = (a: Appel) => {
    if (document.getElementById('appelRetour')) return;
    // inutile sur l'écran de saisie du même client
    if (location.pathname === `/admin/clients/${a.clientId}/noter`) return;
    const b = document.createElement('div');
    b.id = 'appelRetour'; b.setAttribute('role', 'status');
    b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:60;display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:12px;background:#1f1a17;color:#fff;font:500 14px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)';
    const t = document.createElement('span'); t.textContent = `Appel à ${a.nom} ?`;
    const lien = document.createElement('a'); lien.href = `/admin/clients/${a.clientId}/noter?type=appel`; lien.textContent = 'Noter cet appel';
    lien.style.cssText = 'color:#fff;background:#c2410c;padding:10px 14px;border-radius:999px;text-decoration:none;font-weight:700;white-space:nowrap;min-height:20px';
    const non = document.createElement('button'); non.type = 'button'; non.textContent = 'Ignorer'; non.setAttribute('aria-label', 'Ignorer');
    non.style.cssText = 'background:none;border:0;color:#d6cfc9;font:inherit;padding:10px 6px;cursor:pointer';
    non.addEventListener('click', () => { ecrire(null); b.remove(); });
    lien.addEventListener('click', () => ecrire(null));
    b.append(t, lien, non); document.body.append(b);
  };

  // Mémorise le départ en appel (n'importe quelle page : lien marqué data-appel)
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[data-appel]') as HTMLAnchorElement | null;
    if (a?.dataset.appel) ecrire({ clientId: a.dataset.appel, nom: a.dataset.nom ?? 'ce client', ts: Date.now() });
  });
  document.addEventListener('visibilitychange', () => {
    const a = lire(); if (!a) return;
    if (document.visibilityState === 'hidden') { if (!a.quitteLe) ecrire({ ...a, quitteLe: Date.now() }); return; }
    if (a.quitteLe && Date.now() - a.quitteLe >= ABSENCE_MINI_MS) banniere(a);
  });
  // Retour sur une page rechargée ou restaurée
  window.addEventListener('pageshow', () => { const a = lire(); if (a?.quitteLe && Date.now() - a.quitteLe >= ABSENCE_MINI_MS) banniere(a); });
}
