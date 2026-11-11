-- PHASE 0 — correctifs de sécurité Supabase. NON APPLIQUÉE en production : à exécuter seulement sur accord explicite.
-- Aucune suppression de donnée : uniquement des retraits de droits, l'activation de RLS, des search_path figés et la
-- suppression de deux politiques d'insertion devenues inutiles. Rejouable sans erreur (idempotente).
--
-- Fondement (vérifié dans le code) : TOUT le site accède aux données avec supabaseAdmin (clé service_role, qui contourne RLS).
-- supabasePublic n'est utilisé nulle part ; createAuthClient ne sert qu'à l'authentification (auth.getUser / connexion),
-- jamais à lire ou écrire une table. Retirer les droits d'anon et d'authenticated ne change donc rien au fonctionnement.
-- Tests : tests/securite-supabase.spec.ts (base locale PGlite, aucune connexion à la production).
--
-- Ce qui n'est PLUS dans cette migration par rapport à la proposition initiale :
--   * next_bl_number() : déjà fermé en production (c9cee7c) — la migration bl_sequence.sql s'en charge.
--   * la dépendance aux migrations TVA : ce correctif est indépendant de la TVA (module en pause).

BEGIN;

-- A1. commande_fournisseur_drafts : aucune protection aujourd'hui (RLS absent, tous les droits à anon).
--     Toute personne disposant de la clé publique pouvait lire, modifier ou vider les brouillons de commande fournisseur.
ALTER TABLE commande_fournisseur_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commande_fournisseur_drafts FROM anon, authenticated;

-- A2. Plus aucun droit de table pour anon / authenticated dans tout le schéma public (défense en profondeur).
--     Constat en production : une vingtaine de tables donnent TOUS les droits à anon et authenticated, seule la RLS les
--     bloquait. Surtout, la politique « Public read in-stock products » rendait lisibles par anon les colonnes
--     prix_achat_moyen_ht (PUMP), seuil_reappro, stock_quantity et delai_livraison_jours ; et la politique
--     « Users insert own orders / order items » permettait à un client connecté d'insérer une commande à prix libre
--     sans passer par order_create_checked. Une seule erreur de RLS sur une future table suffirait à tout exposer.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
GRANT  ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT  ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- A3. Fonctions : exécution réservée au serveur. Couvre order_update_checked (encore ouverte à anon/authenticated/PUBLIC)
--     et la fonction de déclencheur products_nouveau_premiere_entree. Les déclencheurs continuent de s'exécuter : le droit
--     EXECUTE n'est vérifié qu'à la création d'un déclencheur, pas à son déclenchement.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- A4. search_path figé sur les 11 fonctions signalées par l'analyseur (aucune ne référence un autre schéma que public :
--     vérifié en production par lecture du code de chacune).
ALTER FUNCTION recalc_pump(uuid[])                                             SET search_path = public, pg_temp;
ALTER FUNCTION reception_delete(uuid)                                          SET search_path = public, pg_temp;
ALTER FUNCTION order_mark_livree(uuid)                                         SET search_path = public, pg_temp;
ALTER FUNCTION order_cancel_livree(uuid)                                       SET search_path = public, pg_temp;
ALTER FUNCTION stock_reserving_statuses()                                      SET search_path = public, pg_temp;
ALTER FUNCTION product_adjust_stock(uuid, integer)                             SET search_path = public, pg_temp;
ALTER FUNCTION price_group_set_default(uuid)                                   SET search_path = public, pg_temp;
ALTER FUNCTION order_create_checked(jsonb, jsonb)                              SET search_path = public, pg_temp;
ALTER FUNCTION order_update_checked(uuid, jsonb)                               SET search_path = public, pg_temp;
ALTER FUNCTION reception_create(text, date, text, boolean, jsonb, uuid)        SET search_path = public, pg_temp;
ALTER FUNCTION reception_update(uuid, text, date, text, boolean, jsonb, uuid)  SET search_path = public, pg_temp;

-- A5. Les deux politiques d'insertion directe par un client connecté (contournement du contrôle de stock et de prix).
--     Le site n'en a pas besoin : les commandes passent par order_create_checked côté serveur. Les retirer empêche
--     qu'un futur GRANT accidentel les réactive. Les politiques de lecture restent (inertes sans droit de table).
DROP POLICY IF EXISTS "Users insert own orders"      ON orders;
DROP POLICY IF EXISTS "Users insert own order items" ON order_items;

-- A6. Droits par défaut : les FUTURES tables, séquences et fonctions créées par ce rôle (donc les tables du CRM et du
--     Suivi des achats) ne donnent plus rien à anon / authenticated. service_role garde son accès.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;

-- NON FAIT ICI (décisions séparées) :
--   * Réglage du tableau de bord Supabase (pas du SQL) : Authentication → activer « Leaked password protection ».
--   * Les droits par défaut du rôle supabase_admin ne peuvent pas être modifiés depuis ce rôle ; les tables créées par
--     migration (rôle postgres) sont couvertes. Toute table créée à la main par un autre rôle doit être contrôlée.
--
-- Retour arrière (dans l'ordre inverse) :
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
--   ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
--   CREATE POLICY "Users insert own orders" ON orders FOR INSERT WITH CHECK (auth.uid() = user_id);
--   CREATE POLICY "Users insert own order items" ON order_items FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND o.user_id = auth.uid()));
--   ALTER FUNCTION <chaque fonction de A4> RESET search_path;
--   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;
--   GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
--   ALTER TABLE commande_fournisseur_drafts DISABLE ROW LEVEL SECURITY;
