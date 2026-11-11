-- CRM — M2 : activités commerciales (appels, visites, notes), relances, interlocuteurs, délégations, suggestions masquées.
-- NON APPLIQUÉE en production : à exécuter seulement sur accord explicite, après sauvegarde. Dépend de M1 (client_accounts.responsable_id).
-- ADDITIVE : aucune donnée existante n'est modifiée. Les 6 tâches de weekly_tasks sont conservées telles quelles (contenu, état, dates) :
-- elles deviennent des « tâches générales » (type = 'tache', sans client). Indépendante de la TVA. Rejouable sans erreur.
--
-- Principes garantis PAR LA BASE (indépendamment de l'interface) :
--   * Droits réels : un commercial n'agit que sur les clients de SON portefeuille (responsable_id = lui) ou, avec une DÉLÉGATION explicite
--     accordée par un administrateur, sur le portefeuille d'un autre commercial. Un client sans responsable doit d'abord être pris en charge (M1).
--     Un administrateur agit partout. Le rôle de l'acteur est transmis par le serveur (session) ; la base applique les règles.
--   * Une interaction n'est JAMAIS supprimée (ni DELETE, ni TRUNCATE). Corrections : auteur sous 24 h, puis administrateur avec motif ;
--     annulation motivée ; chaque correction est journalisée (admin_audit_logs) avec l'ancien et le nouveau contenu.
--   * Une relance programmée n'est jamais fermée par un autre échange : seule une action volontaire (clôture, annulation, ou « cet échange
--     clôture cette relance » demandé explicitement) la ferme. Elle ne se supprime pas.
--   * « Commande envisagée » est un RÉSULTAT d'échange : aucune fonction de ce fichier n'écrit dans orders.
--   * Les écritures sont idempotentes (clé fournie par le formulaire) : un double appui ne crée ni doublon d'activité ni doublon de relance.

BEGIN;

