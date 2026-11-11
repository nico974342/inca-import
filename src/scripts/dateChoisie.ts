/**
 * Raccourcis de date (Demain, 3, 7, 14 jours, Autre date) : le champ « date » n'apparaît que lorsque « Autre date » est choisi.
 * Sans JavaScript, le champ reste visible et le formulaire fonctionne quand même (le serveur lit le raccourci ou la date).
 */
export function initDateChoisie(racine: ParentNode = document) {
  racine.querySelectorAll<HTMLFormElement>('form').forEach(form => {
    const date = form.querySelector<HTMLInputElement>('input[name="date_perso"]');
    const choix = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="radio"][name="delai"]'));
    if (!date || choix.length === 0) return;
    const maj = () => { date.hidden = !choix.some(c => c.checked && c.value === 'date'); };
    choix.forEach(c => c.addEventListener('change', maj));
    maj();
  });
}
