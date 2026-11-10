/**
 * Signature électronique des bons de livraison : règles pures, sans accès base (testables hors ligne).
 * Voir supabase/migrations/bl_signatures.sql.
 */
import { inflateSync } from 'node:zlib';

export const ROLES_SIGNATURE = ['transporteur', 'destinataire'] as const;
export type RoleSignature = (typeof ROLES_SIGNATURE)[number];
export const LIBELLE_ROLE: Record<RoleSignature, string> = { transporteur: 'Transporteur', destinataire: 'Destinataire' };

export type EtatSignature = 'non_signe' | 'partiel' | 'signe';
export const LIBELLE_ETAT: Record<EtatSignature, string> = { non_signe: 'Non signé', partiel: 'Signé partiellement', signe: 'Signé' };

/** État d'un BL d'après ses signatures. Les signatures annulées ne comptent pas. */
export function etatSignature(signatures: ReadonlyArray<{ role: string; annulee_le?: string | null }>): EtatSignature {
  const actifs = new Set(signatures.filter(s => !s.annulee_le).map(s => s.role));
  const n = ROLES_SIGNATURE.filter(r => actifs.has(r)).length;
  return n === 0 ? 'non_signe' : n === ROLES_SIGNATURE.length ? 'signe' : 'partiel';
}

export const estRoleSignature = (r: unknown): r is RoleSignature => ROLES_SIGNATURE.includes(r as RoleSignature);

/** Nom du signataire : texte simple, 1 à 100 caractères, sans caractères de contrôle. */
export function validerNom(brut: unknown): { ok: true; nom: string } | { ok: false; raison: string } {
  if (typeof brut !== 'string') return { ok: false, raison: 'Le nom du signataire est obligatoire.' };
  const nom = brut.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!nom) return { ok: false, raison: 'Le nom du signataire est obligatoire.' };
  if (nom.length > 100) return { ok: false, raison: 'Le nom du signataire est trop long (100 caractères maximum).' };
  return { ok: true, nom };
}

export const SIGNATURE_PREFIXE = 'data:image/png;base64,';
export const SIGNATURE_MAX_CARACTERES = 400_000;   // aligné sur le CHECK SQL
const LARGEUR_MAX = 2400, HAUTEUR_MAX = 1600;
/** Nombre minimal de pixels tracés pour considérer qu'on a signé (un tap accidentel ne suffit pas). */
export const PIXELS_TRACES_MIN = 150;

const OCTETS_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Compte les pixels non transparents d'un PNG RGBA 8 bits non entrelacé (ce que produit canvas.toDataURL). null = format non analysable. */
export function pixelsTraces(png: Buffer): number | null {
  if (png.length < 33 || !png.subarray(0, 8).equals(OCTETS_PNG)) return null;
  let pos = 8, largeur = 0, hauteur = 0, profondeur = 0, type = -1, entrelace = 1;
  const idat: Buffer[] = [];
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos), nom = png.toString('latin1', pos + 4, pos + 8);
    const debut = pos + 8, fin = debut + len;
    if (fin + 4 > png.length) return null;
    if (nom === 'IHDR') { largeur = png.readUInt32BE(debut); hauteur = png.readUInt32BE(debut + 4); profondeur = png[debut + 8]; type = png[debut + 9]; entrelace = png[debut + 12]; }
    else if (nom === 'IDAT') idat.push(png.subarray(debut, fin));
    else if (nom === 'IEND') break;
    pos = fin + 4;
  }
  if (!largeur || !hauteur || largeur > LARGEUR_MAX || hauteur > HAUTEUR_MAX) return null;
  if (profondeur !== 8 || type !== 6 || entrelace !== 0) return null;
  const pas = largeur * 4;
  let brut: Buffer;
  try { brut = inflateSync(Buffer.concat(idat), { maxOutputLength: (pas + 1) * hauteur + 16 }); } catch { return null; }
  if (brut.length < (pas + 1) * hauteur) return null;
  let precedente = Buffer.alloc(pas), courante = Buffer.alloc(pas), traces = 0;
  for (let y = 0; y < hauteur; y++) {
    const filtre = brut[y * (pas + 1)], ligne = brut.subarray(y * (pas + 1) + 1, (y + 1) * (pas + 1));
    for (let i = 0; i < pas; i++) {
      const a = i >= 4 ? courante[i - 4] : 0, b = precedente[i], c = i >= 4 ? precedente[i - 4] : 0;
      let v = ligne[i];
      if (filtre === 1) v += a;
      else if (filtre === 2) v += b;
      else if (filtre === 3) v += (a + b) >> 1;
      else if (filtre === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filtre !== 0) return null;
      courante[i] = v & 0xff;
    }
    for (let x = 3; x < pas; x += 4) if (courante[x] > 0) traces++;
    [precedente, courante] = [courante, precedente];
  }
  return traces;
}

/** Valide l'image reçue du navigateur : PNG réel, taille raisonnable, tracé non vide. */
export function validerImageSignature(data: unknown): { ok: true; data: string; octets: Buffer } | { ok: false; raison: string } {
  if (typeof data !== 'string' || !data.startsWith(SIGNATURE_PREFIXE)) return { ok: false, raison: 'Image de signature invalide.' };
  if (data.length > SIGNATURE_MAX_CARACTERES) return { ok: false, raison: 'Image de signature trop volumineuse.' };
  const base64 = data.slice(SIGNATURE_PREFIXE.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { ok: false, raison: 'Image de signature invalide.' };
  const octets = Buffer.from(base64, 'base64');
  if (!octets.subarray(0, 8).equals(OCTETS_PNG)) return { ok: false, raison: 'Image de signature invalide.' };
  const traces = pixelsTraces(octets);
  if (traces !== null && traces < PIXELS_TRACES_MIN) return { ok: false, raison: 'La signature est vide ou trop courte : signez dans le cadre.' };
  if (traces === null && octets.length < 600) return { ok: false, raison: 'La signature est vide ou trop courte : signez dans le cadre.' };
  return { ok: true, data, octets };
}
