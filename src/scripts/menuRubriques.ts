/**
 * Rubriques repliables du menu d'administration (Ventes, Achats, Stocks, Commercial, Gestion).
 * - Un clic (ou Entrée / Espace au clavier) sur le titre ouvre ou ferme la rubrique ; plusieurs peuvent être ouvertes.
 * - Par défaut (aucun choix mémorisé) : seule la rubrique de la page courante est ouverte (`data-courant="true"`, posé par le serveur).
 * - Le choix est mémorisé dans ce navigateur : rubriques ouvertes (`o`) et rubriques connues au moment de l'enregistrement (`c`).
 *   Une rubrique absente de `c` (ajoutée depuis) n'a jamais fait l'objet d'un choix : elle suit l'état par défaut.
 *   Ancien format (simple liste des rubriques ouvertes) : lu comme `c` = les quatre rubriques d'origine.
 *   Sans stockage disponible, le menu fonctionne quand même, avec l'état par défaut à chaque page.
 * - Accessibilité : le titre est un vrai bouton (`aria-expanded`, `aria-controls`) ; un sous-menu fermé est retiré de l'ordre de tabulation
 *   et des lecteurs d'écran (`hidden`). Les liens, permissions et pages ne sont pas touchés : ce script ne fait que replier ou déplier.
 */
const CLE = 'inca_admin_menu_ouverts';
const RUBRIQUES_D_ORIGINE = ['ventes', 'achats', 'stocks', 'gestion'];

type Memoire = { ouverts: string[]; connus: string[] };
const textes = (l: unknown[]) => l.filter((x): x is string => typeof x === 'string');

function lire(): Memoire | null {
  try {
    const v = JSON.parse(localStorage.getItem(CLE) ?? 'null');
    if (Array.isArray(v)) return { ouverts: textes(v), connus: RUBRIQUES_D_ORIGINE };
    if (v && Array.isArray(v.o) && Array.isArray(v.c)) return { ouverts: textes(v.o), connus: textes(v.c) };
  } catch { /* mémoire illisible : état par défaut */ }
  return null;
}
function ecrire(ouverts: string[], connus: string[]) {
  try { localStorage.setItem(CLE, JSON.stringify({ o: ouverts, c: connus })); } catch { /* stockage indisponible : pas de mémoire */ }
}

export function initMenuRubriques(racine: ParentNode = document) {
  const groupes = Array.from(racine.querySelectorAll<HTMLElement>('.nav-groupe'));
  if (groupes.length === 0) return;
  const tous = groupes.map(g => g.dataset.groupe!);
  const defaut = groupes.filter(g => g.dataset.courant === 'true').map(g => g.dataset.groupe!);
  const m = lire();
  let ouverts = m ? tous.filter(id => m.ouverts.includes(id) || (!m.connus.includes(id) && defaut.includes(id))) : defaut;

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
      ecrire(ouverts, tous);
    });
  }
}
