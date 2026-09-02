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
