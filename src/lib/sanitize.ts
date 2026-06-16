/**
 * Strips HTML tags and dangerous characters from untrusted form input.
 * Applied server-side before any database write.
 */
export function sanitizeText(value: string | null | undefined, maxLength = 500): string {
  if (!value) return '';
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/[<>"'`;\\]/g, '')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeEmail(value: string | null | undefined): string {
  if (!value) return '';
  const cleaned = value.replace(/<[^>]*>/g, '').trim().slice(0, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ? cleaned : '';
}
