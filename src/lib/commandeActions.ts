/**
 * Actions du panier / de la commande côté serveur. Logique pure : les accès aux données sont injectés (DepotCommande), ce qui permet de les tester sur une vraie base locale.
 *
 * Règles :
 *  - JAMAIS de retrait ou de réduction silencieux : chaque ajustement est demandé par le client (retirer / réduire / « continuer avec les produits disponibles »),
 *    montré AVANT d'être appliqué (aperçu), et appliqué seulement si le plan confirmé est encore exactement celui qui serait calculé maintenant ;
 *  - le panier n'est vidé qu'APRÈS confirmation certaine que la commande est créée ;
 *  - le contrôle final du stock reste dans la base (création contrôlée) : ici on informe et on ajuste, on ne remplace pas ce contrôle.
 */
import { evaluerPanier, lignesEnProbleme, planAjustement, signaturePanier, signaturePlan, resumeAjustements, messageAjustement,
  type Ajustement, type Disponibilite, type EvaluationLigne, type ResultatConflit } from './panier';

export type LigneBrute = { product_id: string; quantity: number; nom: string; unit: string | null };
export type CommandeRecente = { id: string; secondes: number; lignes: { product_id: string; quantity: number }[] };

export interface DepotCommande {
  lireLignes(userId: string): Promise<LigneBrute[]>;
  /** Disponibilité réelle (physique − réservé) et caractère commandable PAR CE CLIENT. Un produit absent de la carte a disparu. */
  lireDisponibilites(userId: string, ids: string[]): Promise<Map<string, Disponibilite>>;
  ecrireQuantite(userId: string, productId: string, quantite: number): Promise<void>;
  retirer(userId: string, productId: string): Promise<void>;
  /** Vide le panier ; renvoie vrai seulement si c'est confirmé. */
  viderPanier(userId: string): Promise<boolean>;
  derniereCommande(userId: string): Promise<CommandeRecente | null>;
}

export type EtatPanier = { lignes: LigneBrute[]; evaluations: EvaluationLigne[]; plan: Ajustement[]; signature: string };

export async function etatPanier(depot: DepotCommande, userId: string): Promise<EtatPanier> {
  const lignes = await depot.lireLignes(userId);
  const dispos = lignes.length ? await depot.lireDisponibilites(userId, lignes.map(l => l.product_id)) : new Map<string, Disponibilite>();
  const evaluations = evaluerPanier(lignes, dispos);
  const plan = planAjustement(evaluations);
  return { lignes, evaluations, plan, signature: signaturePlan(plan) };
}

export type ResultatAction = { ok: boolean; message: string; changements?: Ajustement[] };

/** Retrait EXPLICITE d'une ligne (bouton « Retirer »). */
export async function retirerLigne(depot: DepotCommande, userId: string, productId: string): Promise<ResultatAction> {
  const { lignes } = await etatPanier(depot, userId);
  const l = lignes.find(x => x.product_id === productId);
  if (!l) return { ok: false, message: 'Ce produit n\'est plus dans votre panier.' };
  await depot.retirer(userId, productId);
  return { ok: true, message: `${l.nom} retiré de votre panier.`, changements: [{ product_id: l.product_id, nom: l.nom, unit: l.unit, action: 'retirer', de: l.quantity, vers: 0, raison: 'epuise' }] };
}

/** Réduction EXPLICITE d'une ligne à la quantité réellement disponible (bouton « Réduire à N »). La quantité est recalculée ici, jamais lue du formulaire. */
export async function reduireLigne(depot: DepotCommande, userId: string, productId: string): Promise<ResultatAction> {
  const { lignes, evaluations } = await etatPanier(depot, userId);
  const e = evaluations.find(x => x.product_id === productId);
  if (!e) return { ok: false, message: 'Ce produit n\'est plus dans votre panier.' };
  if (e.statut === 'ok') return { ok: true, message: `${e.nom} : la quantité demandée est de nouveau disponible, rien n'a été changé.` };
  if (e.statut !== 'reduire') return { ok: false, message: `${e.nom} n'est plus disponible : retirez ce produit de votre panier.` };
  await depot.ecrireQuantite(userId, productId, e.cible);
  const l = lignes.find(x => x.product_id === productId)!;
  return { ok: true, message: `${e.nom} : quantité ramenée de ${e.demande} à ${e.cible}.`, changements: [{ product_id: l.product_id, nom: l.nom, unit: l.unit, action: 'reduire', de: e.demande, vers: e.cible, raison: 'insuffisant' }] };
}

