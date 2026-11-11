import { acteurDepuisSession, type creerPortefeuille, type RattachementGroupe, type UtilisateurSession } from './portefeuille';

/**
 * Actions de l'écran « Portefeuilles » : valide la demande du formulaire, puis appelle les fonctions sécurisées de M1 via la bibliothèque
 * `portefeuille` (qui déduit l'identité de la SESSION et vérifie le responsable dans l'annuaire). Le formulaire n'apporte que des choix
 * (quels clients, quelle action, quel responsable, quel motif) : jamais l'identité ni le rôle de celui qui agit.
 * Aucune opération sans confirmation explicite (case « confirme » = oui), vérifiée ICI, côté serveur.
 */
export type Portefeuille = Pick<ReturnType<typeof creerPortefeuille>, 'attribuerClient' | 'attribuerClientsEnLot' | 'classerClientsEnLot'>;
export type Formulaire = { get(nom: string): unknown; getAll(nom: string): unknown[] };
export type ResultatAction = { ok: boolean; message: string };

export const MAX_LOT = 200;          // plafond d'un lot (identique à la base)
export const MAX_PRISE_EN_CHARGE = 50;

const refus = (message: string): ResultatAction => ({ ok: false, message });
const pluriel = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`;

export async function traiterAction(p: Portefeuille, utilisateur: UtilisateurSession, f: Formulaire): Promise<ResultatAction> {
  const acteur = acteurDepuisSession(utilisateur);
  if (!acteur) return refus("Vous n'avez pas le droit de faire cette action.");
  if (f.get('confirme') !== 'oui') return refus("Confirmez l'opération (case à cocher) : rien n'a été modifié.");

  const ids = [...new Set(f.getAll('client_ids').filter((x): x is string => typeof x === 'string' && x.length > 0))];
  if (ids.length === 0) return refus('Sélectionnez au moins un client.');
  if (ids.length > MAX_LOT) return refus(`Sélection trop grande (${MAX_LOT} clients au maximum).`);
  const motif = String(f.get('motif') ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const operation = String(f.get('operation') ?? '');
  const admin = acteur.role === 'admin';

  if (operation === 'attribuer') {
    if (!admin) return refus('Seul un administrateur peut attribuer ou transférer des clients.');
    if (motif.length < 3) return refus('Indiquez un motif (3 caractères minimum) : rien n\'a été modifié.');
    const r = await p.attribuerClientsEnLot({ utilisateur, clientIds: ids, nouveauId: f.get('responsable_id'), motif });
    if (!r.ok) return refus(r.message);
    const d = r.data as { attribues?: number; transferes?: number; ignores?: number };
    const parties = [d.attribues ? `${pluriel(d.attribues, 'client attribué', 'clients attribués')}` : '', d.transferes ? `${pluriel(d.transferes, 'client transféré', 'clients transférés')}` : '', d.ignores ? `${pluriel(d.ignores, 'client déjà confié à cette personne', 'clients déjà confiés à cette personne')}` : ''].filter(Boolean);
    return { ok: true, message: `${parties.join(' · ') || 'Aucun changement'} — journalisé.` };
  }

  if (operation === 'prendre') {
    if (ids.length > MAX_PRISE_EN_CHARGE) return refus(`Pas plus de ${MAX_PRISE_EN_CHARGE} clients à la fois.`);
    let faits = 0; const echecs = new Map<string, number>();
    for (const id of ids) {
      const r = await p.attribuerClient({ utilisateur, clientId: id, action: 'prise_en_charge' });
      if (r.ok) faits++; else echecs.set(r.message, (echecs.get(r.message) ?? 0) + 1);
    }
    const detail = [...echecs].map(([m, n]) => `${pluriel(n, 'refusé', 'refusés')} : ${m}`).join(' ');
    if (faits === 0) return refus(detail || 'Aucun client pris en charge.');
    return { ok: true, message: `${pluriel(faits, 'client pris en charge', 'clients pris en charge')} — journalisé.${detail ? ` ${detail}` : ''}` };
  }

  if (operation === 'retirer') {
    if (!admin) return refus('Seul un administrateur peut retirer un responsable.');
    if (motif.length < 3) return refus('Indiquez un motif (3 caractères minimum) : rien n\'a été modifié.');
    if (ids.length > MAX_PRISE_EN_CHARGE) return refus(`Pas plus de ${MAX_PRISE_EN_CHARGE} clients à la fois.`);
    let faits = 0; const echecs = new Map<string, number>();
    for (const id of ids) {
      const r = await p.attribuerClient({ utilisateur, clientId: id, action: 'retrait', motif });
      if (r.ok) faits++; else echecs.set(r.message, (echecs.get(r.message) ?? 0) + 1);
    }
    const detail = [...echecs].map(([m, n]) => `${pluriel(n, 'refusé', 'refusés')} : ${m}`).join(' ');
    if (faits === 0) return refus(detail || 'Aucun responsable retiré.');
    return { ok: true, message: `${pluriel(faits, 'responsable retiré', 'responsables retirés')} — journalisé.${detail ? ` ${detail}` : ''}` };
  }

  if (operation === 'classer') {
    if (!admin) return refus('Seul un administrateur peut classer les clients.');
    const valeur = String(f.get('valeur') ?? '');
    if (!['interne', 'externe', 'non_classe'].includes(valeur)) return refus('Choisissez une classification.');
    const r = await p.classerClientsEnLot({ utilisateur, clientIds: ids, valeur: valeur === 'non_classe' ? null : (valeur as RattachementGroupe), motif: motif || null });
    if (!r.ok) return refus(r.message);
    const d = r.data as { classes?: number; inchanges?: number };
    const libelle = valeur === 'interne' ? 'Groupe Incana' : valeur === 'externe' ? 'Externe' : 'Non classé';
    return { ok: true, message: `${pluriel(d.classes ?? 0, 'client classé', 'clients classés')} « ${libelle} »${d.inchanges ? ` · ${pluriel(d.inchanges, 'déjà dans cette classe', 'déjà dans cette classe')}` : ''} — journalisé. Les commandes passées ne changent pas.` };
  }

  return refus('Opération inconnue.');
}

/** Adresse de retour : uniquement la page Portefeuilles (jamais une adresse fournie librement), sans ancien message. */
export function adresseRetour(brut: unknown, resultat: ResultatAction): string {
  const base = typeof brut === 'string' && /^\/admin\/portefeuilles(\?[^#\s]*)?$/.test(brut) ? brut : '/admin/portefeuilles';
  const u = new URL(base, 'http://local');
  u.searchParams.delete('ok'); u.searchParams.delete('err');
  u.searchParams.set(resultat.ok ? 'ok' : 'err', resultat.message);
  return `${u.pathname}${u.search}`;
}
