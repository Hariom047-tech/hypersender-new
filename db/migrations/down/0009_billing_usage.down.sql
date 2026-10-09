-- Rollback 0009. Destroys billing records: never run against production.
DROP FUNCTION IF EXISTS app.current_entitlement(text);
DROP TABLE IF EXISTS app.usage_events, app.payments, app.invoices, app.subscriptions, app.usage_event_types, app.plan_entitlements, app.subscription_plans;
