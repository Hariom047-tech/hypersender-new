-- =============================================================================
-- 0023 HAVAN CITY - ADDITIVE ONLY.
-- The yajman's city is asked with the name at booking time (Pandit Ji sees
-- where the yajman comes from, on the booking, reminder and calendar event).
-- =============================================================================
ALTER TABLE app.havan_booking_details ADD COLUMN city text;
ALTER TABLE app.havan_booking_details ADD CONSTRAINT havan_booking_details_city_chk CHECK (city IS NULL OR length(btrim(city)) BETWEEN 1 AND 100);
