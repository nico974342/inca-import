/**
 * Recherche instantanée dans l'onglet « Clients » de l'administration : fonctions pures, partagées entre le serveur (qui prépare l'index de chaque ligne) et le navigateur
 * (qui filtre au fil de la saisie). Aucune donnée n'est lue ni écrite ici.
 *
 * Règles :
 *  - insensible aux majuscules, minuscules et accents (« Épicerie » = « epicerie ») ;
 *  - on cherche dans : nom du contact, société (raison sociale), point de vente (nom du commerce), téléphone, e-mail ;
 *  - plusieurs mots = tous doivent se retrouver (dans n'importe quel champ et n'importe quel ordre) ;
 *  - un numéro se retrouve quelle que soit sa présentation : « 0692 12 34 56 », « 0692123456 », « +262 692 12 34 56 », « 262692123456 ».
 */

export type ChampsRecherche = { nom?: string | null; societe?: string | null; pointsDeVente?: string | null; telephone?: string | null; email?: string | null };
export type IndexClient = { texte: string; tel: string };

/** Minuscules, sans accents, espaces simples. */
export const normaliser = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();

export const chiffres = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '');

/** Un numéro réunionnais s'écrit « 0692… » ou « +262 692… » (ou « 00262… ») : on garde les deux formes pour que l'une retrouve l'autre. */
export function variantesTelephone(tel: string | null | undefined): string {
  let d = chiffres(tel); if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  const formes = new Set<string>([d]);
  if (d.startsWith('262') && d.length >= 12) formes.add('0' + d.slice(3));            // international → national
  else if (d.startsWith('0') && d.length >= 10) formes.add('262' + d.slice(1));      // national → international
  return [...formes].join(' ');
}

/** Index d'une ligne : texte normalisé de tous les champs cherchés + chiffres du téléphone. */
export function indexClient(c: ChampsRecherche): IndexClient {
  return {
    texte: normaliser([c.nom, c.societe, c.pointsDeVente, c.telephone, c.email].filter(Boolean).join(' ')),
    tel: variantesTelephone(c.telephone),
  };
}

const ressembleAUnNumero = (q: string) => /^[\d\s+.\-()]+$/.test(q) && chiffres(q).length >= 3;

/** Vrai si la ligne correspond à la requête. Requête vide = tout correspond. */
export function correspond(index: IndexClient, requete: string): boolean {
  const q = normaliser(requete);
  if (!q) return true;
  if (ressembleAUnNumero(q)) {                                                       // saisie d'un numéro, avec ou sans espaces, points, « + »
    let d = chiffres(q); if (d.startsWith('00')) d = d.slice(2);
    return index.tel.split(' ').some(forme => forme.includes(d));
  }
  const dansTel = (d: string) => index.tel.split(' ').some(forme => forme.includes(d.startsWith('00') ? d.slice(2) : d));
  return q.split(' ').every(mot => index.texte.includes(mot) || (/^[\d+.\-()]+$/.test(mot) && chiffres(mot).length >= 3 && dansTel(chiffres(mot))));   // chaque mot doit se retrouver (un mot numérique aussi dans le téléphone)
}

/** Libellé du nombre de résultats. */
export const libelleResultats = (n: number, total: number): string =>
  n === 0 ? '' : `${n} résultat${n > 1 ? 's' : ''} sur ${total}`;
