/**
 * Ordre d'affichage du catalogue client — règles pures, sans accès base.
 *
 * Vue « Tous » (sans recherche), en sections :
 *   1. Nouveautés disponibles (les plus vendues d'abord)
 *   2. une section par catégorie, dans l'ordre métier (CATALOGUE_ORDRE_CATEGORIES), plus vendus d'abord
 *   3. Disponibles prochainement : tous les indisponibles, regroupés par catégorie puis plus vendus
 * Un produit sans vente passe après ceux qui en ont, par ordre alphabétique.
 * Le champ `position` n'intervient plus.
 *
 * Catégorie choisie : ses produits par ventes décroissantes, indisponibles en dernier.
 * Recherche (toutes catégories) : nouveautés disponibles, puis disponibles par ventes, puis indisponibles.
 */
import { CATALOGUE_ORDRE_CATEGORIES } from './constants';

export interface ProduitTri {
  id: string;
  name: string;
  category: string | null;
}
export interface ContexteTri {
  /** Quantités vendues sur la fenêtre (id → quantité). Absent = aucune vente. */
  ventes: ReadonlyMap<string, number>;
  estDisponible: (id: string) => boolean;
  estNouveau: (id: string) => boolean;
}

export type SectionCatalogue = { cle: string; titre: string; ids: string[] };
export interface OrdreCatalogue {
  /** Sections de la vue « Tous », dans l'ordre d'affichage (vides omises). */
  sections: SectionCatalogue[];
  /** Rang de chaque produit selon la vue : « tous » = ordre des sections, « categorie » = ventes puis indisponibles, « recherche ». */
  rang: { tous: Map<string, number>; categorie: Map<string, number>; recherche: Map<string, number> };
}

const rangCategorie = (c: string | null) => {
  const i = (CATALOGUE_ORDRE_CATEGORIES as readonly string[]).indexOf(c ?? '');
  return i === -1 ? CATALOGUE_ORDRE_CATEGORIES.length : i;
};

export const TITRES_CATEGORIES: Record<string, string> = {
  boissons: 'Boissons', snacks: 'Snacks', chips: 'Chips', confiseries: 'Confiseries', divers: 'Divers',
};

export function ordonnerCatalogue(produits: readonly ProduitTri[], ctx: ContexteTri): OrdreCatalogue {
  const vendu = (p: ProduitTri) => ctx.ventes.get(p.id) ?? 0;
  // Plus vendus d'abord ; sans vente après ceux qui en ont (vendu = 0 < vendu > 0), puis alphabétique.
  const parVentes = (a: ProduitTri, b: ProduitTri) =>
    vendu(b) - vendu(a) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  const parCategorieVentes = (a: ProduitTri, b: ProduitTri) =>
    rangCategorie(a.category) - rangCategorie(b.category) || (a.category ?? '').localeCompare(b.category ?? '') || parVentes(a, b);

  const dispos = produits.filter(p => ctx.estDisponible(p.id));
  const indispos = produits.filter(p => !ctx.estDisponible(p.id));
  const nouveautes = dispos.filter(p => ctx.estNouveau(p.id)).sort(parVentes);
  const autres = dispos.filter(p => !ctx.estNouveau(p.id));

  const sections: SectionCatalogue[] = [];
  if (nouveautes.length) sections.push({ cle: 'nouveautes', titre: 'Nouveautés', ids: nouveautes.map(p => p.id) });
  const cats = [...new Set(autres.map(p => p.category ?? ''))]
    .sort((a, b) => rangCategorie(a || null) - rangCategorie(b || null) || a.localeCompare(b));
  for (const c of cats) {
    const ids = autres.filter(p => (p.category ?? '') === c).sort(parVentes).map(p => p.id);
    sections.push({ cle: c || 'autres', titre: TITRES_CATEGORIES[c] ?? (c ? c[0].toUpperCase() + c.slice(1) : 'Autres'), ids });
  }
  if (indispos.length) {
    sections.push({ cle: 'indisponibles', titre: 'Disponibles prochainement', ids: [...indispos].sort(parCategorieVentes).map(p => p.id) });
  }

  const numeroter = (liste: ProduitTri[]) => new Map(liste.map((p, i) => [p.id, i]));
  const tous = new Map<string, number>(); let n = 0;
  for (const s of sections) for (const id of s.ids) tous.set(id, n++);
  return {
    sections,
    rang: {
      tous,
      categorie: numeroter([...[...dispos].sort(parVentes), ...[...indispos].sort(parVentes)]),
      recherche: numeroter([...nouveautes, ...autres.sort(parVentes), ...[...indispos].sort(parVentes)]),
    },
  };
}
