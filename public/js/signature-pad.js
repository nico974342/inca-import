/**
 * Zone de signature tactile (doigt, stylet, souris) — JavaScript simple, sans dépendance.
 * Le tracé est mémorisé en coordonnées relatives (0..1) : il survit à une rotation d'écran ou à un redimensionnement,
 * et l'image exportée garde toujours le même rendu quelle que soit la taille de l'écran.
 *
 *   const pad = IncaSignaturePad(canvas, { onChange });
 *   pad.clear(); pad.estSuffisante(); pad.versPng();   // PNG transparent, 900 px de large
 */
(function (global) {
  'use strict';

  var LARGEUR_EXPORT = 900;       // px de l'image enregistrée
  var LONGUEUR_MIN = 0.3;         // longueur du tracé minimale, en largeurs de cadre (évite un tap accidentel)
  var ENCRE = '#0b1b3a';

  function creer(canvas, options) {
    options = options || {};
    var ctx = canvas.getContext('2d');
    var traits = [];              // [[{x,y}, ...], ...] en coordonnées relatives
    var courant = null;
    var idPointeur = null;
    var largeur = 0, hauteur = 0;

    function epaisseur(largeurCadre) { return Math.max(3.5, largeurCadre / 110); }

    function point(e) {
      var r = canvas.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    }

    // Dessine tous les traits dans un contexte de taille w × h (courbes lissées par points milieux).
    function dessiner(c, w, h, lw) {
      c.clearRect(0, 0, w, h);
      c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = ENCRE; c.fillStyle = ENCRE; c.lineWidth = lw;
      traits.forEach(function (t) {
        if (t.length === 1) {   // simple appui : un point bien visible
          c.beginPath(); c.arc(t[0].x * w, t[0].y * h, lw * 0.6, 0, Math.PI * 2); c.fill(); return;
        }
        c.beginPath();
        c.moveTo(t[0].x * w, t[0].y * h);
        for (var i = 1; i < t.length - 1; i++) {
          var mx = (t[i].x + t[i + 1].x) / 2 * w, my = (t[i].y + t[i + 1].y) / 2 * h;
          c.quadraticCurveTo(t[i].x * w, t[i].y * h, mx, my);
        }
        var d = t[t.length - 1];
        c.lineTo(d.x * w, d.y * h);
        c.stroke();
      });
    }

    function redessiner() {
      var dpr = global.devicePixelRatio || 1;
      var r = canvas.getBoundingClientRect();
      largeur = r.width; hauteur = r.height;
      if (!largeur || !hauteur) return;
      var pw = Math.round(largeur * dpr), ph = Math.round(hauteur * dpr);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      dessiner(ctx, pw, ph, epaisseur(largeur) * dpr);
    }

    function changement() { if (options.onChange) options.onChange(api); }

    function debut(e) {
      if (idPointeur !== null) return;                       // un seul doigt : on ignore la paume ou un second contact
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      idPointeur = e.pointerId;
      try { canvas.setPointerCapture(e.pointerId); } catch (x) { /* ignoré */ }
      courant = [point(e)];
      traits.push(courant);
      redessiner(); changement();
      e.preventDefault();
    }
    function mouvement(e) {
      if (e.pointerId !== idPointeur || !courant) return;
      // pointeurs fusionnés : on exploite tous les points intermédiaires pour un tracé fluide
      var evts = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      (evts && evts.length ? evts : [e]).forEach(function (ev) { courant.push(point(ev)); });
      redessiner();
      e.preventDefault();
    }
    function fin(e) {
      if (e.pointerId !== idPointeur) return;
      idPointeur = null; courant = null;
      changement();
      e.preventDefault();
    }

    canvas.addEventListener('pointerdown', debut);
    canvas.addEventListener('pointermove', mouvement);
    canvas.addEventListener('pointerup', fin);
    canvas.addEventListener('pointercancel', fin);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    var observateur = typeof ResizeObserver === 'function' ? new ResizeObserver(redessiner) : null;
    if (observateur) observateur.observe(canvas); else global.addEventListener('resize', redessiner);
    redessiner();

    var api = {
      /** Efface tout pour recommencer. */
      clear: function () { traits = []; courant = null; idPointeur = null; redessiner(); changement(); },
      /** Longueur du tracé, en largeurs de cadre. */
      longueur: function () {
        var l = 0, r = canvas.getBoundingClientRect(), ratio = r.height / (r.width || 1);
        traits.forEach(function (t) {
          if (t.length === 1) l += 0.02;
          for (var i = 1; i < t.length; i++) l += Math.sqrt(Math.pow(t[i].x - t[i - 1].x, 2) + Math.pow((t[i].y - t[i - 1].y) * ratio, 2));
        });
        return l;
      },
      estVide: function () { return traits.length === 0; },
      /** Vrai si le tracé est assez long pour être une vraie signature. */
      estSuffisante: function () { return api.longueur() >= LONGUEUR_MIN; },
      /** PNG transparent de 900 px de large, même proportions que le cadre affiché. */
      versPng: function () {
        var r = canvas.getBoundingClientRect();
        var h = Math.max(1, Math.round(LARGEUR_EXPORT * (r.height / (r.width || 1))));
        var c = document.createElement('canvas');
        c.width = LARGEUR_EXPORT; c.height = h;
        dessiner(c.getContext('2d'), LARGEUR_EXPORT, h, epaisseur(LARGEUR_EXPORT) * 1.15);
        return c.toDataURL('image/png');
      },
      detruire: function () { if (observateur) observateur.disconnect(); }
    };
    return api;
  }

  global.IncaSignaturePad = creer;
})(window);
