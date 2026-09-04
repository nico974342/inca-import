/**
 * Tous les timestamps sont stockés en UTC en base. La Réunion est en
 * UTC+4 toute l'année (pas d'heure d'été) — mais le serveur (Vercel) tourne
 * en UTC, donc tout `toLocaleString`/`toLocaleDateString` sans `timeZone`
 * explicite affiche l'heure serveur, pas l'heure locale du client final.
 * Ce module centralise la conversion d'affichage : la donnée ne change pas,
 * seul le rendu se convertit.
 */
export const REUNION_TIMEZONE = 'Indian/Reunion';

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date seule (JJ/MM/AAAA par défaut), convertie en heure de La Réunion. */
export function formatDateReunion(value: DateInput, options: Intl.DateTimeFormatOptions = {}): string {
  const d = toDate(value);
  if (!d) return '—';
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...options,
    timeZone: REUNION_TIMEZONE,
  });
}

/** Date + heure (JJ/MM/AAAA HH:mm par défaut), converties en heure de La Réunion. */
export function formatDateTimeReunion(value: DateInput, options: Intl.DateTimeFormatOptions = {}): string {
  const d = toDate(value);
  if (!d) return '—';
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...options,
    timeZone: REUNION_TIMEZONE,
  });
}

/** Heure seule (HH:mm par défaut), convertie en heure de La Réunion. */
export function formatTimeReunion(value: DateInput, options: Intl.DateTimeFormatOptions = {}): string {
  const d = toDate(value);
  if (!d) return '—';
  return d.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    ...options,
    timeZone: REUNION_TIMEZONE,
  });
}

/** "Aujourd'hui" en heure de La Réunion — pour dater un document généré à l'instant (PDF, etc.). */
export function todayReunion(options: Intl.DateTimeFormatOptions = {}): string {
  return formatDateReunion(new Date(), options);
}

/** "Aujourd'hui" en heure de La Réunion, au format ISO AAAA-MM-JJ — pour la valeur d'un <input type="date">. */
export function todayReunionISO(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: REUNION_TIMEZONE });
}

/**
 * Instant UTC correspondant à 00h00 le 1er d'un mois du calendrier de La
 * Réunion (0 = mois en cours, 1 = mois précédent, …).
 *
 * À utiliser pour toute borne de mois qui doit correspondre à ce qu'une
 * horloge réunionnaise affiche — `new Date(now.getFullYear(), now.getMonth(), 1)`
 * utilise le calendrier du serveur (UTC), qui peut être décalé d'un jour
 * pile au changement de mois : un client qui commande le 1er à 2h du matin
 * (heure de La Réunion) se ferait autrement compter dans le mois précédent,
 * puisqu'il n'est encore que 22h la veille en UTC.
 */
/** Instant UTC correspondant à 00h00 à La Réunion pour une date "AAAA-MM-JJ"
 *  (typiquement une valeur de <input type="date">, ou une colonne DATE
 *  postgres déjà rendue en chaîne par le client Supabase). */
export function reunionDateStartUTC(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+04:00`);
}

export function reunionMonthStart(monthsAgo = 0): Date {
  const [y, m] = new Intl.DateTimeFormat('en-CA', {
    timeZone: REUNION_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  }).format(new Date()).split('-').map(Number);
  const totalMonths = y * 12 + (m - 1) - monthsAgo;
  const yy = Math.floor(totalMonths / 12);
  const mm = ((totalMonths % 12) + 12) % 12;
  return new Date(`${yy}-${String(mm + 1).padStart(2, '0')}-01T00:00:00+04:00`);
}
