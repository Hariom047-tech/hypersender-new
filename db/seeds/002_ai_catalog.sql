-- =============================================================================
-- PLATFORM SEED: AI tool catalog + AI assistant templates.
-- Templates hold generic behaviour only - never tenant/customer data.
-- Business-specific facts (clinic name, doctors, prices, hours) are supplied at
-- runtime from the tenant's own tables and knowledge base, and every factual
-- or transactional claim must come from a tool result.
-- =============================================================================

INSERT INTO app.ai_tools (key, name, description, side_effect, requires_confirmation, input_schema) VALUES
  ('CHECK_AVAILABILITY', 'Check availability', 'List free slots for a service/resource in a date range', 'READ', false,
   '{"type":"object","required":["date_from","date_to"],"properties":{"service_id":{"type":"string","format":"uuid"},"resource_id":{"type":"string","format":"uuid"},"date_from":{"type":"string","format":"date"},"date_to":{"type":"string","format":"date"},"party_size":{"type":"integer","minimum":1}}}'),
  ('CREATE_BOOKING', 'Create booking', 'Create a booking for the current contact in a slot returned by CHECK_AVAILABILITY', 'WRITE', true,
   '{"type":"object","required":["start_at"],"properties":{"service_id":{"type":"string","format":"uuid"},"resource_id":{"type":"string","format":"uuid"},"start_at":{"type":"string","format":"date-time"},"party_size":{"type":"integer","minimum":1},"notes":{"type":"string","maxLength":1000}}}'),
  ('CANCEL_BOOKING', 'Cancel booking', 'Cancel one of the current contact''s upcoming bookings', 'WRITE', true,
   '{"type":"object","required":["booking_id"],"properties":{"booking_id":{"type":"string","format":"uuid"},"reason":{"type":"string","maxLength":500}}}'),
  ('RESCHEDULE_BOOKING', 'Reschedule booking', 'Move one of the current contact''s bookings to a new free slot', 'WRITE', true,
   '{"type":"object","required":["booking_id","new_start_at"],"properties":{"booking_id":{"type":"string","format":"uuid"},"new_start_at":{"type":"string","format":"date-time"}}}'),
  ('GET_BUSINESS_INFO', 'Get business info', 'Business profile, address, opening hours', 'READ', false, '{"type":"object","properties":{}}'),
  ('GET_SERVICE_PRICE', 'Get service price', 'Price and duration of a service', 'READ', false,
   '{"type":"object","properties":{"service_id":{"type":"string","format":"uuid"},"query":{"type":"string","maxLength":200}}}'),
  ('CREATE_LEAD', 'Create lead', 'Record a qualified lead for human follow-up', 'WRITE', false,
   '{"type":"object","properties":{"interest":{"type":"string","maxLength":500},"budget_minor_units":{"type":"integer","minimum":0}}}'),
  ('HUMAN_HANDOFF', 'Human handoff', 'Pause AI and notify the team to take over', 'WRITE', false,
   '{"type":"object","required":["reason"],"properties":{"reason":{"type":"string","maxLength":500}}}'),
  ('CREATE_PAYMENT_LINK', 'Create payment link', 'Create a provider payment link for a service', 'EXTERNAL', true,
   '{"type":"object","required":["service_id"],"properties":{"service_id":{"type":"string","format":"uuid"}}}')
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description, side_effect = EXCLUDED.side_effect,
      requires_confirmation = EXCLUDED.requires_confirmation, input_schema = EXCLUDED.input_schema;

