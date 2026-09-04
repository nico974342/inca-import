-- Charges fixes de l'entreprise (loyer, assurance, emprunt, salaires...),
-- pour calculer un vrai résultat net (marge HT − charges) sur /admin/marges
-- et un point mort qui reflète les charges réelles plutôt qu'une constante
-- fixée à la main.
--
-- Une charge n'est jamais supprimée : on la clôture en renseignant date_fin,
-- pour que l'historique (mois passés) reste exact même après la fin d'un
-- engagement (ex. un emprunt soldé).
--
-- Équivalent mensuel utilisé pour tous les calculs :
--   mensuelle      -> montant_ht
--   trimestrielle  -> montant_ht / 3
--   annuelle       -> montant_ht / 12
--   ponctuelle     -> montant_ht en entier, sur le seul mois de date_debut
-- (voir src/lib/charges.ts, seule source de vérité pour cette conversion —
-- ne pas la recalculer ailleurs).
--
-- Pour un emprunt : périodicité 'mensuelle', montant_ht = la mensualité,
-- date_debut = date de première échéance, date_fin = date de dernière
-- échéance. Le prêt disparaît automatiquement du calcul après date_fin.

CREATE TABLE IF NOT EXISTS charges (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  libelle      TEXT NOT NULL,
  categorie    TEXT NOT NULL CHECK (categorie IN (
                 'loyer', 'assurance', 'frais_bancaires', 'remboursement_emprunt',
                 'salaires', 'vehicule', 'telecom', 'logiciels', 'autre'
               )),
  montant_ht   NUMERIC(10, 2) NOT NULL CHECK (montant_ht >= 0),
  periodicite  TEXT NOT NULL CHECK (periodicite IN ('mensuelle', 'trimestrielle', 'annuelle', 'ponctuelle')),
  date_debut   DATE NOT NULL,
  date_fin     DATE,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT charges_date_fin_apres_debut CHECK (date_fin IS NULL OR date_fin >= date_debut)
);

CREATE INDEX IF NOT EXISTS charges_categorie_idx ON charges(categorie);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Même politique que price_groups / stock_receptions : lue et écrite
-- uniquement côté serveur via la clé service_role. Pas de policy publique.
ALTER TABLE charges ENABLE ROW LEVEL SECURITY;
