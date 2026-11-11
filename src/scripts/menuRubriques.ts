/**
 * Rubriques repliables du menu d'administration (Ventes, Stocks, Achats, Gestion).
 * - Un clic (ou Entrée / Espace au clavier) sur le titre ouvre ou ferme la rubrique ; plusieurs peuvent être ouvertes.
 * - Par défaut (aucun choix mémorisé) : seule la rubrique de la page courante est ouverte (`data-courant="true"`, posé par le serveur).
 * - Le choix est mémorisé dans ce navigateur (liste des rubriques ouvertes) et retrouvé à chaque page et après actualisation.
 *   Sans stockage disponible, le menu fonctionne quand même, avec l'état par défaut à chaque page.
 * - Accessibilité : le titre est un vrai bouton (`aria-expanded`, `aria-controls`) ; un sous-menu fermé est retiré de l'ordre de tabulation
 *   et des lecteurs d'écran (`hidden`). Les liens, permissions et pages ne sont pas touchés : ce script ne fait que replier ou déplier.
 */
const CLE = 'inca_admin_menu_ouverts';

function lire(): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(CLE) ?? 'null');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch { return null; }
}
function ecrire(ouverts: string[]) { try { localStorage.setItem(CLE, JSON.stringify(ouverts)); } catch { /* stockage indisponible : pas de mémoire */ } }

export function initMenuRubriques(racine: ParentNode = document) {
  const groupes = Array.from(racine.querySelectorAll<HTMLElement>('.nav-groupe'));
  if (groupes.length === 0) return;
  const defaut = groupes.filter(g => g.dataset.courant === 'true').map(g => g.dataset.groupe!);
  let ouverts = lire() ?? defaut;

  const appliquer = () => {
    for (const g of groupes) {
      const ouvert = ouverts.includes(g.dataset.groupe!);
      g.querySelector('.nav-groupe-btn')?.setAttribute('aria-expanded', String(ouvert));
      const sous = g.querySelector<HTMLElement>('.nav-sous'); if (sous) sous.hidden = !ouvert;
    }
    // l'état est maintenant porté par les attributs (aria-expanded, hidden) : on retire l'amorce posée avant l'affichage
    document.documentElement.removeAttribute('data-menu-ouverts');
  };
  appliquer();

  for (const g of groupes) {
    g.querySelector('.nav-groupe-btn')?.addEventListener('click', () => {
      const id = g.dataset.groupe!;
      ouverts = ouverts.includes(id) ? ouverts.filter(x => x !== id) : [...ouverts, id];
      appliquer();
      ecrire(ouverts);
    });
  }
}
