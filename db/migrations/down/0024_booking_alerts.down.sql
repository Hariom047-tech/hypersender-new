-- Rollback 0024.
DELETE FROM app.scheduled_reminders WHERE kind = 'BOOKING_ALERT';
ALTER TABLE app.scheduled_reminders DROP CONSTRAINT reminders_kind_chk;
ALTER TABLE app.scheduled_reminders ADD CONSTRAINT reminders_kind_chk CHECK (kind IN ('BOOKING','CALLBACK','FOLLOW_UP','CUSTOM'));