export type ResultatApercu = { etat: EtatPanier; resume: string; lignes: string[] };
/** « Continuer avec les produits disponibles », étape 1 : aperçu de ce qui serait retiré ou réduit. N'écrit RIEN. */
export async function apercuAjustement(depot: DepotCommande, userId: string): Promise<ResultatApercu> {
  const etat = await etatPanier(depot, userId);
  return { etat, resume: resumeAjustements(etat.plan), lignes: etat.plan.map(messageAjustement) };
}

export type ResultatConfirmation =
  | { type: 'applique'; changements: Ajustement[]; resume: string }
  | { type: 'a_revoir'; apercu: ResultatApercu }     // la disponibilité a encore changé depuis l'aperçu : on le remontre, rien n'est appliqué
  | { type: 'rien' };
/** Étape 2 : applique le plan confirmé — uniquement s'il est encore EXACTEMENT celui qui était affiché. */
export async function confirmerAjustement(depot: DepotCommande, userId: string, signatureAffichee: string): Promise<ResultatConfirmation> {
  const etat = await etatPanier(depot, userId);
  if (etat.plan.length === 0) return { type: 'rien' };
  if (etat.signature !== signatureAffichee) return { type: 'a_revoir', apercu: { etat, resume: resumeAjustements(etat.plan), lignes: etat.plan.map(messageAjustement) } };
  for (const a of etat.plan) {
    if (a.action === 'retirer') await depot.retirer(userId, a.product_id);
    else await depot.ecrireQuantite(userId, a.product_id, a.vers);
  }
  return { type: 'applique', changements: etat.plan, resume: resumeAjustements(etat.plan) };
}

// ── Envoi de la commande ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type ResultatCreation =
  | { ok: true; orderId: string; deja?: boolean }
  | { ok: false; conflicts: ResultatConflit[] }
  | { ok: false; error: string };

export type CreateurCommande = {
  /** Crée la commande par la fonction SÉCURISÉE de la base (idempotente : la même clé ne crée jamais deux commandes). S'il n'y en a pas, elle REFUSE (jamais de repli). */
  creer(cle: string, lignes: LigneBrute[]): Promise<ResultatCreation>;
};

export type ResultatEnvoi =
  | { type: 'cree'; orderId: string; deja: boolean; panierVide: boolean }
  | { type: 'deja_enregistree'; orderId: string }
  | { type: 'conflits'; conflits: ResultatConflit[] }
  | { type: 'panier_vide' }
  | { type: 'erreur'; code: string };

export const FENETRE_COMMANDE_RECENTE_S = 600;
export const FENETRE_DOUBLON_S = 120;

export async function traiterEnvoi(o: { depot: DepotCommande; userId: string; cle: string; createur: CreateurCommande }): Promise<ResultatEnvoi> {
  const { depot, userId, cle, createur } = o;
  const lignes = await depot.lireLignes(userId);
  const derniere = await depot.derniereCommande(userId);

  if (lignes.length === 0) {
    // Panier vide à l'envoi : un envoi précédent (double clic, réponse perdue) l'a déjà transformé en commande. On vérifie AVANT de laisser recommencer.
    if (derniere && derniere.secondes <= FENETRE_COMMANDE_RECENTE_S) return { type: 'deja_enregistree', orderId: derniere.id };
    return { type: 'panier_vide' };
  }
  // Second filet, en plus de la clé : un panier identique à une commande créée il y a moins de 2 minutes = doublon (vidage du panier échoué, ancienne page) : on ne recrée pas.
  if (derniere && derniere.secondes <= FENETRE_DOUBLON_S && signaturePanier(derniere.lignes) === signaturePanier(lignes)) {
    return { type: 'deja_enregistree', orderId: derniere.id };
  }

  let r: ResultatCreation;
  try { r = await createur.creer(cle, lignes); } catch { return { type: 'erreur', code: 'creation' }; }
  if (!r.ok) return 'conflicts' in r ? { type: 'conflits', conflits: r.conflicts } : { type: 'erreur', code: r.error };

  // La commande EXISTE : seulement maintenant on vide le panier, et on vérifie que c'est fait (3 essais).
  let vide = false;
  for (let i = 0; i < 3 && !vide; i++) { try { vide = await depot.viderPanier(userId); } catch { vide = false; } }
  return { type: 'cree', orderId: r.orderId, deja: !!r.deja, panierVide: vide };
}

/** Vrai si le panier affiché correspond exactement à la commande qui vient d'être créée (le vidage a échoué) : on le dit au client au lieu de le laisser recommander. */
export const panierDejaCommande = (lignes: { product_id: string; quantity: number }[], c: CommandeRecente | null): boolean =>
  !!c && c.secondes <= FENETRE_COMMANDE_RECENTE_S && lignes.length > 0 && signaturePanier(lignes) === signaturePanier(c.lignes);
