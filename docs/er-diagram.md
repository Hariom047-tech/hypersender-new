# Entity Relationship Diagram

Composite FKs (`(x_id, organization_id[, business_id])`) are shown as ordinary relationships.
Every box except those marked **PLATFORM** carries `organization_id` and is RLS-protected.

## Tenancy, WhatsApp, messaging

```mermaid
erDiagram
    users ||--o{ organization_members : "has"
    organizations ||--o{ organization_members : "has"
    organizations ||--o{ businesses : owns
    businesses ||--o{ business_locations : has
    businesses ||--o{ whatsapp_instances : owns
    whatsapp_workers |o--o{ whatsapp_instances : "leases (worker_id)"
    whatsapp_instances ||--o| whatsapp_auth_credentials : "auth (1:1, CASCADE)"
    whatsapp_auth_credentials ||--o{ whatsapp_signal_keys : "keys (CASCADE)"
    whatsapp_instances ||--o{ whatsapp_instance_events : history
    businesses ||--o{ contacts : knows
    whatsapp_instances ||--o{ conversations : carries
    contacts ||--o{ conversations : "talks in"
    organization_members |o--o{ conversations : "assigned to"
    conversations ||--o{ messages : contains
    contacts |o--o{ messages : "sent/received"
    messages |o--o{ messages : "reply_to"
    messages ||--o{ message_status_events : timeline
    messages ||--o{ message_attachments : media

    whatsapp_workers { uuid id PK "PLATFORM" }
    users { uuid id PK "PLATFORM identity" }
    organizations { uuid id PK "TENANT ROOT" }
```

## AI, knowledge, booking

```mermaid
erDiagram
    ai_assistant_templates |o--o{ ai_agents : "copied into (SET NULL)"
    businesses ||--o{ ai_agents : owns
    ai_agents ||--o{ ai_agent_versions : "immutable snapshots"
    ai_agents |o--o| ai_agent_versions : "published_version"
    ai_agents ||--o{ ai_agent_channels : "served on"
    whatsapp_instances ||--o{ ai_agent_channels : "answered by (1 primary)"
    ai_tools ||--o{ ai_agent_tools : "enabled as"
    ai_agents ||--o{ ai_agent_tools : uses
    ai_agents ||--o{ ai_runs : executes
    conversations ||--o{ ai_runs : in
    messages ||--o| ai_runs : "trigger (UNIQUE)"
    ai_runs ||--o{ ai_tool_calls : calls
    ai_tools ||--o{ ai_tool_calls : of

    businesses ||--o{ knowledge_sources : has
    ai_agents |o--o{ knowledge_sources : "private to"
    knowledge_sources ||--o{ knowledge_chunks : "chunked into (vector)"

    businesses ||--o{ services : offers
    businesses ||--o{ business_resources : has
    business_resources ||--o{ resource_services : provides
    services ||--o{ resource_services : "provided by"
    business_resources |o--o{ availability_rules : "weekly hours"
    business_resources |o--o{ availability_exceptions : "leave/holiday"
    contacts ||--o{ bookings : books
    services |o--o{ bookings : for
    business_resources |o--o{ bookings : "with (EXCLUDE overlap)"
    conversations |o--o{ bookings : "via"
    bookings ||--o{ booking_events : history

    ai_assistant_templates { uuid id PK "PLATFORM" }
    ai_tools { uuid id PK "PLATFORM" }
```

## Integration, billing, operations

```mermaid
erDiagram
    organizations ||--o{ api_keys : issues
    organizations ||--o{ webhook_endpoints : configures
    businesses |o--o{ webhook_endpoints : "scope"
    whatsapp_instances |o--o{ webhook_endpoints : "scope"
    webhook_endpoints ||--o{ webhook_event_subscriptions : subscribes
    webhook_event_types ||--o{ webhook_event_subscriptions : "type of"
    webhook_event_types ||--o{ webhook_events : "type of"
    webhook_events ||--o{ webhook_deliveries : "fan-out"
    webhook_endpoints ||--o{ webhook_deliveries : "to"

    subscription_plans ||--o{ plan_entitlements : grants
    subscription_plans ||--o{ subscriptions : "priced by"
    organizations ||--o{ subscriptions : pays
    subscriptions |o--o{ invoices : bills
    invoices |o--o{ payments : "settled by"
    usage_event_types ||--o{ usage_events : "type of"
    organizations ||--o{ usage_events : meters

    organizations |o--o{ audit_logs : audits
    organization_members ||--o{ notifications : receives
    organizations |o--o{ outbox_events : emits
    organizations ||--o{ data_retention_policies : configures

    webhook_event_types { text code PK "PLATFORM" }
    subscription_plans { uuid id PK "PLATFORM" }
    plan_entitlements { uuid id PK "PLATFORM" }
    usage_event_types { text code PK "PLATFORM" }
```
