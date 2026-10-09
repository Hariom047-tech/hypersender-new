-- Rollback 0002.
DROP FUNCTION IF EXISTS app_auth.find_or_create_invited_user(text);
DROP FUNCTION IF EXISTS app_auth.get_login_candidate(text);
DROP TABLE IF EXISTS app.business_locations, app.businesses;
DROP TRIGGER IF EXISTS trg_org_keeps_owner ON app.organization_members;
DROP FUNCTION IF EXISTS app.ensure_org_keeps_owner();
DROP TABLE IF EXISTS app.organization_members, app.organizations, app.users CASCADE;
DROP FUNCTION IF EXISTS app.is_org_bootstrap(uuid);
DROP FUNCTION IF EXISTS app.is_org_admin(uuid);
DROP FUNCTION IF EXISTS app.tenant_context_valid();
