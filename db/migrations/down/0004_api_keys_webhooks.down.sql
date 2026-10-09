-- Rollback 0004 (restores the membership-only tenant_context_valid from 0002).
DROP FUNCTION IF EXISTS app.resolve_webhook_targets(text, uuid, uuid);
DROP FUNCTION IF EXISTS app_auth.authenticate_api_key(bytea);
DROP TABLE IF EXISTS app.webhook_deliveries, app.webhook_events, app.webhook_event_subscriptions, app.webhook_endpoints, app.webhook_event_types;
CREATE OR REPLACE FUNCTION app.tenant_context_valid() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT app.current_org_id() IS NOT NULL
     AND EXISTS (SELECT 1 FROM app.organizations o WHERE o.id = app.current_org_id() AND o.deleted_at IS NULL)
     AND app.current_user_id() IS NOT NULL
     AND EXISTS (SELECT 1 FROM app.organization_members m WHERE m.organization_id = app.current_org_id()
                   AND m.user_id = app.current_user_id() AND m.status = 'ACTIVE')
$$;
DROP TABLE IF EXISTS app.api_keys;
