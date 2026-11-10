/**
 * Écran « Faire signer » : deux signatures successives (transporteur, puis destinataire).
 * Règle d'or : une signature n'est JAMAIS présentée comme enregistrée tant que le serveur n'a pas répondu « ok ».
 * En cas de réseau défaillant : nouvelles tentatives automatiques, puis message rouge + bouton « Réessayer »,
 * la signature restant sur l'écran et sauvegardée dans le téléphone (localStorage) pour survivre à un rechargement.
 */
(function () {
  'use strict';
  var cfg = JSON.parse(document.getElementById('sg-config').textContent);
  var $ = function (id) { return document.getElementById(id); };
  var LIBELLE = { transporteur: 'Transporteur', destinataire: 'Destinataire' };
  var DELAIS = [800, 2000];       // pauses entre les tentatives automatiques (3 essais au total)
  var DELAI_REPONSE = 20000;      // au-delà, la tentative est considérée comme échouée

  var panneau = $('panneau'), titre = $('sg-titre'), nom = $('sg-nom'), nomLabel = $('sg-nom-label');
  var cadre = $('sg-cadre'), btnEff = $('sg-effacer'), btnVal = $('sg-valider'), aide = $('sg-aide');
  var statut = $('sg-statut'), fin = $('sg-fin');
  if (!panneau || !$('pad')) return;

  var etapes = cfg.etapes.slice();
  var idx = 0;
  var etat = 'saisie';            // saisie | envoi | echec | ok
  var enAttente = null;           // { role, nom, data } : la signature en cours d'envoi

  var pad = IncaSignaturePad($('pad'), { onChange: maj });

  function role() { return etapes[idx]; }
  function cle(r) { return 'blsig:' + cfg.noteId + ':' + r; }
  function sauver(v) { try { localStorage.setItem(cle(v.role), JSON.stringify(v)); } catch (e) { /* stockage indisponible : on garde en mémoire */ } }
  function oublier(r) { try { localStorage.removeItem(cle(r)); } catch (e) { /* ignoré */ } }
  function retrouver(r) { try { var v = JSON.parse(localStorage.getItem(cle(r)) || 'null'); return v && v.data && v.nom ? v : null; } catch (e) { return null; } }
  function pause(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  function heure(iso) {
    try { return new Date(iso || Date.now()).toLocaleString('fr-FR', { timeZone: 'Indian/Reunion', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  function marquerEtapes() {
    document.querySelectorAll('.sg-etape').forEach(function (li) {
      li.dataset.actif = li.dataset.role === role() && etat !== 'ok-final' ? '1' : '0';
    });
  }

  function montrerStatut(classe, html) {
    statut.className = 'sg-statut ' + classe;
    statut.innerHTML = html;
    statut.hidden = false;
  }
  function cacherStatut() { statut.hidden = true; statut.innerHTML = ''; }

  function maj() {
    var occupe = etat === 'envoi';
    var traceOk = pad.estSuffisante(), nomOk = nom.value.trim().length > 0;
    cadre.dataset.trace = pad.estVide() ? '0' : '1';
    cadre.dataset.verrou = occupe ? '1' : '0';
    btnEff.disabled = occupe || (pad.estVide() && etat !== 'echec');
    btnVal.disabled = occupe || etat === 'ok' || !(traceOk && nomOk);
    nom.disabled = occupe;
    aide.textContent = occupe ? '' : !nomOk ? 'Saisissez le nom du signataire.' : !traceOk ? 'Signez dans le cadre avec le doigt.' : '';
  }

  function afficherEtape() {
    if (idx >= etapes.length) { return afficherFin(); }
    var r = role();
    etat = 'saisie';
    titre.textContent = 'Signature du ' + LIBELLE[r].toLowerCase();
    nomLabel.textContent = r === 'transporteur' ? 'Nom du transporteur' : 'Nom du destinataire (à saisir)';
    nom.value = r === 'transporteur' ? cfg.nomParDefaut : '';
    pad.clear();
    cacherStatut();
    panneau.hidden = false;
    marquerEtapes(); maj();
    var reste = retrouver(r);
    if (reste) {
      // Une signature non envoyée a été retrouvée (rechargement, batterie, réseau) : on la propose, on ne la perd pas.
      enAttente = reste; nom.value = reste.nom; etat = 'echec';
      montrerEchec('Une signature non envoyée a été retrouvée sur cet appareil. Elle n\'est PAS encore enregistrée.', true);
      maj();
    } else if (r === 'destinataire') { nom.focus(); }
    try { cadre.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignoré */ }
  }

  function afficherFin() {
    etat = 'ok-final';
    panneau.hidden = true; cacherStatut(); fin.hidden = false;
    document.querySelectorAll('.sg-etape').forEach(function (li) { li.dataset.etat = 'fait'; li.dataset.actif = '0'; li.querySelector('.sg-puce').textContent = '✓'; });
    try { fin.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignoré */ }
  }

  function montrerEchec(message, retrouvee) {
    montrerStatut('sg-statut--echec',
      '<p>⚠ ' + message + '</p>' +
      (retrouvee ? '' : '<p>Votre signature est conservée : elle reste sur l\'écran. Vérifiez la connexion puis réessayez.</p>') +
      '<button type="button" class="sg-btn sg-btn--prim" id="sg-reessayer" data-testid="sg-reessayer">Réessayer l\'envoi</button>');
    $('sg-reessayer').addEventListener('click', function () { envoyer(); });
  }

  // Une tentative d'enregistrement : { ok } | { definitif, message } | { reseau }
  async function tenter(v) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var minuteur = ctl ? setTimeout(function () { ctl.abort(); }, DELAI_REPONSE) : null;
    try {
      var rep = await fetch('/api/admin/bl-signatures', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delivery_note_id: cfg.noteId, role: v.role, signataire_nom: v.nom, signature_data: v.data }),
        signal: ctl ? ctl.signal : undefined
      });
      var j = null; try { j = await rep.json(); } catch (e) { /* corps non JSON */ }
      if (rep.ok && j && j.ok) return { ok: true, signed_at: j.signed_at };
      if (rep.status === 401) return { definitif: true, message: 'Votre session a expiré. Reconnectez-vous : la signature est conservée sur cet appareil.' };
      if (rep.status >= 400 && rep.status < 500 && rep.status !== 408 && rep.status !== 429) return { definitif: true, message: (j && j.erreur) || 'Le serveur a refusé la signature.' };
      return { reseau: true };
    } catch (e) {
      return { reseau: true };
    } finally { if (minuteur) clearTimeout(minuteur); }
  }

  async function envoyer() {
    if (!enAttente || etat === 'envoi') return;
    etat = 'envoi'; maj();
    montrerStatut('sg-statut--cours', '<p>Enregistrement en cours… ne quittez pas cet écran.</p>');
    var resultat = null;
    for (var essai = 0; essai <= DELAIS.length; essai++) {
      resultat = await tenter(enAttente);
      if (resultat.ok || resultat.definitif) break;
      if (essai < DELAIS.length) await pause(DELAIS[essai]);
    }
    if (resultat.ok) return reussi(resultat);
    etat = 'echec'; maj();
    if (resultat.definitif) montrerEchec(resultat.message, false);
    else montrerEchec('Signature NON enregistrée : la connexion est trop faible.', false);
  }

  function reussi(resultat) {
    var r = enAttente.role;
    oublier(r); enAttente = null;
    etat = 'ok'; maj();
    var li = document.querySelector('.sg-etape[data-role="' + r + '"]');
    if (li) { li.dataset.etat = 'fait'; li.querySelector('.sg-puce').textContent = '✓'; }
    var dernier = idx >= etapes.length - 1;
    montrerStatut('sg-statut--ok',
      '<p><span class="sg-gros-v" aria-hidden="true">✓</span> Signature du ' + LIBELLE[r].toLowerCase() + ' enregistrée</p>' +
      '<p>' + heure(resultat.signed_at) + '</p>' +
      '<button type="button" class="sg-btn sg-btn--prim" id="sg-suite" data-testid="sg-suite">' + (dernier ? 'Terminer' : 'Passer au destinataire →') + '</button>');
    $('sg-suite').addEventListener('click', function () { idx++; afficherEtape(); });
    panneau.hidden = true;
    try { statut.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignoré */ }
  }

  btnEff.addEventListener('click', function () {
    if (etat === 'envoi') return;
    if (etat === 'echec') { oublier(role()); enAttente = null; etat = 'saisie'; cacherStatut(); }
    pad.clear(); maj();
  });

  btnVal.addEventListener('click', function () {
    if (btnVal.disabled) return;
    enAttente = { role: role(), nom: nom.value.trim(), data: pad.versPng() };
    sauver(enAttente);                   // sauvegarde AVANT l'envoi : rien ne se perd si l'écran se ferme
    envoyer();
  });

  nom.addEventListener('input', maj);
  window.addEventListener('online', function () { if (etat === 'echec' && enAttente) envoyer(); });
  window.addEventListener('beforeunload', function (e) {
    if (etat === 'envoi' || etat === 'echec') { e.preventDefault(); e.returnValue = ''; }
  });

  if (etapes.length) afficherEtape(); else marquerEtapes();
})();
