/** Refus de la base pour une réception qui retirerait du stock déjà vendu ou réservé (STOCK_INSUFFISANT_RECEPTION) : le texte lisible, sinon null. */
export function messageRefusStock(err: { message?: string } | null | undefined): string | null {
  const m = String(err?.message ?? '');
  const i = m.indexOf('STOCK_INSUFFISANT_RECEPTION');
  if (i < 0) return null;
  return m.slice(i + 'STOCK_INSUFFISANT_RECEPTION'.length).replace(/^\s*:\s*/, '').trim() || 'Cette opération retirerait du stock déjà vendu ou réservé.';
}

export const urlRefusStock = (base: string, texte: string) => `${base}?err=stock&msg=${encodeURIComponent(texte)}`;
