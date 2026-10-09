-- Rollback 0021 (dev/staging only; drops havan booking data, call-backs and reminders).
DROP TABLE IF EXISTS app.scheduled_reminders, app.havan_callback_requests, app.havan_booking_details,
  app.havan_special_dates, app.festival_calendar, app.havan_packages, app.havan_settings;
-- The capabilities stay in the catalog (seeded data) but can no longer run.
UPDATE app.ai_tools SET status = 'DEPRECATED', availability = 'NOT_READY' WHERE handler_key LIKE 'havan.%';
