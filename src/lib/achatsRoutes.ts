/**
 * « Transit » est devenu « Suivi des achats » (/admin/achats). Les anciennes adresses /admin/transit… (favoris, onglets
 * ouverts, liens enregistrés) sont conservées et redirigent vers la nouvelle, avec l'identifiant et les paramètres.
 */
export function nouvelleAdresseAchats(pathname: string, search = ''): string | null {
  const m = pathname.match(/^\/admin\/transit(\/.*)?$/);
  if (!m) return null;
  return `/admin/achats${m[1] ?? ''}${search}`;
}

/** 301 pour une consultation, 308 sinon (un formulaire déjà ouvert garde sa méthode et son contenu). */
export function statutRedirectionAchats(method: string): 301 | 308 {
  return method === 'GET' || method === 'HEAD' ? 301 : 308;
}
