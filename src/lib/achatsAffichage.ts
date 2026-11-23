/**
 * Formats d'affichage du Suivi des achats (aucune règle de calcul : uniquement de la mise en forme). Partagés par la liste compacte (accordéon) et ses tests.
 */
import { formatDateReunion } from './datetime';

export const nombre = (n: number): string => n.toLocaleString('fr-FR');
export const fmtDate = (d: string | null): string => formatDateReunion(d, { day: 'numeric', month: 'short' });
export const fmtPrice = (n: number): string => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
export const fmtEUR2 = (n: number): string => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Texte « arrivée prévue » de la ligne repliée ; vide si la commande est terminée (réceptionnée, annulée) ou sans date. */
export function texteArrivee(p: { status: string; eta: string | null; late?: boolean; daysLate?: number }): string {
  if (!p.eta || p.status === 'receptionne' || p.status === 'annule') return '';
  const base = `Arrivée prévue ${fmtDate(p.eta)}`;
  return p.late && (p.daysLate ?? 0) > 0 ? `${base} · en retard de ${p.daysLate} j` : base;
}

/** Cartons restant à recevoir tels qu'affichés : jamais pour une commande clôturée avant le suivi par quantités, ni pour une commande annulée. */
export function resteAffiche(e: { reste: number; historique: boolean }, status: string): number | null {
  if (status === 'annule') return null;
  return e.historique ? 0 : e.reste;
}
