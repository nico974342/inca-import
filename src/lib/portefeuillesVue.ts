import type { RattachementGroupe } from './portefeuille';

/**
 * Vue « Portefeuilles » : logique pure (filtres, comptages, libellés), sans accès aux données ni au DOM — testée hors ligne.
 * Aucune donnée de coût, de marge ni d'achat n'entre ici : seulement l'identité commerciale du client et ses dates de commande.
 */
export type LigneClient = {
  id: string;
  nom: string;
  societe: string | null;
  email: string | null;
  telephone: string | null;
  status: 'prospect' | 'en_attente' | 'actif' | 'suspendu' | string;
  type: string | null;
  commune: string | null;
  created_at: string;
  responsable_id: string | null;
  responsable_email: string | null;
  rattachement_groupe: RattachementGroupe | null;
  nb_commandes: number;
  derniere_commande: string | null;
};

export const FILTRES = ['tous', 'non_attribues', 'mes_clients', 'non_classes', 'prospects', 'en_attente', 'actifs', 'interne', 'externe'] as const;
export type Filtre = (typeof FILTRES)[number];
export const LIBELLE_FILTRE: Record<Filtre, string> = {
  tous: 'Tous', non_attribues: 'Non attribués', mes_clients: 'Mes clients', non_classes: 'Non classés',
  prospects: 'Prospects', en_attente: 'À activer', actifs: 'Actifs', interne: 'Groupe Incana', externe: 'Externes',
};
export const LIBELLE_STATUT: Record<string, string> = { prospect: 'Prospect', en_attente: 'À activer', actif: 'Actif', suspendu: 'Suspendu' };
export const LIBELLE_GROUPE = (g: RattachementGroupe | null) => (g === 'interne' ? 'Groupe Incana' : g === 'externe' ? 'Externe' : 'Non classé');

export const parseFiltre = (v: string | null | undefined): Filtre => ((FILTRES as readonly string[]).includes(v ?? '') ? (v as Filtre) : 'tous');

/** Minuscules sans accents, pour une recherche tolérante. */
export const normaliser = (s: string | null | undefined) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const correspond = (l: LigneClient, filtre: Filtre, viewerId: string | null): boolean => {
  switch (filtre) {
    case 'non_attribues': return l.responsable_id == null;
    case 'mes_clients': return viewerId != null && l.responsable_id === viewerId;
    case 'non_classes': return l.rattachement_groupe == null;
    case 'prospects': return l.status === 'prospect';
    case 'en_attente': return l.status === 'en_attente';
    case 'actifs': return l.status === 'actif';
    case 'interne': return l.rattachement_groupe === 'interne';
    case 'externe': return l.rattachement_groupe === 'externe';
    default: return true;
  }
};

export function filtrerLignes(lignes: LigneClient[], o: { filtre: Filtre; q?: string; viewerId: string | null; responsableId?: string | null }): LigneClient[] {
  const q = normaliser(o.q);
  return lignes.filter(l => correspond(l, o.filtre, o.viewerId)
    && (!o.responsableId || l.responsable_id === o.responsableId)
    && (!q || [l.nom, l.societe, l.email, l.telephone, l.commune, l.responsable_email].some(c => normaliser(c).includes(q))));
}

/** Nombre de clients pour chaque pastille de filtre (sur l'ensemble, avant recherche). */
export function compterFiltres(lignes: LigneClient[], viewerId: string | null): Record<Filtre, number> {
  const r = Object.fromEntries(FILTRES.map(f => [f, 0])) as Record<Filtre, number>;
  for (const l of lignes) for (const f of FILTRES) if (correspond(l, f, viewerId)) r[f]++;
  return r;
}

/** Clients par responsable (e-mail ; « Non attribué » regroupe les autres). */
export function compterParResponsable(lignes: LigneClient[]): { email: string | null; id: string | null; n: number }[] {
  const m = new Map<string, { email: string | null; id: string | null; n: number }>();
  for (const l of lignes) {
    const cle = l.responsable_id ?? '—';
    const e = m.get(cle) ?? { email: l.responsable_email, id: l.responsable_id, n: 0 };
    e.n++; m.set(cle, e);
  }
  return [...m.values()].sort((a, b) => (a.id == null ? 1 : b.id == null ? -1 : b.n - a.n));
}

export const nomAffiche = (l: Pick<LigneClient, 'nom' | 'societe'>) => (l.societe?.trim() ? l.societe.trim() : l.nom);
export const partieLocale = (email: string | null) => (email ?? '').split('@')[0] || '—';

/** « il y a 3 j », « aujourd'hui », « jamais commandé » — jours calendaires (fuseau déjà appliqué par l'appelant via la date ISO). */
export function ancienneteCommande(derniere: string | null, maintenant: Date): string {
  if (!derniere) return 'Jamais commandé';
  const j = Math.floor((maintenant.getTime() - new Date(derniere).getTime()) / 86_400_000);
  return j <= 0 ? "Commandé aujourd'hui" : j === 1 ? 'Dernière commande hier' : `Dernière commande il y a ${j} j`;
}

/** Statistiques de commandes par client à partir des lignes brutes (hors annulées). */
export function agregerCommandes(commandes: { client_id: string | null; created_at: string; status: string }[]): Map<string, { nb: number; derniere: string }> {
  const m = new Map<string, { nb: number; derniere: string }>();
  for (const c of commandes) {
    if (!c.client_id || c.status === 'annulee') continue;
    const e = m.get(c.client_id);
    if (!e) m.set(c.client_id, { nb: 1, derniere: c.created_at });
    else { e.nb++; if (c.created_at > e.derniere) e.derniere = c.created_at; }
  }
  return m;
}

// ── Historique des changements (journal) ─────────────────────────────────────────────────────────────────────────────────────────
export type EntreeJournal = { id: string; admin_email: string; action: string; target_id: string | null; target_label: string | null; details: any; created_at: string };
export type EntreeHistorique = { id: string; quand: string; par: string; clientId: string | null; client: string; texte: string; motif: string | null };

const LIB_ACTION: Record<string, string> = { attribution: 'Attribué à', transfert: 'Transféré à', retrait: 'Responsable retiré', prise_en_charge: 'Pris en charge par' };
export function decrireJournal(e: EntreeJournal): EntreeHistorique {
  const d = e.details ?? {};
  let texte = e.action;
  if (e.action === 'client.responsable') {
    const nouveau = d.nouveau?.email as string | null | undefined; const ancien = d.ancien?.email as string | null | undefined;
    texte = d.action === 'retrait' ? `Responsable retiré (était ${ancien ?? '—'})`
      : d.action === 'transfert' ? `Transféré de ${ancien ?? '—'} à ${nouveau ?? '—'}` : `${LIB_ACTION[d.action] ?? 'Attribué à'} ${nouveau ?? '—'}`;
  } else if (e.action === 'client.rattachement_groupe') {
    texte = `Classement : ${LIBELLE_GROUPE(d.ancien ?? null)} → ${LIBELLE_GROUPE(d.nouveau ?? null)}`;
  }
  return { id: e.id, quand: e.created_at, par: e.admin_email, clientId: e.target_id, client: e.target_label ?? '—', texte, motif: d.motif ?? null };
}
export const ACTIONS_JOURNAL = ['client.responsable', 'client.rattachement_groupe'] as const;
