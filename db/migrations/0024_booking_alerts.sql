-- =============================================================================
-- 0024 BOOKING ALERTS - ADDITIVE ONLY.
-- Pandit Ji gets an immediate WhatsApp alert on their personal number when a
-- havan is booked, moved or cancelled (besides the day-before reminder).
-- =============================================================================
ALTER TABLE app.scheduled_reminders DROP CONSTRAINT reminders_kind_chk;
ALTER TABLE app.scheduled_reminders ADD CONSTRAINT reminders_kind_chk CHECK (kind IN ('BOOKING','CALLBACK','FOLLOW_UP','CUSTOM','BOOKING_ALERT'));