-- ── 0. Date du jour à La Réunion (UTC+4, sans heure d'été) ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION crm_aujourdhui() RETURNS date
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$ SELECT ((now() AT TIME ZONE 'UTC') + interval '4 hours')::date $$;

-- ── 1. Interactions (appels, visites, messages, notes) ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_interactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cle_idempotence   uuid NOT NULL,
  client_id         uuid REFERENCES client_accounts(id) ON DELETE SET NULL,
  client_libelle    text NOT NULL,                                  -- nom du client au moment de la saisie (l'historique survit à la suppression d'un compte)
  type              text NOT NULL,
  resultat          text,
  commentaire       text,
  prochaine_action  text,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL,
  created_by_email  text NOT NULL,
  modifiee_le       timestamptz,
  nb_modifications  integer NOT NULL DEFAULT 0,
  annulee_le        timestamptz,
  annulee_par       text,
  annulation_motif  text,
  CONSTRAINT client_interactions_type_check CHECK (type IN ('appel', 'visite', 'message', 'note')),
  CONSTRAINT client_interactions_resultat_check CHECK (resultat IS NULL OR resultat IN ('pas_de_reponse', 'message_laisse', 'echange', 'rdv_pris', 'commande_envisagee', 'refus', 'autre')),
  CONSTRAINT client_interactions_action_check CHECK (prochaine_action IS NULL OR prochaine_action IN ('rappeler', 'visiter', 'envoyer_offre', 'preparer_commande', 'aucune')),
  CONSTRAINT client_interactions_resultat_requis CHECK (type NOT IN ('appel', 'visite') OR resultat IS NOT NULL),
  CONSTRAINT client_interactions_precision_requise CHECK (resultat IS DISTINCT FROM 'autre' OR length(btrim(coalesce(commentaire, ''))) >= 3),
  CONSTRAINT client_interactions_note_commentee CHECK (type <> 'note' OR length(btrim(coalesce(commentaire, ''))) >= 3),
  CONSTRAINT client_interactions_commentaire_taille CHECK (commentaire IS NULL OR length(commentaire) <= 2000),
  CONSTRAINT client_interactions_annulation_coherente CHECK ((annulee_le IS NULL) = (annulee_par IS NULL) AND (annulee_le IS NULL) = (annulation_motif IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS client_interactions_cle_idx ON client_interactions (cle_idempotence);
CREATE INDEX IF NOT EXISTS client_interactions_client_idx ON client_interactions (client_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS client_interactions_auteur_idx ON client_interactions (created_by, occurred_at DESC);

-- ── 2. Interlocuteurs supplémentaires (le contact principal reste celui de la fiche client) ──────────────────────────
CREATE TABLE IF NOT EXISTS client_contacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
  nom               text NOT NULL,
  fonction          text,
  telephone         text,
  email             text,
  principal         boolean NOT NULL DEFAULT false,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by_email  text,
  modifie_le        timestamptz,
  CONSTRAINT client_contacts_nom_check CHECK (length(btrim(nom)) >= 2 AND length(nom) <= 120)
);
CREATE INDEX IF NOT EXISTS client_contacts_client_idx ON client_contacts (client_id);
CREATE UNIQUE INDEX IF NOT EXISTS client_contacts_principal_idx ON client_contacts (client_id) WHERE principal;

-- ── 3. Relances et rendez-vous : extension de weekly_tasks (les lignes existantes ne sont pas touchées) ──────────────
ALTER TABLE weekly_tasks
  ADD COLUMN IF NOT EXISTS type              text NOT NULL DEFAULT 'tache',
  ADD COLUMN IF NOT EXISTS client_id         uuid,
  ADD COLUMN IF NOT EXISTS client_libelle    text,
  ADD COLUMN IF NOT EXISTS assigne_a         uuid,
  ADD COLUMN IF NOT EXISTS assigne_email     text,
  ADD COLUMN IF NOT EXISTS echeance          date,
  ADD COLUMN IF NOT EXISTS heure             time,
  ADD COLUMN IF NOT EXISTS echeance_initiale date,
  ADD COLUMN IF NOT EXISTS reports           integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interaction_id    uuid,
  ADD COLUMN IF NOT EXISTS cle_idempotence   uuid,
  ADD COLUMN IF NOT EXISTS cree_par          uuid,
  ADD COLUMN IF NOT EXISTS cree_par_email    text,
  ADD COLUMN IF NOT EXISTS annulee_le        timestamptz,
  ADD COLUMN IF NOT EXISTS annulee_par       text,
  ADD COLUMN IF NOT EXISTS annulation_motif  text;
-- Statut dérivé (jamais saisi à la main) : annulée > faite > à faire. Colonne calculée : les tâches existantes reçoivent leur statut sans être modifiées.
ALTER TABLE weekly_tasks
  ADD COLUMN IF NOT EXISTS statut text GENERATED ALWAYS AS (CASE WHEN annulee_le IS NOT NULL THEN 'annulee' WHEN done THEN 'faite' ELSE 'a_faire' END) STORED;

ALTER TABLE weekly_tasks DROP CONSTRAINT IF EXISTS weekly_tasks_type_check;
ALTER TABLE weekly_tasks ADD CONSTRAINT weekly_tasks_type_check CHECK (type IN ('tache', 'relance', 'rendez_vous'));
ALTER TABLE weekly_tasks DROP CONSTRAINT IF EXISTS weekly_tasks_relance_complete;
ALTER TABLE weekly_tasks ADD CONSTRAINT weekly_tasks_relance_complete
  CHECK (type = 'tache' OR (assigne_a IS NOT NULL AND assigne_email IS NOT NULL AND echeance IS NOT NULL AND cree_par IS NOT NULL));
ALTER TABLE weekly_tasks DROP CONSTRAINT IF EXISTS weekly_tasks_annulation_coherente;
ALTER TABLE weekly_tasks ADD CONSTRAINT weekly_tasks_annulation_coherente
  CHECK ((annulee_le IS NULL) = (annulee_par IS NULL) AND (annulee_le IS NULL) = (annulation_motif IS NULL));
ALTER TABLE weekly_tasks DROP CONSTRAINT IF EXISTS weekly_tasks_reports_check;
ALTER TABLE weekly_tasks ADD CONSTRAINT weekly_tasks_reports_check CHECK (reports >= 0);
ALTER TABLE weekly_tasks DROP CONSTRAINT IF EXISTS weekly_tasks_client_fkey;
ALTER TABLE weekly_tasks ADD CONSTRAINT weekly_tasks_client_fkey FOREIGN KEY (client_id) REFERENCES client_accounts(id) ON DELETE SET NULL;
ALTER TABLE weekly_tasks DROP CONSTRAINT IF EXISTS weekly_tasks_interaction_fkey;
ALTER TABLE weekly_tasks ADD CONSTRAINT weekly_tasks_interaction_fkey FOREIGN KEY (interaction_id) REFERENCES client_interactions(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS weekly_tasks_cle_idx ON weekly_tasks (cle_idempotence) WHERE cle_idempotence IS NOT NULL;
CREATE INDEX IF NOT EXISTS weekly_tasks_relances_idx ON weekly_tasks (assigne_a, echeance) WHERE type <> 'tache' AND NOT done AND annulee_le IS NULL;
CREATE INDEX IF NOT EXISTS weekly_tasks_client_idx ON weekly_tasks (client_id) WHERE client_id IS NOT NULL;

-- ── 4. Délégations : autorisation explicite d'un administrateur pour intervenir sur le portefeuille d'un autre commercial ─
CREATE TABLE IF NOT EXISTS crm_delegations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commercial_id     uuid NOT NULL,
  commercial_email  text NOT NULL,
  proprietaire_id   uuid NOT NULL,
  proprietaire_email text NOT NULL,
  accorde_par       text NOT NULL,
  accorde_le        timestamptz NOT NULL DEFAULT now(),
  expire_le         date,
  motif             text NOT NULL,
  revoque_le        timestamptz,
  revoque_par       text,
  revocation_motif  text,
  CONSTRAINT crm_delegations_distinct CHECK (commercial_id <> proprietaire_id),
  CONSTRAINT crm_delegations_motif CHECK (length(btrim(motif)) >= 3),
  CONSTRAINT crm_delegations_revocation_coherente CHECK ((revoque_le IS NULL) = (revoque_par IS NULL) AND (revoque_le IS NULL) = (revocation_motif IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_delegations_active_idx ON crm_delegations (commercial_id, proprietaire_id) WHERE revoque_le IS NULL;

-- ── 5. Suggestions ignorées ou reportées (par utilisateur) : ne concerne JAMAIS une relance programmée ─────────────────
CREATE TABLE IF NOT EXISTS crm_suggestions_masquees (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
  regle       text NOT NULL,
  jusqu_au    date NOT NULL,
  par_id      uuid NOT NULL,
  par_email   text NOT NULL,
  motif       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_suggestions_masquees_regle CHECK (regle ~ '^[a-z_]{2,60}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_suggestions_masquees_cle_idx ON crm_suggestions_masquees (client_id, regle, par_id);

-- ── 6. Fermeture des tables : serveur seulement ──────────────────────────────────────────────────────────────────────
ALTER TABLE client_interactions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_contacts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_delegations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_suggestions_masquees  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON client_interactions, client_contacts, crm_delegations, crm_suggestions_masquees FROM anon, authenticated;

-- ── 7. Protections (déclencheurs) ────────────────────────────────────────────────────────────────────────────────────

-- Interactions : jamais supprimées ; modifiables uniquement par les fonctions ci-dessous (réglage de transaction) ; colonnes d'origine immuables.
-- Seule exception hors réglage : le lien client passe à NULL parce que le compte a été supprimé (ON DELETE SET NULL) ; le libellé est conservé.
CREATE OR REPLACE FUNCTION client_interactions_proteger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'INTERACTION_NON_SUPPRIMABLE : une activité ne se supprime pas (annulation motivée par un administrateur)';
  END IF;
  IF OLD.client_id IS NOT NULL AND NEW.client_id IS NULL AND NOT EXISTS (SELECT 1 FROM client_accounts WHERE id = OLD.client_id)
     AND (NEW.type, NEW.resultat, NEW.commentaire, NEW.prochaine_action, NEW.occurred_at, NEW.created_at, NEW.created_by, NEW.created_by_email, NEW.cle_idempotence, NEW.client_libelle)
         IS NOT DISTINCT FROM (OLD.type, OLD.resultat, OLD.commentaire, OLD.prochaine_action, OLD.occurred_at, OLD.created_at, OLD.created_by, OLD.created_by_email, OLD.cle_idempotence, OLD.client_libelle) THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('inca.crm_ecriture', true), '') <> '1' THEN
    RAISE EXCEPTION 'INTERACTION_PROTEGEE : passer par interaction_corriger / interaction_annuler (journalisés)';
  END IF;
  IF (NEW.id, NEW.client_id, NEW.client_libelle, NEW.type, NEW.occurred_at, NEW.created_at, NEW.created_by, NEW.created_by_email, NEW.cle_idempotence)
     IS DISTINCT FROM (OLD.id, OLD.client_id, OLD.client_libelle, OLD.type, OLD.occurred_at, OLD.created_at, OLD.created_by, OLD.created_by_email, OLD.cle_idempotence) THEN
    RAISE EXCEPTION 'INTERACTION_IMMUABLE : client, type, date, auteur et clé ne changent jamais';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_client_interactions_proteger ON client_interactions;
CREATE TRIGGER trg_client_interactions_proteger BEFORE UPDATE OR DELETE ON client_interactions FOR EACH ROW EXECUTE FUNCTION client_interactions_proteger();
DROP TRIGGER IF EXISTS trg_client_interactions_proteger_truncate ON client_interactions;
CREATE TRIGGER trg_client_interactions_proteger_truncate BEFORE TRUNCATE ON client_interactions FOR EACH STATEMENT EXECUTE FUNCTION client_interactions_proteger();

-- Relances et rendez-vous : jamais supprimés (annulation motivée) ; modifiables uniquement par les fonctions ; une tâche générale ne peut pas être
-- transformée en relance à la main. Les tâches générales gardent leur comportement d'origine (ajout, case à cocher).
CREATE OR REPLACE FUNCTION weekly_tasks_proteger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM weekly_tasks WHERE type <> 'tache') THEN RAISE EXCEPTION 'RELANCE_NON_SUPPRIMABLE : des relances existent, la table ne se vide pas'; END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.type <> 'tache' THEN RAISE EXCEPTION 'RELANCE_NON_SUPPRIMABLE : une relance ne se supprime pas (annulation motivée)'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.client_id IS NOT NULL AND NEW.client_id IS NULL AND NOT EXISTS (SELECT 1 FROM client_accounts WHERE id = OLD.client_id)
     AND (NEW.content, NEW.done, NEW.done_at, NEW.type, NEW.assigne_a, NEW.echeance, NEW.heure, NEW.reports, NEW.annulee_le)
         IS NOT DISTINCT FROM (OLD.content, OLD.done, OLD.done_at, OLD.type, OLD.assigne_a, OLD.echeance, OLD.heure, OLD.reports, OLD.annulee_le) THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('inca.crm_ecriture', true), '') <> '1' THEN
    IF OLD.type <> 'tache' THEN RAISE EXCEPTION 'RELANCE_PROTEGEE : passer par les fonctions de relance (journalisées)'; END IF;
    IF (NEW.type, NEW.client_id, NEW.assigne_a, NEW.assigne_email, NEW.echeance, NEW.heure, NEW.reports, NEW.annulee_le, NEW.interaction_id, NEW.cle_idempotence)
       IS DISTINCT FROM (OLD.type, OLD.client_id, OLD.assigne_a, OLD.assigne_email, OLD.echeance, OLD.heure, OLD.reports, OLD.annulee_le, OLD.interaction_id, OLD.cle_idempotence) THEN
      RAISE EXCEPTION 'RELANCE_PROTEGEE : une tâche générale ne devient pas une relance sans passer par les fonctions de relance';
    END IF;
  ELSIF (NEW.id, NEW.type, NEW.created_at, NEW.cle_idempotence, NEW.cree_par) IS DISTINCT FROM (OLD.id, OLD.type, OLD.created_at, OLD.cle_idempotence, OLD.cree_par)
        OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'RELANCE_IMMUABLE : type, client, origine et clé ne changent jamais';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_weekly_tasks_proteger ON weekly_tasks;
CREATE TRIGGER trg_weekly_tasks_proteger BEFORE UPDATE OR DELETE ON weekly_tasks FOR EACH ROW EXECUTE FUNCTION weekly_tasks_proteger();
DROP TRIGGER IF EXISTS trg_weekly_tasks_proteger_truncate ON weekly_tasks;
CREATE TRIGGER trg_weekly_tasks_proteger_truncate BEFORE TRUNCATE ON weekly_tasks FOR EACH STATEMENT EXECUTE FUNCTION weekly_tasks_proteger();

-- Délégations : jamais supprimées ni modifiées à la main (révocation par la fonction, journalisée).
CREATE OR REPLACE FUNCTION crm_delegations_proteger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'DELEGATION_NON_SUPPRIMABLE : une délégation se révoque, elle ne se supprime pas'; END IF;
  IF coalesce(current_setting('inca.crm_ecriture', true), '') <> '1' THEN RAISE EXCEPTION 'DELEGATION_PROTEGEE : passer par delegation_accorder / delegation_revoquer (journalisés)'; END IF;
  IF (NEW.commercial_id, NEW.proprietaire_id, NEW.accorde_par, NEW.accorde_le, NEW.expire_le, NEW.motif) IS DISTINCT FROM (OLD.commercial_id, OLD.proprietaire_id, OLD.accorde_par, OLD.accorde_le, OLD.expire_le, OLD.motif) THEN
    RAISE EXCEPTION 'DELEGATION_IMMUABLE : seule la révocation est possible';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_crm_delegations_proteger ON crm_delegations;
CREATE TRIGGER trg_crm_delegations_proteger BEFORE UPDATE OR DELETE ON crm_delegations FOR EACH ROW EXECUTE FUNCTION crm_delegations_proteger();
DROP TRIGGER IF EXISTS trg_crm_delegations_proteger_truncate ON crm_delegations;
CREATE TRIGGER trg_crm_delegations_proteger_truncate BEFORE TRUNCATE ON crm_delegations FOR EACH STATEMENT EXECUTE FUNCTION crm_delegations_proteger();

-- ── 8. Droits réels ──────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION crm_verifier_acteur(p_id uuid, p_email text, p_role text) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('admin', 'commercial') OR p_id IS NULL OR nullif(btrim(coalesce(p_email, '')), '') IS NULL THEN RAISE EXCEPTION 'ACTEUR_INVALIDE'; END IF;
END $$;

-- Un acteur peut-il agir (noter, relancer, gérer les interlocuteurs) sur ce client ? Administrateur : oui. Commercial : seulement si le client est dans SON
-- portefeuille, ou si une délégation active (non révoquée, non expirée) lui ouvre le portefeuille de son responsable. Client sans responsable : non (prise en charge d'abord).
CREATE OR REPLACE FUNCTION crm_peut_agir(p_client_id uuid, p_acteur_id uuid, p_role text) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE v_existe boolean; v_resp uuid;
BEGIN
  SELECT true, responsable_id INTO v_existe, v_resp FROM client_accounts WHERE id = p_client_id;
  IF v_existe IS NOT TRUE THEN RETURN false; END IF;
  IF p_role = 'admin' THEN RETURN p_acteur_id IS NOT NULL; END IF;
  IF p_role IS DISTINCT FROM 'commercial' OR p_acteur_id IS NULL OR v_resp IS NULL THEN RETURN false; END IF;
  IF v_resp = p_acteur_id THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM crm_delegations d WHERE d.commercial_id = p_acteur_id AND d.proprietaire_id = v_resp AND d.revoque_le IS NULL
                   AND (d.expire_le IS NULL OR d.expire_le >= crm_aujourdhui()));
END $$;

-- Libellés de la prochaine action (titre par défaut d'une relance)
CREATE OR REPLACE FUNCTION crm_titre_action(p_action text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE p_action WHEN 'rappeler' THEN 'Rappeler' WHEN 'visiter' THEN 'Visiter' WHEN 'envoyer_offre' THEN 'Envoyer une offre'
                       WHEN 'preparer_commande' THEN 'Préparer une commande' ELSE 'Relance' END $$;

-- ── 9. Noter une activité (+ clôturer une relance si demandé + programmer la suivante) : UNE transaction, idempotente ───
CREATE OR REPLACE FUNCTION interaction_noter(
  p_cle uuid, p_client_id uuid, p_type text, p_resultat text, p_commentaire text, p_prochaine_action text, p_occurred_at timestamptz,
  p_relance_id uuid, p_relance_echeance date, p_relance_heure time, p_relance_titre text,
  p_assigne_id uuid, p_assigne_email text,
  p_acteur_id uuid, p_acteur_email text, p_acteur_role text
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  c          client_accounts%ROWTYPE;
  e          client_interactions%ROWTYPE;
  t          weekly_tasks%ROWTYPE;
  v_com      text := nullif(btrim(coalesce(p_commentaire, '')), '');
  v_action   text := p_prochaine_action;
  v_quand    timestamptz := coalesce(p_occurred_at, now());
  v_id       uuid; v_relance uuid; v_ferme uuid; v_type_rel text; v_titre text; v_a_id uuid; v_a_mel text;
BEGIN
  PERFORM crm_verifier_acteur(p_acteur_id, p_acteur_email, p_acteur_role);
  IF p_cle IS NULL THEN RAISE EXCEPTION 'CLE_REQUISE'; END IF;

  -- Rejeu (double appui, réseau instable) : on renvoie l'activité déjà enregistrée, sans rien dupliquer
  SELECT * INTO e FROM client_interactions WHERE cle_idempotence = p_cle;
  IF FOUND THEN
    IF e.created_by <> p_acteur_id THEN RAISE EXCEPTION 'CLE_DEJA_UTILISEE'; END IF;
    RETURN jsonb_build_object('interaction_id', e.id, 'relance_id', (SELECT id FROM weekly_tasks WHERE cle_idempotence = p_cle), 'deja', true);
  END IF;

  SELECT * INTO c FROM client_accounts WHERE id = p_client_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLIENT_INTROUVABLE'; END IF;
  IF NOT crm_peut_agir(p_client_id, p_acteur_id, p_acteur_role) THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;

  IF p_type IS NULL OR p_type NOT IN ('appel', 'visite', 'message', 'note') THEN RAISE EXCEPTION 'TYPE_INVALIDE'; END IF;
  IF p_resultat IS NOT NULL AND p_resultat NOT IN ('pas_de_reponse', 'message_laisse', 'echange', 'rdv_pris', 'commande_envisagee', 'refus', 'autre') THEN RAISE EXCEPTION 'RESULTAT_INVALIDE'; END IF;
  IF p_type IN ('appel', 'visite') AND p_resultat IS NULL THEN RAISE EXCEPTION 'RESULTAT_REQUIS'; END IF;
  IF (p_resultat = 'autre' OR p_type = 'note') AND (v_com IS NULL OR length(v_com) < 3) THEN RAISE EXCEPTION 'COMMENTAIRE_REQUIS'; END IF;
  IF v_com IS NOT NULL AND length(v_com) > 2000 THEN RAISE EXCEPTION 'COMMENTAIRE_TROP_LONG'; END IF;
  IF v_action IS NOT NULL AND v_action NOT IN ('rappeler', 'visiter', 'envoyer_offre', 'preparer_commande', 'aucune') THEN RAISE EXCEPTION 'ACTION_INVALIDE'; END IF;
  IF v_quand > now() + interval '5 minutes' OR v_quand < now() - interval '30 days' THEN RAISE EXCEPTION 'DATE_INVALIDE'; END IF;

  -- Prochaine action : une action à faire exige une échéance ; « aucune » n'en a pas
  IF p_relance_echeance IS NOT NULL AND coalesce(v_action, 'aucune') = 'aucune' AND v_action IS NOT NULL THEN RAISE EXCEPTION 'ACTION_INCOHERENTE'; END IF;
  IF p_relance_echeance IS NOT NULL AND v_action IS NULL THEN v_action := 'rappeler'; END IF;
  IF v_action IS NOT NULL AND v_action <> 'aucune' AND p_relance_echeance IS NULL THEN RAISE EXCEPTION 'ECHEANCE_REQUISE'; END IF;
  IF p_relance_echeance IS NOT NULL AND (p_relance_echeance < crm_aujourdhui() OR p_relance_echeance > crm_aujourdhui() + 366) THEN RAISE EXCEPTION 'ECHEANCE_INVALIDE'; END IF;

  -- Relance à clôturer par cet échange : UNIQUEMENT si demandé explicitement
  IF p_relance_id IS NOT NULL THEN
    SELECT * INTO t FROM weekly_tasks WHERE id = p_relance_id FOR UPDATE;
    IF NOT FOUND OR t.type = 'tache' THEN RAISE EXCEPTION 'RELANCE_INTROUVABLE'; END IF;
    IF t.client_id IS DISTINCT FROM p_client_id THEN RAISE EXCEPTION 'RELANCE_AUTRE_CLIENT'; END IF;
    IF t.statut <> 'a_faire' THEN RAISE EXCEPTION 'RELANCE_DEJA_TRAITEE'; END IF;
  END IF;

  -- Responsable de la relance suivante : l'acteur, sauf choix explicite d'un administrateur
  v_a_id := coalesce(p_assigne_id, p_acteur_id); v_a_mel := CASE WHEN p_assigne_id IS NULL THEN p_acteur_email ELSE nullif(btrim(coalesce(p_assigne_email, '')), '') END;
  IF v_a_id <> p_acteur_id AND p_acteur_role <> 'admin' THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF v_a_mel IS NULL THEN RAISE EXCEPTION 'RESPONSABLE_INVALIDE'; END IF;

  PERFORM set_config('inca.crm_ecriture', '1', true);
  INSERT INTO client_interactions (cle_idempotence, client_id, client_libelle, type, resultat, commentaire, prochaine_action, occurred_at, created_by, created_by_email)
  VALUES (p_cle, p_client_id, coalesce(nullif(c.societe, ''), c.nom), p_type, p_resultat, v_com, v_action, v_quand, p_acteur_id, p_acteur_email)
  RETURNING id INTO v_id;

  IF p_relance_id IS NOT NULL THEN
    UPDATE weekly_tasks SET done = true, done_at = now(), interaction_id = v_id WHERE id = p_relance_id;
    v_ferme := p_relance_id;
  END IF;

  IF p_relance_echeance IS NOT NULL THEN
    v_type_rel := CASE WHEN p_relance_heure IS NOT NULL THEN 'rendez_vous' ELSE 'relance' END;
    v_titre := coalesce(nullif(btrim(coalesce(p_relance_titre, '')), ''), crm_titre_action(v_action));
    INSERT INTO weekly_tasks (content, type, client_id, client_libelle, assigne_a, assigne_email, echeance, echeance_initiale, heure, cle_idempotence, cree_par, cree_par_email)
    VALUES (left(v_titre, 200), v_type_rel, p_client_id, coalesce(nullif(c.societe, ''), c.nom), v_a_id, v_a_mel, p_relance_echeance, p_relance_echeance, p_relance_heure, p_cle, p_acteur_id, p_acteur_email)
    RETURNING id INTO v_relance;
  END IF;
  PERFORM set_config('inca.crm_ecriture', '', true);
  RETURN jsonb_build_object('interaction_id', v_id, 'relance_id', v_relance, 'relance_fermee_id', v_ferme, 'deja', false);
END $$;

-- ── 10. Relances : programmer, reporter, clôturer, réassigner ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION relance_programmer(
  p_cle uuid, p_client_id uuid, p_titre text, p_echeance date, p_heure time, p_assigne_id uuid, p_assigne_email text,
  p_acteur_id uuid, p_acteur_email text, p_acteur_role text
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  c client_accounts%ROWTYPE; v_id uuid; v_titre text := nullif(btrim(coalesce(p_titre, '')), '');
  v_a_id uuid := coalesce(p_assigne_id, p_acteur_id); v_a_mel text;
BEGIN
  PERFORM crm_verifier_acteur(p_acteur_id, p_acteur_email, p_acteur_role);
  IF p_cle IS NULL THEN RAISE EXCEPTION 'CLE_REQUISE'; END IF;
  SELECT id INTO v_id FROM weekly_tasks WHERE cle_idempotence = p_cle;
  IF FOUND THEN RETURN jsonb_build_object('relance_id', v_id, 'deja', true); END IF;
  SELECT * INTO c FROM client_accounts WHERE id = p_client_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLIENT_INTROUVABLE'; END IF;
  IF NOT crm_peut_agir(p_client_id, p_acteur_id, p_acteur_role) THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF p_echeance IS NULL OR p_echeance < crm_aujourdhui() OR p_echeance > crm_aujourdhui() + 366 THEN RAISE EXCEPTION 'ECHEANCE_INVALIDE'; END IF;
  IF v_titre IS NULL THEN v_titre := 'Relance'; END IF;
  v_a_mel := CASE WHEN p_assigne_id IS NULL THEN p_acteur_email ELSE nullif(btrim(coalesce(p_assigne_email, '')), '') END;
  IF v_a_id <> p_acteur_id AND p_acteur_role <> 'admin' THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF v_a_mel IS NULL THEN RAISE EXCEPTION 'RESPONSABLE_INVALIDE'; END IF;
  PERFORM set_config('inca.crm_ecriture', '1', true);
  INSERT INTO weekly_tasks (content, type, client_id, client_libelle, assigne_a, assigne_email, echeance, echeance_initiale, heure, cle_idempotence, cree_par, cree_par_email)
  VALUES (left(v_titre, 200), CASE WHEN p_heure IS NOT NULL THEN 'rendez_vous' ELSE 'relance' END, p_client_id, coalesce(nullif(c.societe, ''), c.nom),
          v_a_id, v_a_mel, p_echeance, p_echeance, p_heure, p_cle, p_acteur_id, p_acteur_email)
  RETURNING id INTO v_id;
  PERFORM set_config('inca.crm_ecriture', '', true);
  RETURN jsonb_build_object('relance_id', v_id, 'deja', false);
END $$;

-- Droit sur une relance existante : administrateur, personne à qui elle est assignée, ou toute personne qui peut agir sur le client
CREATE OR REPLACE FUNCTION crm_peut_gerer_relance(t weekly_tasks, p_acteur_id uuid, p_role text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT p_role = 'admin' OR t.assigne_a = p_acteur_id OR (t.client_id IS NOT NULL AND crm_peut_agir(t.client_id, p_acteur_id, p_role)) $$;

CREATE OR REPLACE FUNCTION relance_reporter(p_task_id uuid, p_echeance date, p_motif text, p_acteur_id uuid, p_acteur_email text, p_acteur_role text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE t weekly_tasks%ROWTYPE; v_motif text := nullif(btrim(coalesce(p_motif, '')), '');
BEGIN
  PERFORM crm_verifier_acteur(p_acteur_id, p_acteur_email, p_acteur_role);
  SELECT * INTO t FROM weekly_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR t.type = 'tache' THEN RAISE EXCEPTION 'RELANCE_INTROUVABLE'; END IF;
  IF NOT crm_peut_gerer_relance(t, p_acteur_id, p_acteur_role) THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF t.statut <> 'a_faire' THEN RAISE EXCEPTION 'RELANCE_DEJA_TRAITEE'; END IF;
  IF p_echeance IS NULL OR p_echeance < crm_aujourdhui() OR p_echeance > crm_aujourdhui() + 366 THEN RAISE EXCEPTION 'ECHEANCE_INVALIDE'; END IF;
  IF p_echeance = t.echeance THEN RAISE EXCEPTION 'AUCUN_CHANGEMENT'; END IF;
  PERFORM set_config('inca.crm_ecriture', '1', true);
  UPDATE weekly_tasks SET echeance = p_echeance, reports = reports + 1 WHERE id = p_task_id;
  PERFORM set_config('inca.crm_ecriture', '', true);
  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'relance.report', 'relance', p_task_id::text, t.client_libelle,
          jsonb_build_object('ancienne_echeance', t.echeance, 'nouvelle_echeance', p_echeance, 'reports', t.reports + 1, 'motif', v_motif, 'role_acteur', p_acteur_role, 'assigne', t.assigne_email));
  RETURN jsonb_build_object('relance_id', p_task_id, 'echeance', p_echeance, 'reports', t.reports + 1);
END $$;

CREATE OR REPLACE FUNCTION relance_cloturer(p_task_id uuid, p_statut text, p_motif text, p_acteur_id uuid, p_acteur_email text, p_acteur_role text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE t weekly_tasks%ROWTYPE; v_motif text := nullif(btrim(coalesce(p_motif, '')), '');
BEGIN
  PERFORM crm_verifier_acteur(p_acteur_id, p_acteur_email, p_acteur_role);
  IF p_statut IS NULL OR p_statut NOT IN ('faite', 'annulee') THEN RAISE EXCEPTION 'STATUT_INVALIDE'; END IF;
  SELECT * INTO t FROM weekly_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR t.type = 'tache' THEN RAISE EXCEPTION 'RELANCE_INTROUVABLE'; END IF;
  IF NOT crm_peut_gerer_relance(t, p_acteur_id, p_acteur_role) THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF t.statut <> 'a_faire' THEN RAISE EXCEPTION 'RELANCE_DEJA_TRAITEE'; END IF;
  IF p_statut = 'annulee' AND (v_motif IS NULL OR length(v_motif) < 3) THEN RAISE EXCEPTION 'MOTIF_REQUIS'; END IF;
  PERFORM set_config('inca.crm_ecriture', '1', true);
  IF p_statut = 'faite' THEN UPDATE weekly_tasks SET done = true, done_at = now() WHERE id = p_task_id;
  ELSE UPDATE weekly_tasks SET annulee_le = now(), annulee_par = p_acteur_email, annulation_motif = v_motif WHERE id = p_task_id; END IF;
  PERFORM set_config('inca.crm_ecriture', '', true);
  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'relance.cloture', 'relance', p_task_id::text, t.client_libelle,
          jsonb_build_object('statut', p_statut, 'motif', v_motif, 'role_acteur', p_acteur_role, 'assigne', t.assigne_email, 'echeance', t.echeance));
  RETURN jsonb_build_object('relance_id', p_task_id, 'statut', p_statut);
END $$;

CREATE OR REPLACE FUNCTION relance_reassigner(p_task_id uuid, p_assigne_id uuid, p_assigne_email text, p_motif text, p_acteur_id uuid, p_acteur_email text, p_acteur_role text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE t weekly_tasks%ROWTYPE; v_motif text := nullif(btrim(coalesce(p_motif, '')), ''); v_mel text := nullif(btrim(coalesce(p_assigne_email, '')), '');
BEGIN
  PERFORM crm_verifier_acteur(p_acteur_id, p_acteur_email, p_acteur_role);
  IF p_acteur_role <> 'admin' THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF p_assigne_id IS NULL OR v_mel IS NULL THEN RAISE EXCEPTION 'RESPONSABLE_INVALIDE'; END IF;
  IF v_motif IS NULL OR length(v_motif) < 3 THEN RAISE EXCEPTION 'MOTIF_REQUIS'; END IF;
  SELECT * INTO t FROM weekly_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR t.type = 'tache' THEN RAISE EXCEPTION 'RELANCE_INTROUVABLE'; END IF;
  IF t.statut <> 'a_faire' THEN RAISE EXCEPTION 'RELANCE_DEJA_TRAITEE'; END IF;
  IF t.assigne_a = p_assigne_id THEN RAISE EXCEPTION 'AUCUN_CHANGEMENT'; END IF;
  PERFORM set_config('inca.crm_ecriture', '1', true);
  UPDATE weekly_tasks SET assigne_a = p_assigne_id, assigne_email = v_mel WHERE id = p_task_id;
  PERFORM set_config('inca.crm_ecriture', '', true);
  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'relance.reassignation', 'relance', p_task_id::text, t.client_libelle,
          jsonb_build_object('ancien', t.assigne_email, 'nouveau', v_mel, 'motif', v_motif));
  RETURN jsonb_build_object('relance_id', p_task_id, 'assigne', v_mel);
END $$;

-- ── 11. Corriger / annuler une activité (jamais la supprimer) ────────────────────────────────────────────────────────
-- Auteur : sous 24 h après la saisie. Administrateur : à tout moment, avec un motif (sauf sur sa propre saisie dans les 24 h).
CREATE OR REPLACE FUNCTION interaction_corriger(
  p_id uuid, p_resultat text, p_commentaire text, p_prochaine_action text, p_motif text, p_acteur_id uuid, p_acteur_email text, p_acteur_role text
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  i client_interactions%ROWTYPE; v_motif text := nullif(btrim(coalesce(p_motif, '')), ''); v_com text := nullif(btrim(coalesce(p_commentaire, '')), '');
  v_auteur boolean; v_delai boolean;
BEGIN
  PERFORM crm_verifier_acteur(p_acteur_id, p_acteur_email, p_acteur_role);
  SELECT * INTO i FROM client_interactions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INTERACTION_INTROUVABLE'; END IF;
  IF i.annulee_le IS NOT NULL THEN RAISE EXCEPTION 'INTERACTION_ANNULEE'; END IF;
  v_auteur := i.created_by = p_acteur_id; v_delai := now() - i.created_at <= interval '24 hours';
  IF p_acteur_role = 'admin' THEN
    IF NOT (v_auteur AND v_delai) AND (v_motif IS NULL OR length(v_motif) < 3) THEN RAISE EXCEPTION 'MOTIF_REQUIS'; END IF;
  ELSE
    IF NOT v_auteur THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
    IF NOT v_delai THEN RAISE EXCEPTION 'DELAI_DEPASSE'; END IF;
  END IF;
  IF p_resultat IS NOT NULL AND p_resultat NOT IN ('pas_de_reponse', 'message_laisse', 'echange', 'rdv_pris', 'commande_envisagee', 'refus', 'autre') THEN RAISE EXCEPTION 'RESULTAT_INVALIDE'; END IF;
  IF i.type IN ('appel', 'visite') AND p_resultat IS NULL THEN RAISE EXCEPTION 'RESULTAT_REQUIS'; END IF;
  IF (p_resultat = 'autre' OR i.type = 'note') AND (v_com IS NULL OR length(v_com) < 3) THEN RAISE EXCEPTION 'COMMENTAIRE_REQUIS'; END IF;
  IF v_com IS NOT NULL AND length(v_com) > 2000 THEN RAISE EXCEPTION 'COMMENTAIRE_TROP_LONG'; END IF;
  IF p_prochaine_action IS NOT NULL AND p_prochaine_action NOT IN ('rappeler', 'visiter', 'envoyer_offre', 'preparer_commande', 'aucune') THEN RAISE EXCEPTION 'ACTION_INVALIDE'; END IF;
  IF (p_resultat, v_com, p_prochaine_action) IS NOT DISTINCT FROM (i.resultat, i.commentaire, i.prochaine_action) THEN RAISE EXCEPTION 'AUCUN_CHANGEMENT'; END IF;
  PERFORM set_config('inca.crm_ecriture', '1', true);
  UPDATE client_interactions SET resultat = p_resultat, commentaire = v_com, prochaine_action = p_prochaine_action, modifiee_le = now(), nb_modifications = nb_modifications + 1 WHERE id = p_id;
  PERFORM set_config('inca.crm_ecriture', '', true);
  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'interaction.correction', 'interaction', p_id::text, i.client_libelle,
          jsonb_build_object('ancien', jsonb_build_object('resultat', i.resultat, 'commentaire', i.commentaire, 'prochaine_action', i.prochaine_action),
                             'nouveau', jsonb_build_object('resultat', p_resultat, 'commentaire', v_com, 'prochaine_action', p_prochaine_action),
                             'motif', v_motif, 'par_auteur', v_auteur, 'hors_delai', NOT v_delai, 'role_acteur', p_acteur_role, 'auteur', i.created_by_email));
  RETURN jsonb_build_object('interaction_id', p_id, 'nb_modifications', i.nb_modifications + 1);
END $$;

CREATE OR REPLACE FUNCTION interaction_annuler(p_id uuid, p_motif text, p_acteur_id uuid, p_acteur_email text, p_acteur_role text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE i client_interactions%ROWTYPE; v_motif text := nullif(btrim(coalesce(p_motif, '')), ''); v_auteur boolean; v_delai boolean;
BEGIN
  PERFORM crm_verifier_acteur(p_acteur_id, p_acteur_email, p_acteur_role);
  IF v_motif IS NULL OR length(v_motif) < 3 THEN RAISE EXCEPTION 'MOTIF_REQUIS'; END IF;
  SELECT * INTO i FROM client_interactions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INTERACTION_INTROUVABLE'; END IF;
  IF i.annulee_le IS NOT NULL THEN RAISE EXCEPTION 'INTERACTION_ANNULEE'; END IF;
  v_auteur := i.created_by = p_acteur_id; v_delai := now() - i.created_at <= interval '24 hours';
  IF p_acteur_role <> 'admin' THEN
    IF NOT v_auteur THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
    IF NOT v_delai THEN RAISE EXCEPTION 'DELAI_DEPASSE'; END IF;
  END IF;
  PERFORM set_config('inca.crm_ecriture', '1', true);
  UPDATE client_interactions SET annulee_le = now(), annulee_par = p_acteur_email, annulation_motif = v_motif WHERE id = p_id;
  PERFORM set_config('inca.crm_ecriture', '', true);
  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'interaction.annulation', 'interaction', p_id::text, i.client_libelle,
          jsonb_build_object('motif', v_motif, 'type', i.type, 'resultat', i.resultat, 'commentaire', i.commentaire, 'par_auteur', v_auteur, 'hors_delai', NOT v_delai, 'role_acteur', p_acteur_role, 'auteur', i.created_by_email));
  RETURN jsonb_build_object('interaction_id', p_id, 'annulee', true);
END $$;

-- ── 12. Interlocuteurs ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION contact_enregistrer(
  p_id uuid, p_client_id uuid, p_nom text, p_fonction text, p_telephone text, p_email text, p_principal boolean, p_notes text,
  p_acteur_id uuid, p_acteur_email text, p_acteur_role text
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_client uuid := p_client_id; v_id uuid := p_id; v_nom text := nullif(btrim(coalesce(p_nom, '')), '');
BEGIN
  PERFORM crm_verifier_acteur(p_acteur_id, p_acteur_email, p_acteur_role);
  IF p_id IS NOT NULL THEN
    SELECT client_id INTO v_client FROM client_contacts WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CONTACT_INTROUVABLE'; END IF;
  END IF;
  IF v_client IS NULL OR NOT EXISTS (SELECT 1 FROM client_accounts WHERE id = v_client) THEN RAISE EXCEPTION 'CLIENT_INTROUVABLE'; END IF;
  IF NOT crm_peut_agir(v_client, p_acteur_id, p_acteur_role) THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF v_nom IS NULL OR length(v_nom) < 2 OR length(v_nom) > 120 THEN RAISE EXCEPTION 'NOM_INVALIDE'; END IF;
  IF coalesce(p_principal, false) THEN UPDATE client_contacts SET principal = false WHERE client_id = v_client AND principal AND id IS DISTINCT FROM p_id; END IF;
  IF p_id IS NULL THEN
    INSERT INTO client_contacts (client_id, nom, fonction, telephone, email, principal, notes, created_by_email)
    VALUES (v_client, v_nom, nullif(btrim(coalesce(p_fonction, '')), ''), nullif(btrim(coalesce(p_telephone, '')), ''), nullif(lower(btrim(coalesce(p_email, ''))), ''), coalesce(p_principal, false), nullif(btrim(coalesce(p_notes, '')), ''), p_acteur_email)
    RETURNING id INTO v_id;
  ELSE
    UPDATE client_contacts SET nom = v_nom, fonction = nullif(btrim(coalesce(p_fonction, '')), ''), telephone = nullif(btrim(coalesce(p_telephone, '')), ''),
      email = nullif(lower(btrim(coalesce(p_email, ''))), ''), principal = coalesce(p_principal, false), notes = nullif(btrim(coalesce(p_notes, '')), ''), modifie_le = now() WHERE id = p_id;
  END IF;
  RETURN jsonb_build_object('contact_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION contact_supprimer(p_id uuid, p_acteur_id uuid, p_acteur_email text, p_acteur_role text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE k client_contacts%ROWTYPE; v_libelle text;
BEGIN
  PERFORM crm_verifier_acteur(p_acteur_id, p_acteur_email, p_acteur_role);
  SELECT * INTO k FROM client_contacts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTACT_INTROUVABLE'; END IF;
  IF NOT crm_peut_agir(k.client_id, p_acteur_id, p_acteur_role) THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  SELECT coalesce(nullif(societe, ''), nom) INTO v_libelle FROM client_accounts WHERE id = k.client_id;
  DELETE FROM client_contacts WHERE id = p_id;
  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'contact.suppression', 'client', k.client_id::text, v_libelle, jsonb_build_object('nom', k.nom, 'fonction', k.fonction, 'telephone', k.telephone, 'email', k.email));
  RETURN jsonb_build_object('contact_id', p_id, 'supprime', true);
END $$;

-- ── 13. Délégations (administrateur seulement, journalisées) ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION delegation_accorder(
  p_commercial_id uuid, p_commercial_email text, p_proprietaire_id uuid, p_proprietaire_email text, p_expire_le date, p_motif text,
  p_acteur_id uuid, p_acteur_email text, p_acteur_role text
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_motif text := nullif(btrim(coalesce(p_motif, '')), ''); v_id uuid;
BEGIN
  PERFORM crm_verifier_acteur(p_acteur_id, p_acteur_email, p_acteur_role);
  IF p_acteur_role <> 'admin' THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF p_commercial_id IS NULL OR p_proprietaire_id IS NULL OR nullif(btrim(coalesce(p_commercial_email, '')), '') IS NULL OR nullif(btrim(coalesce(p_proprietaire_email, '')), '') IS NULL THEN RAISE EXCEPTION 'RESPONSABLE_INVALIDE'; END IF;
  IF p_commercial_id = p_proprietaire_id THEN RAISE EXCEPTION 'AUCUN_CHANGEMENT'; END IF;
  IF v_motif IS NULL OR length(v_motif) < 3 THEN RAISE EXCEPTION 'MOTIF_REQUIS'; END IF;
  IF p_expire_le IS NOT NULL AND p_expire_le < crm_aujourdhui() THEN RAISE EXCEPTION 'ECHEANCE_INVALIDE'; END IF;
  IF EXISTS (SELECT 1 FROM crm_delegations WHERE commercial_id = p_commercial_id AND proprietaire_id = p_proprietaire_id AND revoque_le IS NULL) THEN RAISE EXCEPTION 'DELEGATION_EXISTANTE'; END IF;
  INSERT INTO crm_delegations (commercial_id, commercial_email, proprietaire_id, proprietaire_email, accorde_par, expire_le, motif)
  VALUES (p_commercial_id, p_commercial_email, p_proprietaire_id, p_proprietaire_email, p_acteur_email, p_expire_le, v_motif) RETURNING id INTO v_id;
  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'crm.delegation_accordee', 'delegation', v_id::text, p_commercial_email,
          jsonb_build_object('commercial', p_commercial_email, 'portefeuille_de', p_proprietaire_email, 'expire_le', p_expire_le, 'motif', v_motif));
  RETURN jsonb_build_object('delegation_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION delegation_revoquer(p_id uuid, p_motif text, p_acteur_id uuid, p_acteur_email text, p_acteur_role text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE d crm_delegations%ROWTYPE; v_motif text := nullif(btrim(coalesce(p_motif, '')), '');
BEGIN
  PERFORM crm_verifier_acteur(p_acteur_id, p_acteur_email, p_acteur_role);
  IF p_acteur_role <> 'admin' THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF v_motif IS NULL OR length(v_motif) < 3 THEN RAISE EXCEPTION 'MOTIF_REQUIS'; END IF;
  SELECT * INTO d FROM crm_delegations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELEGATION_INTROUVABLE'; END IF;
  IF d.revoque_le IS NOT NULL THEN RAISE EXCEPTION 'DELEGATION_DEJA_REVOQUEE'; END IF;
  PERFORM set_config('inca.crm_ecriture', '1', true);
  UPDATE crm_delegations SET revoque_le = now(), revoque_par = p_acteur_email, revocation_motif = v_motif WHERE id = p_id;
  PERFORM set_config('inca.crm_ecriture', '', true);
  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'crm.delegation_revoquee', 'delegation', p_id::text, d.commercial_email,
          jsonb_build_object('commercial', d.commercial_email, 'portefeuille_de', d.proprietaire_email, 'motif', v_motif));
  RETURN jsonb_build_object('delegation_id', p_id, 'revoquee', true);
END $$;

-- ── 14. Suggestions : ignorer ou reporter (par utilisateur ; n'affecte jamais une relance programmée) ───────────────
CREATE OR REPLACE FUNCTION suggestion_masquer(p_client_id uuid, p_regle text, p_jusqu_au date, p_motif text, p_acteur_id uuid, p_acteur_email text, p_acteur_role text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM crm_verifier_acteur(p_acteur_id, p_acteur_email, p_acteur_role);
  IF NOT EXISTS (SELECT 1 FROM client_accounts WHERE id = p_client_id) THEN RAISE EXCEPTION 'CLIENT_INTROUVABLE'; END IF;
  IF p_regle IS NULL OR p_regle !~ '^[a-z_]{2,60}$' THEN RAISE EXCEPTION 'REGLE_INVALIDE'; END IF;
  IF p_jusqu_au IS NULL OR p_jusqu_au <= crm_aujourdhui() OR p_jusqu_au > crm_aujourdhui() + 366 THEN RAISE EXCEPTION 'ECHEANCE_INVALIDE'; END IF;
  INSERT INTO crm_suggestions_masquees (client_id, regle, jusqu_au, par_id, par_email, motif)
  VALUES (p_client_id, p_regle, p_jusqu_au, p_acteur_id, p_acteur_email, nullif(btrim(coalesce(p_motif, '')), ''))
  ON CONFLICT (client_id, regle, par_id) DO UPDATE SET jusqu_au = EXCLUDED.jusqu_au, motif = EXCLUDED.motif, par_email = EXCLUDED.par_email, created_at = now();
  RETURN jsonb_build_object('client_id', p_client_id, 'regle', p_regle, 'jusqu_au', p_jusqu_au);
END $$;

-- ── 15. Droits : exécution réservée au serveur ───────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION
  crm_aujourdhui(), client_interactions_proteger(), weekly_tasks_proteger(), crm_delegations_proteger(),
  crm_verifier_acteur(uuid, text, text), crm_peut_agir(uuid, uuid, text), crm_titre_action(text), crm_peut_gerer_relance(weekly_tasks, uuid, text),
  interaction_noter(uuid, uuid, text, text, text, text, timestamptz, uuid, date, time, text, uuid, text, uuid, text, text),
  relance_programmer(uuid, uuid, text, date, time, uuid, text, uuid, text, text),
  relance_reporter(uuid, date, text, uuid, text, text), relance_cloturer(uuid, text, text, uuid, text, text), relance_reassigner(uuid, uuid, text, text, uuid, text, text),
  interaction_corriger(uuid, text, text, text, text, uuid, text, text), interaction_annuler(uuid, text, uuid, text, text),
  contact_enregistrer(uuid, uuid, text, text, text, text, boolean, text, uuid, text, text), contact_supprimer(uuid, uuid, text, text),
  delegation_accorder(uuid, text, uuid, text, date, text, uuid, text, text), delegation_revoquer(uuid, text, uuid, text, text),
  suggestion_masquer(uuid, text, date, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  crm_aujourdhui(), crm_peut_agir(uuid, uuid, text),
  interaction_noter(uuid, uuid, text, text, text, text, timestamptz, uuid, date, time, text, uuid, text, uuid, text, text),
  relance_programmer(uuid, uuid, text, date, time, uuid, text, uuid, text, text),
  relance_reporter(uuid, date, text, uuid, text, text), relance_cloturer(uuid, text, text, uuid, text, text), relance_reassigner(uuid, uuid, text, text, uuid, text, text),
  interaction_corriger(uuid, text, text, text, text, uuid, text, text), interaction_annuler(uuid, text, uuid, text, text),
  contact_enregistrer(uuid, uuid, text, text, text, text, boolean, text, uuid, text, text), contact_supprimer(uuid, uuid, text, text),
  delegation_accorder(uuid, text, uuid, text, date, text, uuid, text, text), delegation_revoquer(uuid, text, uuid, text, text),
  suggestion_masquer(uuid, text, date, text, uuid, text, text)
  TO service_role;

COMMENT ON TABLE client_interactions IS 'Appels, visites, messages et notes. Jamais supprimés : corrections (24 h puis administrateur) et annulations motivées, journalisées.';
COMMENT ON COLUMN client_interactions.resultat IS 'commande_envisagee = intention exprimée par le client ; ce n''est JAMAIS une commande passée (aucune écriture dans orders).';
COMMENT ON COLUMN weekly_tasks.type IS 'tache = tâche générale (comportement d''origine) ; relance / rendez_vous = suivi commercial lié à un client, avec responsable et échéance.';
COMMENT ON COLUMN weekly_tasks.statut IS 'Calculé : annulee > faite (done) > a_faire. Une relance programmée ne change de statut que par une action volontaire.';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Retour arrière (tant qu'aucune activité n'a été saisie ; sinon des données seraient perdues) :
--   1. DROP TRIGGER trg_weekly_tasks_proteger / _truncate ON weekly_tasks; DROP TRIGGER trg_client_interactions_proteger / _truncate ON client_interactions;
--      DROP TRIGGER trg_crm_delegations_proteger / _truncate ON crm_delegations;
--   2. DROP FUNCTION des fonctions ci-dessus ; DROP TABLE crm_suggestions_masquees, crm_delegations, client_contacts, client_interactions CASCADE (après avoir retiré weekly_tasks_interaction_fkey) ;
--   3. ALTER TABLE weekly_tasks DROP COLUMN statut, DROP COLUMN type, client_id, client_libelle, assigne_a, assigne_email, echeance, heure, echeance_initiale,
--        reports, interaction_id, cle_idempotence, cree_par, cree_par_email, annulee_le, annulee_par, annulation_motif  (les 6 tâches d'origine restent intactes).
