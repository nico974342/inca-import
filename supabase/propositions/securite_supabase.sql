-- PROPOSITION (non appliquée, non testée en production) — correctifs de sécurité Supabase signalés par l'analyseur.
-- Volontairement hors de supabase/migrations : ne doit jamais partir par erreur. À appliquer seulement sur accord, APRÈS les trois migrations TVA.
-- Vérifié dans le code : TOUT le site passe par supabaseAdmin (clé service_role, qui contourne RLS) ; supabasePublic n'est utilisé nulle part.
-- Donc retirer les droits de anon / authenticated sur ces objets ne change rien au fonctionnement du site.
-- Testé sur une base locale reproduisant les rôles Supabase : tests/securite-supabase.spec.ts.

BEGIN;

-- A1. commande_fournisseur_drafts : aucune protection aujourd'hui (RLS absent, tous les droits à anon).
--     Toute personne connaissant la clé publique pourrait lire, modifier ou vider les brouillons de commande fournisseur.
ALTER TABLE commande_fournisseur_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commande_fournisseur_drafts FROM anon, authenticated;

-- A2. next_bl_number() : SECURITY DEFINER appelable par anon et authenticated via /rest/v1/rpc/next_bl_number.
--     Chaque appel consomme un numéro de BL : un appel malveillant ou répété crée des trous dans la numérotation.
REVOKE EXECUTE ON FUNCTION next_bl_number() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION next_bl_number() TO service_role;

-- A3. order_update_checked : appelable par anon / authenticated alors que seul le serveur (service_role) l'utilise.
--     (SECURITY INVOKER et RLS la rendent peu exploitable, mais aucune raison de la laisser ouverte.)
REVOKE EXECUTE ON FUNCTION order_update_checked(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION order_update_checked(uuid, jsonb) TO service_role;

-- A4. search_path figé sur les 12 fonctions signalées (aucune ne référence un autre schéma que public : vérifié).
ALTER FUNCTION next_bl_number()                                   SET search_path = public, pg_temp;
ALTER FUNCTION recalc_pump(uuid[])                                SET search_path = public, pg_temp;
ALTER FUNCTION reception_delete(uuid)                             SET search_path = public, pg_temp;
ALTER FUNCTION order_mark_livree(uuid)                            SET search_path = public, pg_temp;
ALTER FUNCTION order_cancel_livree(uuid)                          SET search_path = public, pg_temp;
ALTER FUNCTION stock_reserving_statuses()                         SET search_path = public, pg_temp;
ALTER FUNCTION product_adjust_stock(uuid, integer)                SET search_path = public, pg_temp;
ALTER FUNCTION price_group_set_default(uuid)                      SET search_path = public, pg_temp;
ALTER FUNCTION order_create_checked(jsonb, jsonb)                 SET search_path = public, pg_temp;
ALTER FUNCTION order_update_checked(uuid, jsonb)                  SET search_path = public, pg_temp;
ALTER FUNCTION reception_create(text, date, text, boolean, jsonb, uuid)        SET search_path = public, pg_temp;
ALTER FUNCTION reception_update(uuid, text, date, text, boolean, jsonb, uuid)  SET search_path = public, pg_temp;

COMMIT;

-- B. À DÉCIDER SÉPARÉMENT (non inclus ci-dessus) : les politiques « Users insert own orders » et « Users insert own order items »
--    laissent un client connecté insérer directement une commande et ses lignes (prix libre) via l'API publique, sans passer par
--    order_create_checked (contrôle du stock et des prix). Le site n'en a pas besoin (tout passe par le serveur). Pour les retirer :
--      DROP POLICY "Users insert own orders" ON orders;
--      DROP POLICY "Users insert own order items" ON order_items;
--
-- C. Réglage du tableau de bord (pas du SQL) : Authentication → Providers/Policies → activer « Leaked password protection ».
--
-- Retour arrière de A :
--   ALTER TABLE commande_fournisseur_drafts DISABLE ROW LEVEL SECURITY;
--   GRANT ALL ON commande_fournisseur_drafts TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION next_bl_number() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION order_update_checked(uuid, jsonb) TO anon, authenticated;
--   ALTER FUNCTION <chaque fonction> RESET search_path;