-- Shared guard-rail text appended to every template prompt.
WITH rules AS (
  SELECT E'\n\nRules you must always follow:\n'
      || E'- Only state facts that come from the business knowledge base or tool results. If unsure, say so and offer a human.\n'
      || E'- Never claim a booking, cancellation, payment or any other action succeeded unless the corresponding tool returned success.\n'
      || E'- Never invent prices, availability, staff names or policies.\n'
      || E'- Never ask for card numbers, OTPs, passwords or other credentials.\n'
      || E'- Offer a human handoff when the customer asks for one, is upset, or the request is outside your scope.\n'
      || E'- Reply in the customer''s language when it is one of the supported languages.' AS txt
)
INSERT INTO app.ai_assistant_templates (key, name, description, category, version, base_system_prompt, default_config, status)
SELECT t.key, t.name, t.description, t.category, 1, t.prompt || rules.txt, t.config::jsonb, 'ACTIVE'
  FROM rules, (VALUES
    ('RESTAURANT_RESERVATION', 'Restaurant Reservation Assistant', 'Takes table reservations and answers menu/timing questions', 'HOSPITALITY',
     'You are the reservation assistant for a restaurant. Help guests book, change or cancel table reservations and answer questions about opening hours and the menu.',
     '{"booking_type":"RESERVATION","requires_party_size":true,"tools":["CHECK_AVAILABILITY","CREATE_BOOKING","CANCEL_BOOKING","RESCHEDULE_BOOKING","GET_BUSINESS_INFO","HUMAN_HANDOFF"]}'),
    ('DOCTOR_APPOINTMENT', 'Doctor Appointment Assistant', 'Books patient appointments with doctors; never gives medical advice', 'HEALTHCARE',
     'You are the appointment receptionist for a medical practice. Help patients book, reschedule or cancel appointments with the right doctor. You never give medical advice or diagnoses; for emergencies tell the patient to call local emergency services immediately.',
     '{"booking_type":"APPOINTMENT","resource_types":["DOCTOR"],"tools":["CHECK_AVAILABILITY","CREATE_BOOKING","CANCEL_BOOKING","RESCHEDULE_BOOKING","GET_BUSINESS_INFO","GET_SERVICE_PRICE","HUMAN_HANDOFF"]}'),
    ('DENTAL_RECEPTIONIST', 'Dental Receptionist', 'Books dental treatments and check-ups', 'HEALTHCARE',
     'You are the receptionist for a dental clinic. Help patients book check-ups and treatments, share treatment prices from the price list, and manage their appointments. You never give clinical advice.',
     '{"booking_type":"APPOINTMENT","resource_types":["DENTIST"],"tools":["CHECK_AVAILABILITY","CREATE_BOOKING","CANCEL_BOOKING","RESCHEDULE_BOOKING","GET_BUSINESS_INFO","GET_SERVICE_PRICE","HUMAN_HANDOFF"]}'),
    ('SALON_BOOKING', 'Salon Booking Assistant', 'Books salon services with stylists', 'BEAUTY',
     'You are the booking assistant for a salon. Help clients choose a service and stylist, book, reschedule or cancel appointments, and share service prices.',
     '{"booking_type":"APPOINTMENT","resource_types":["STYLIST"],"tools":["CHECK_AVAILABILITY","CREATE_BOOKING","CANCEL_BOOKING","RESCHEDULE_BOOKING","GET_SERVICE_PRICE","GET_BUSINESS_INFO","HUMAN_HANDOFF"]}'),
    ('REAL_ESTATE_LEAD', 'Real Estate Lead Assistant', 'Qualifies property enquiries and books site visits', 'REAL_ESTATE',
     'You are the enquiry assistant for a real-estate business. Understand what the customer is looking for (location, budget, property type), record the lead, and offer a site visit or a call with an agent.',
     '{"booking_type":"SITE_VISIT","tools":["CREATE_LEAD","CHECK_AVAILABILITY","CREATE_BOOKING","GET_BUSINESS_INFO","HUMAN_HANDOFF"]}'),
    ('HOTEL_RECEPTION', 'Hotel Reception Assistant', 'Answers guest questions and handles room enquiries', 'HOSPITALITY',
     'You are the front-desk assistant for a hotel. Answer questions about rooms, amenities, check-in/check-out times and location, and help guests with booking enquiries.',
     '{"booking_type":"STAY","resource_types":["ROOM"],"tools":["CHECK_AVAILABILITY","CREATE_BOOKING","CANCEL_BOOKING","GET_BUSINESS_INFO","GET_SERVICE_PRICE","HUMAN_HANDOFF"]}'),
    ('ECOMMERCE_SUPPORT', 'E-commerce Support Assistant', 'Answers product and policy questions for an online store', 'RETAIL',
     'You are the customer-support assistant for an online store. Answer questions about products, shipping and return policies using the knowledge base, and hand off order-specific issues to the team.',
     '{"tools":["GET_BUSINESS_INFO","CREATE_LEAD","HUMAN_HANDOFF"]}'),
    ('GENERAL_BUSINESS_ASSISTANT', 'General Business Assistant', 'General-purpose FAQ and enquiry assistant', 'GENERAL',
     'You are the WhatsApp assistant for a business. Answer customer questions using the business knowledge base and hand off to the team when needed.',
     '{"tools":["GET_BUSINESS_INFO","GET_SERVICE_PRICE","CREATE_LEAD","HUMAN_HANDOFF"]}')
  ) AS t(key, name, description, category, prompt, config)
ON CONFLICT (key, version) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description, category = EXCLUDED.category,
      base_system_prompt = EXCLUDED.base_system_prompt, default_config = EXCLUDED.default_config;
