-- Rollback 0022 (dev/staging only; forgets connected Google calendars).
DROP TABLE IF EXISTS app.calendar_event_links, app.calendar_connections;
