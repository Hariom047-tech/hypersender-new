-- =============================================================================
-- PLATFORM SEED (Phase 4): capability registry + assistant template catalog.
-- Idempotent. Platform data only - never tenant/customer data.
--  * A tool is READY only if a backend handler with its handler_key exists in
--    src/ai/tools (checked at worker/API start-up and by tests). Tools without a
--    handler are NOT_READY and can never be enabled or executed.
--  * Tool descriptions are what the model sees: they describe the business
--    capability, never tables/SQL/internal implementation.
--  * Templates are VERSIONED. Installing copies the template instructions into
--    the tenant assistant, so publishing a new template version never changes
--    an installed assistant silently.
-- =============================================================================

-- ------------------------------------------------------------------ tools ---
INSERT INTO app.ai_tools (key, name, description, category, handler_key, side_effect, is_read_only, has_side_effects, risk_level,
                          requires_confirmation, availability, capability_name, capability_description, input_schema, output_schema, config_schema, version)
SELECT t.key, t.name, t.description, t.category, t.handler_key, t.side_effect, t.side_effect = 'READ', t.side_effect <> 'READ', t.risk,
       t.confirm, t.availability, t.cap_name, t.cap_desc, t.input::jsonb, t.output::jsonb, t.config::jsonb, 1
FROM (VALUES
  ('GET_BUSINESS_INFO', 'Get business info', 'Get the business profile: name, description, contact phone/email, website and address.',
   'BUSINESS_INFO', 'business.info', 'READ', 'LOW', false, 'READY', 'Answer business questions', 'Shares your business name, contact details and address.',
   $j${"type":"object","additionalProperties":false,"properties":{}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"business":{"type":"object"}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('SEARCH_KNOWLEDGE', 'Search knowledge', 'Search the business''s own documents and FAQs for static information (policies, procedures, explanations). Not for live prices, availability or bookings.',
   'KNOWLEDGE', 'knowledge.search', 'READ', 'LOW', false, 'READY', 'Use business knowledge', 'Answers from the documents and FAQs you add.',
   $j${"type":"object","additionalProperties":false,"required":["query"],"properties":{"query":{"type":"string","minLength":2,"maxLength":300},"limit":{"type":"integer","minimum":1,"maximum":8}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"results":{"type":"array"}}}$j$,
   $j${"type":"object","properties":{"maxResults":{"type":"integer","minimum":1,"maximum":8,"default":4}}}$j$),
  ('GET_BUSINESS_HOURS', 'Get business hours', 'Get opening hours for the week or whether the business is open on a given date.',
   'BUSINESS_INFO', 'business.hours', 'READ', 'LOW', false, 'READY', 'Share opening hours', 'Tells customers when you are open.',
   $j${"type":"object","additionalProperties":false,"properties":{"date":{"type":"string","format":"date"}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"hours":{"type":"array"}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('GET_BUSINESS_LOCATION', 'Get business location', 'Get the business address(es) and map coordinates to share directions.',
   'BUSINESS_INFO', 'business.location', 'READ', 'LOW', false, 'READY', 'Share location', 'Sends your address and map location.',
   $j${"type":"object","additionalProperties":false,"properties":{}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"locations":{"type":"array"}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('GET_SERVICES', 'List services', 'List the services the business offers (optionally filtered by a search term), with ids for follow-up questions.',
   'BUSINESS_INFO', 'catalog.services', 'READ', 'LOW', false, 'READY', 'Show services', 'Lists the services you offer.',
   $j${"type":"object","additionalProperties":false,"properties":{"query":{"type":"string","maxLength":100},"limit":{"type":"integer","minimum":1,"maximum":25}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"services":{"type":"array"}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('GET_SERVICE_DETAILS', 'Get service details', 'Get full details of one service: description, duration, price and who provides it.',
   'BUSINESS_INFO', 'catalog.service_details', 'READ', 'LOW', false, 'READY', 'Explain services', 'Explains a service in detail.',
   $j${"type":"object","additionalProperties":false,"required":["service_id"],"properties":{"service_id":{"type":"string","format":"uuid"}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"service":{"type":"object"}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('GET_SERVICE_PRICE', 'Get service price', 'Get the official current price and duration of a service by id or by name.',
   'BUSINESS_INFO', 'catalog.service_price', 'READ', 'LOW', false, 'READY', 'Share prices', 'Quotes the prices from your service list.',
   $j${"type":"object","additionalProperties":false,"properties":{"service_id":{"type":"string","format":"uuid"},"query":{"type":"string","minLength":2,"maxLength":100}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"prices":{"type":"array"}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('GET_RESOURCES', 'List staff and resources', 'List the people or resources that can be booked (doctors, stylists, tables, rooms), optionally for a service.',
   'BUSINESS_INFO', 'catalog.resources', 'READ', 'LOW', false, 'READY', 'Show staff', 'Lists who or what can be booked (doctors, stylists, tables).',
   $j${"type":"object","additionalProperties":false,"properties":{"service_id":{"type":"string","format":"uuid"},"resource_type":{"type":"string","maxLength":64},"query":{"type":"string","maxLength":100}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"resources":{"type":"array"}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('CHECK_AVAILABILITY', 'Check availability', 'Find free booking slots for a date range, optionally for a service, a specific person/resource, a party size and a preferred time of day.',
   'BOOKING', 'booking.check_availability', 'READ', 'LOW', false, 'READY', 'Check availability', 'Finds free appointment or reservation slots.',
   $j${"type":"object","additionalProperties":false,"required":["date_from"],"properties":{"date_from":{"type":"string","format":"date"},"date_to":{"type":"string","format":"date"},"service_id":{"type":"string","format":"uuid"},"resource_id":{"type":"string","format":"uuid"},"party_size":{"type":"integer","minimum":1,"maximum":500},"time_of_day":{"type":"string","enum":["MORNING","AFTERNOON","EVENING","ANY"]},"preferred_time":{"type":"string","format":"time"}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"slots":{"type":"array"},"timezone":{"type":"string"}}}$j$,
   $j${"type":"object","properties":{"bookingWindowDays":{"type":"integer","minimum":1,"maximum":365,"default":30},"minNoticeMinutes":{"type":"integer","minimum":0,"maximum":10080,"default":120},"allowSameDay":{"type":"boolean","default":true},"slotIntervalMinutes":{"type":"integer","minimum":5,"maximum":240,"default":30},"maxSlots":{"type":"integer","minimum":1,"maximum":20,"default":6}}}$j$),
  ('CREATE_BOOKING', 'Create booking', 'Book an appointment/reservation for the current customer at a specific start time. Re-validates availability; returns the confirmed booking or why it failed with alternatives.',
   'BOOKING', 'booking.create', 'WRITE', 'MEDIUM', true, 'READY', 'Book appointments', 'Creates bookings in your calendar.',
   $j${"type":"object","additionalProperties":false,"required":["start_at"],"properties":{"start_at":{"type":"string","format":"date-time"},"service_id":{"type":"string","format":"uuid"},"resource_id":{"type":"string","format":"uuid"},"customer_name":{"type":"string","minLength":1,"maxLength":100},"party_size":{"type":"integer","minimum":1,"maximum":500},"notes":{"type":"string","maxLength":500}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"booking":{"type":"object"},"errorCode":{"type":"string"},"alternatives":{"type":"array"}}}$j$,
   $j${"type":"object","properties":{"requireConfirmation":{"type":"boolean","default":true},"autoConfirm":{"type":"boolean","default":true},"bookingWindowDays":{"type":"integer","minimum":1,"maximum":365,"default":30},"minNoticeMinutes":{"type":"integer","minimum":0,"maximum":10080,"default":120},"allowSameDay":{"type":"boolean","default":true},"requireCustomerName":{"type":"boolean","default":true},"defaultDurationMinutes":{"type":"integer","minimum":5,"maximum":1440,"default":30}}}$j$),
  ('GET_BOOKING', 'Get bookings', 'Get the current customer''s upcoming bookings (or one booking by id).',
   'BOOKING', 'booking.get', 'READ', 'LOW', false, 'READY', 'Look up bookings', 'Tells customers about their existing bookings.',
   $j${"type":"object","additionalProperties":false,"properties":{"booking_id":{"type":"string","format":"uuid"}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"bookings":{"type":"array"}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('RESCHEDULE_BOOKING', 'Reschedule booking', 'Move one of the current customer''s bookings to a new start time (checks the new slot and moves it in one step).',
   'BOOKING', 'booking.reschedule', 'WRITE', 'MEDIUM', true, 'READY', 'Reschedule appointments', 'Moves a customer''s booking to another free slot.',
   $j${"type":"object","additionalProperties":false,"required":["booking_id","new_start_at"],"properties":{"booking_id":{"type":"string","format":"uuid"},"new_start_at":{"type":"string","format":"date-time"}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"booking":{"type":"object"},"errorCode":{"type":"string"}}}$j$,
   $j${"type":"object","properties":{"requireConfirmation":{"type":"boolean","default":true},"minNoticeMinutes":{"type":"integer","minimum":0,"maximum":10080,"default":120}}}$j$),
  ('CANCEL_BOOKING', 'Cancel booking', 'Cancel one of the current customer''s upcoming bookings.',
   'BOOKING', 'booking.cancel', 'WRITE', 'MEDIUM', true, 'READY', 'Cancel appointments', 'Cancels a customer''s booking on request.',
   $j${"type":"object","additionalProperties":false,"required":["booking_id"],"properties":{"booking_id":{"type":"string","format":"uuid"},"reason":{"type":"string","maxLength":300}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"booking":{"type":"object"},"errorCode":{"type":"string"}}}$j$,
   $j${"type":"object","properties":{"requireConfirmation":{"type":"boolean","default":true},"minNoticeMinutes":{"type":"integer","minimum":0,"maximum":10080,"default":0}}}$j$),
  ('GET_CUSTOMER_CONTEXT', 'Get customer context', 'Get what the business knows about the current customer: name, upcoming bookings and open enquiry. Only ever about the customer in this chat.',
   'CUSTOMER', 'customer.context', 'READ', 'LOW', false, 'READY', 'Remember customers', 'Recognises returning customers and their bookings.',
   $j${"type":"object","additionalProperties":false,"properties":{}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"customer":{"type":"object"}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('CREATE_LEAD', 'Create lead', 'Record the current customer''s enquiry/requirements for the sales team (one open enquiry per customer; repeats update it).',
   'SALES', 'lead.create', 'WRITE', 'LOW', false, 'READY', 'Capture leads', 'Saves customer requirements for your sales team.',
   $j${"type":"object","additionalProperties":false,"properties":{"intent":{"type":"string","enum":["BUY","RENT","SELL","INVEST","ENQUIRY","OTHER"]},"interest":{"type":"string","maxLength":500},"property_type":{"type":"string","maxLength":100},"location":{"type":"string","maxLength":200},"bedrooms":{"type":"integer","minimum":0,"maximum":50},"budget_min":{"type":"number","minimum":0},"budget_max":{"type":"number","minimum":0},"timeline":{"type":"string","maxLength":200},"qualification":{"type":"string","enum":["WARM","HOT","COLD","UNQUALIFIED"]},"notes":{"type":"string","maxLength":1000}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"lead":{"type":"object"}}}$j$,
   $j${"type":"object","properties":{"notifyTeamOnHot":{"type":"boolean","default":true}}}$j$),
  ('UPDATE_LEAD', 'Update lead', 'Update the current customer''s open enquiry with new requirements or qualification.',
   'SALES', 'lead.update', 'WRITE', 'LOW', false, 'READY', 'Update leads', 'Keeps a customer''s enquiry up to date.',
   $j${"type":"object","additionalProperties":false,"properties":{"intent":{"type":"string","enum":["BUY","RENT","SELL","INVEST","ENQUIRY","OTHER"]},"interest":{"type":"string","maxLength":500},"property_type":{"type":"string","maxLength":100},"location":{"type":"string","maxLength":200},"bedrooms":{"type":"integer","minimum":0,"maximum":50},"budget_min":{"type":"number","minimum":0},"budget_max":{"type":"number","minimum":0},"timeline":{"type":"string","maxLength":200},"qualification":{"type":"string","enum":["WARM","HOT","COLD","UNQUALIFIED"]},"notes":{"type":"string","maxLength":1000}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"lead":{"type":"object"}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('GET_LEAD', 'Get lead', 'Get the current customer''s open enquiry, if any.',
   'SALES', 'lead.get', 'READ', 'LOW', false, 'READY', 'Recall enquiries', 'Recalls what a customer asked for before.',
   $j${"type":"object","additionalProperties":false,"properties":{}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"lead":{"type":["object","null"]}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('HUMAN_HANDOFF', 'Human handoff', 'Transfer this chat to a human team member. The assistant stops replying in this chat after this.',
   'COMMUNICATION', 'conversation.handoff', 'WRITE', 'LOW', false, 'READY', 'Transfer to human', 'Hands the chat to your team when needed.',
   $j${"type":"object","additionalProperties":false,"required":["reason"],"properties":{"reason":{"type":"string","minLength":2,"maxLength":300},"priority":{"type":"string","enum":["LOW","NORMAL","HIGH","URGENT"]},"summary":{"type":"string","maxLength":600}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"handlingMode":{"type":"string"}}}$j$,
   $j${"type":"object","properties":{"notifyTeam":{"type":"boolean","default":true}}}$j$),
  ('PAUSE_AUTOMATION', 'Pause automation', 'Stop automatic replies in this chat for a while when the customer asks to stop talking to the assistant.',
   'SYSTEM', 'conversation.pause', 'WRITE', 'LOW', false, 'READY', 'Pause on request', 'Stops auto-replies when a customer asks for it.',
   $j${"type":"object","additionalProperties":false,"required":["reason"],"properties":{"reason":{"type":"string","minLength":2,"maxLength":300},"minutes":{"type":"integer","minimum":5,"maximum":10080}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"pausedUntil":{"type":"string"}}}$j$,
   $j${"type":"object","properties":{"defaultMinutes":{"type":"integer","minimum":5,"maximum":10080,"default":1440}}}$j$),
  ('CREATE_PAYMENT_LINK', 'Create payment link', 'Create a payment link for a service.',
   'PAYMENT', NULL, 'EXTERNAL', 'HIGH', true, 'NOT_READY', 'Send payment links', 'Sends a payment link (requires a payment provider - coming soon).',
   $j${"type":"object","additionalProperties":false,"required":["service_id"],"properties":{"service_id":{"type":"string","format":"uuid"}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('NOTIFY_TEAM', 'Notify team', 'Send an internal note to the business team (for example a special request) without handing over the chat.',
   'COMMUNICATION', 'team.notify', 'WRITE', 'LOW', false, 'READY', 'Notify staff', 'Alerts your team about special requests.',
   $j${"type":"object","additionalProperties":false,"required":["message"],"properties":{"message":{"type":"string","minLength":2,"maxLength":500},"priority":{"type":"string","enum":["LOW","NORMAL","HIGH","URGENT"]}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"}}}$j$,
   $j${"type":"object","properties":{}}$j$),
  ('CONFIRM_PENDING_ACTION', 'Confirm pending action', 'Record the customer''s answer to the action that is waiting for their confirmation. Use CONFIRM only when the customer clearly agreed in their latest message; DECLINE if they said no or changed their mind.',
   'SYSTEM', 'system.confirm_pending_action', 'WRITE', 'MEDIUM', false, 'READY', NULL, NULL,
   $j${"type":"object","additionalProperties":false,"required":["decision"],"properties":{"decision":{"type":"string","enum":["CONFIRM","DECLINE"]}}}$j$,
   $j${"type":"object","properties":{"success":{"type":"boolean"},"state":{"type":"string"}}}$j$,
   $j${"type":"object","properties":{}}$j$)
) AS t(key, name, description, category, handler_key, side_effect, risk, confirm, availability, cap_name, cap_desc, input, output, config)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description, category = EXCLUDED.category, handler_key = EXCLUDED.handler_key,
  side_effect = EXCLUDED.side_effect, is_read_only = EXCLUDED.is_read_only, has_side_effects = EXCLUDED.has_side_effects,
  risk_level = EXCLUDED.risk_level, requires_confirmation = EXCLUDED.requires_confirmation, availability = EXCLUDED.availability,
  capability_name = EXCLUDED.capability_name, capability_description = EXCLUDED.capability_description,
  input_schema = EXCLUDED.input_schema, output_schema = EXCLUDED.output_schema, config_schema = EXCLUDED.config_schema;

-- Logical dependencies (validation + UI hints only; the booking tools re-check internally).
INSERT INTO app.ai_tool_dependencies (tool_id, depends_on_tool_id, relation)
SELECT a.id, b.id, d.rel FROM (VALUES
  ('CREATE_BOOKING', 'CHECK_AVAILABILITY', 'RECOMMENDS'),
  ('RESCHEDULE_BOOKING', 'GET_BOOKING', 'REQUIRES'),
  ('RESCHEDULE_BOOKING', 'CHECK_AVAILABILITY', 'RECOMMENDS'),
  ('CANCEL_BOOKING', 'GET_BOOKING', 'REQUIRES'),
  ('GET_SERVICE_DETAILS', 'GET_SERVICES', 'RECOMMENDS'),
  ('UPDATE_LEAD', 'CREATE_LEAD', 'REQUIRES')
) AS d(tool, dep, rel)
JOIN app.ai_tools a ON a.key = d.tool JOIN app.ai_tools b ON b.key = d.dep
ON CONFLICT (tool_id, depends_on_tool_id) DO UPDATE SET relation = EXCLUDED.relation;

-- -------------------------------------------------------------- templates ---
-- (key, version): existing Phase 1 keys get version 2; new keys start at 1.
CREATE TEMP TABLE _tpl (key text, version int, name text, short text, long text, category text, mkt text, industry text, icon text,
  prompt text, config jsonb, welcome jsonb, langs text[], demo jsonb, setup jsonb, recfor text[], minutes int, ord int) ON COMMIT DROP;

INSERT INTO _tpl VALUES
('DOCTOR_APPOINTMENT', 2, 'Doctor Appointment Assistant',
 'Answer clinic queries and manage patient appointments automatically.',
 'Handles patient enquiries on WhatsApp: clinic timings, services and fees from your price list, doctor availability, and booking, rescheduling or cancelling appointments. Never gives medical advice; hands urgent or clinical questions to your staff.',
 'HEALTHCARE', 'APPOINTMENTS', 'HEALTHCARE', 'stethoscope',
 $p$ROLE
You are the front-desk receptionist of a medical clinic on WhatsApp.

OBJECTIVE
- Answer clinic questions (timings, location, services, fees) using business data and knowledge.
- Identify the doctor and/or service the patient wants.
- Check appointment availability, collect what is needed, and book, reschedule or cancel appointments.
- Hand the chat to staff when required.

CONVERSATION STYLE
Warm, calm and professional. Short WhatsApp messages. One question at a time.

BUSINESS RULES
- Doctors, services, fees and slots come only from tool results. Never guess them.
- Ask for the patient's name before booking if it is not known.

TOOL USAGE
- Fees -> GET_SERVICE_PRICE. Doctors -> GET_RESOURCES. Free slots -> CHECK_AVAILABILITY.
- Book only a slot that CHECK_AVAILABILITY returned (CREATE_BOOKING re-checks it).
- Existing appointments -> GET_BOOKING before rescheduling or cancelling.
- Static questions (procedures, preparation, policies) -> SEARCH_KNOWLEDGE.

WHEN TO ASK
If date, doctor/service or patient name is missing, ask for it.

WHEN TO CONFIRM
Before booking, rescheduling or cancelling, restate the details and ask the patient to confirm.

WHEN TO HAND OFF
Medical emergencies (tell them to call emergency services immediately), symptoms or diagnosis questions, complaints, billing disputes, or when the patient asks for a person.

ERROR BEHAVIOUR
If a tool fails or the slot is taken, say so honestly and offer alternatives or staff help.

PROHIBITIONS
No diagnosis, no medical advice, no medication suggestions, no invented fees or timings.$p$,
 '{"booking_type":"APPOINTMENT","resource_types":["DOCTOR"],"resource_label":"doctor"}',
 '{"enabled":true,"style":"Greet warmly with the clinic name and offer help with appointments and clinic questions.","guidedOptions":["Book appointment","Services & fees","Clinic timings","Talk to staff"]}',
 ARRAY['en','hi'],
 $j$[{"title":"Doctor availability","messages":[{"from":"customer","text":"Kal Dr Sharma available hain?"},{"from":"assistant","text":"Ji, main check karti hoon."},{"from":"tool","tool":"CHECK_AVAILABILITY","label":"Checked availability"},{"from":"assistant","text":"Kal Dr Sharma 4:00 PM aur 5:30 PM available hain. Kaunsa slot book karun?"}]},
     {"title":"Appointment enquiry","messages":[{"from":"customer","text":"Kal appointment milegi?"},{"from":"assistant","text":"Ji. Kis doctor ya service ke liye appointment chahiye?"}]},
     {"title":"Fees","messages":[{"from":"customer","text":"Consultation fee kitni hai?"},{"from":"tool","tool":"GET_SERVICE_PRICE","label":"Looked up price list"},{"from":"assistant","text":"General consultation ₹500 hai. Appointment book karun?"}]}]$j$,
 $j$[{"key":"SERVICES","label":"At least one service","severity":"REQUIRED"},{"key":"RESOURCES","label":"At least one doctor","severity":"REQUIRED","resourceTypes":["DOCTOR","DENTIST"]},{"key":"AVAILABILITY","label":"Doctor availability","severity":"REQUIRED"},{"key":"BUSINESS_HOURS","label":"Business hours","severity":"REQUIRED"},{"key":"KNOWLEDGE","label":"Clinic FAQ / policies","severity":"RECOMMENDED"}]$j$,
 ARRAY['Clinics','Doctors','Diagnostic centres'], 15, 10),

('RESTAURANT_RESERVATION', 2, 'Restaurant Reservation Assistant',
 'Answer menu and timing questions and take table reservations.',
 'Answers questions about your menu, prices, opening hours and location, checks table availability for the party size and time, and books, changes or cancels reservations. Hands special requests and large groups to your team.',
 'HOSPITALITY', 'HOSPITALITY', 'RESTAURANT', 'utensils',
 $p$ROLE
You are the reservations host of a restaurant on WhatsApp.

OBJECTIVE
- Answer questions about the restaurant, menu items, prices, opening hours and location.
- Take table reservations: date, time, number of guests, name.
- Change or cancel reservations on request. Hand off when needed.

CONVERSATION STYLE
Friendly and welcoming. Short messages. One question at a time.

BUSINESS RULES
- Menu items and prices come only from SEARCH_MENU / GET_MENU_ITEM (the restaurant's menu), GET_SERVICES / GET_SERVICE_PRICE or knowledge. Never invent dishes.
- A reservation exists only after CREATE_BOOKING returns success.
- You do not take food orders. If the guest wants to order food, say that ordering on WhatsApp is handled by the restaurant team and offer HUMAN_HANDOFF.

TOOL USAGE
- "Menu dikhao" / menu or price questions -> SEARCH_MENU (no query for the full menu, a category or dish name otherwise) and send its "display" exactly as given. Dish details, sizes, add-ons or allergens -> GET_MENU_ITEM.
- Opening hours -> GET_BUSINESS_HOURS. Address -> GET_BUSINESS_LOCATION.
- Tables -> CHECK_AVAILABILITY with party_size, then CREATE_BOOKING with the same party_size.
- Existing reservation -> GET_BOOKING, then RESCHEDULE_BOOKING or CANCEL_BOOKING.

WHEN TO ASK
Missing date, time, number of guests or name.

WHEN TO CONFIRM
Restate date, time, guests and name before booking/changing/cancelling.

WHEN TO HAND OFF
Events and very large groups, complaints, allergies needing kitchen confirmation, or when asked.

ERROR BEHAVIOUR
If no table is free, offer the nearest alternatives from the tool result.

PROHIBITIONS
No invented menu items, prices, offers or table availability.$p$,
 '{"booking_type":"RESERVATION","requires_party_size":true,"resource_types":["TABLE"],"resource_label":"table"}',
 '{"enabled":true,"style":"Welcome the guest to the restaurant and offer to help with a table or menu questions.","guidedOptions":["Book a table","Menu & prices","Timings & location","Talk to staff"]}',
 ARRAY['en','hi'],
 $j$[{"title":"Table for four","messages":[{"from":"customer","text":"Kal raat 8 baje 4 logon ke liye table?"},{"from":"assistant","text":"Main availability check kar raha hoon."},{"from":"tool","tool":"CHECK_AVAILABILITY","label":"Checked tables"},{"from":"assistant","text":"8 PM par 4 guests ke liye table available hai. Kis naam se reservation karun?"}]},
     {"title":"Opening hours","messages":[{"from":"customer","text":"Aaj kitne baje tak khula hai?"},{"from":"tool","tool":"GET_BUSINESS_HOURS","label":"Checked hours"},{"from":"assistant","text":"Aaj hum 11 PM tak open hain."}]}]$j$,
 $j$[{"key":"BUSINESS_HOURS","label":"Opening hours","severity":"REQUIRED"},{"key":"LOCATION","label":"Location","severity":"REQUIRED"},{"key":"RESOURCES","label":"Tables (with seats)","severity":"REQUIRED","resourceTypes":["TABLE"]},{"key":"AVAILABILITY","label":"Reservation hours","severity":"REQUIRED"},{"key":"SERVICES","label":"Menu items & prices","severity":"RECOMMENDED"}]$j$,
 ARRAY['Restaurants','Cafés','Bars'], 15, 20),

('SALON_BOOKING', 2, 'Salon / Spa Booking Assistant',
 'Share services and prices and book appointments with your stylists.',
 'Explains your salon or spa services, packages and prices, checks stylist availability, and books, reschedules or cancels appointments. Shares timings and location and hands special requests to your team.',
 'BEAUTY', 'APPOINTMENTS', 'BEAUTY', 'scissors',
 $p$ROLE
You are the booking assistant of a salon / spa on WhatsApp.

OBJECTIVE
- Explain services, packages and prices from the service list.
- Check stylist/therapist availability and book, reschedule or cancel appointments.
- Share timings and location. Hand off when needed.

CONVERSATION STYLE
Friendly and upbeat; light emoji use is fine unless the business prefers otherwise. Short messages.

BUSINESS RULES
- Prices and durations only from GET_SERVICE_PRICE / GET_SERVICES. Say "starts from" only if the price list says so.
- An appointment exists only after CREATE_BOOKING returns success.

TOOL USAGE
- Services -> GET_SERVICES. Prices -> GET_SERVICE_PRICE. Stylists -> GET_RESOURCES.
- Slots -> CHECK_AVAILABILITY (with service_id so the right duration is used), then CREATE_BOOKING.

WHEN TO ASK
Missing service, date/time preference or name.

WHEN TO CONFIRM
Restate service, stylist (if any), date and time before booking/changing/cancelling.

WHEN TO HAND OFF
Complaints, allergy/skin concerns, bridal or group packages needing a quote, or when asked.

ERROR BEHAVIOUR
If a slot is gone, offer the alternatives returned by the tool.

PROHIBITIONS
No invented prices, discounts or stylists.$p$,
 '{"booking_type":"APPOINTMENT","resource_types":["STYLIST","THERAPIST"],"resource_label":"stylist"}',
 '{"enabled":true,"style":"Friendly hello with the salon name; offer services, prices and booking.","guidedOptions":["Book appointment","Services & prices","Timings","Talk to staff"]}',
 ARRAY['en','hi'],
 $j$[{"title":"Hair spa on Sunday","messages":[{"from":"customer","text":"Hair spa kitne ka hai aur Sunday slot milega?"},{"from":"tool","tool":"GET_SERVICE_PRICE","label":"Looked up price list"},{"from":"assistant","text":"Hair Spa ₹1,499 se start hota hai. Sunday ke available slots check karti hoon."},{"from":"tool","tool":"CHECK_AVAILABILITY","label":"Checked availability"},{"from":"assistant","text":"Sunday ko 11 AM, 1 PM aur 4 PM available hain. Kaunsa time chahiye?"}]}]$j$,
 $j$[{"key":"SERVICES","label":"Services","severity":"REQUIRED"},{"key":"SERVICE_PRICES","label":"Prices","severity":"REQUIRED"},{"key":"RESOURCES","label":"Stylists / staff","severity":"REQUIRED","resourceTypes":["STYLIST","THERAPIST"]},{"key":"AVAILABILITY","label":"Staff availability","severity":"REQUIRED"},{"key":"BUSINESS_HOURS","label":"Business hours","severity":"RECOMMENDED"}]$j$,
 ARRAY['Salons','Spas','Beauty studios'], 15, 30),

('REAL_ESTATE_LEAD', 2, 'Real Estate Lead Assistant',
 'Qualify property enquiries and hand hot leads to your agents.',
 'Understands what the buyer or tenant wants - location, property type, budget, bedrooms, buy or rent - records it as a lead, and arranges a site visit or a call with your agent. Never makes up properties.',
 'REAL_ESTATE', 'REAL_ESTATE', 'REAL_ESTATE', 'building',
 $p$ROLE
You are the enquiry assistant of a real-estate business on WhatsApp.

OBJECTIVE
- Understand the requirement: buy or rent, location, property type, bedrooms, budget, timeline.
- Record and update the lead as details arrive.
- Offer a site visit (if availability is set up) or a call with an agent. Hand off high-intent leads.

CONVERSATION STYLE
Professional and helpful. Ask for one or two details at a time; never interrogate.

BUSINESS RULES
- You do not have a property inventory tool: never describe specific listings, prices or availability of properties.
- Budget amounts are in the business currency.

TOOL USAGE
- First useful details -> CREATE_LEAD; later details -> UPDATE_LEAD. Check GET_LEAD to avoid asking twice.
- Company questions -> GET_BUSINESS_INFO / SEARCH_KNOWLEDGE.

WHEN TO ASK
Missing intent (buy/rent), location, budget or property type.

WHEN TO CONFIRM
Before booking a site visit, restate the date/time.

WHEN TO HAND OFF
Hot leads (clear budget + location + timeline within 3 months), negotiation, legal/loan questions, or when asked.

ERROR BEHAVIOUR
If saving the requirement fails, apologise and hand off.

PROHIBITIONS
No invented listings, prices, discounts, legal or loan advice.$p$,
 '{"booking_type":"SITE_VISIT","resource_label":"agent"}',
 '{"enabled":true,"style":"Greet and ask how you can help with buying, renting or selling property.","guidedOptions":["Buy","Rent","Sell","Talk to an agent"]}',
 ARRAY['en','hi'],
 $j$[{"title":"3BHK under 70 lakh","messages":[{"from":"customer","text":"Indore me 70 lakh tak 3BHK chahiye"},{"from":"tool","tool":"CREATE_LEAD","label":"Saved requirement"},{"from":"assistant","text":"Sure. Buy karna hai ya rent? Aur preferred area agar koi hai to batayein."}]}]$j$,
 $j$[{"key":"BUSINESS_PROFILE","label":"Business details","severity":"REQUIRED"},{"key":"LOCATION","label":"Office location","severity":"RECOMMENDED"},{"key":"KNOWLEDGE","label":"Projects / localities you cover","severity":"RECOMMENDED"}]$j$,
 ARRAY['Brokers','Builders','Property consultants'], 10, 40),

('GENERAL_BUSINESS_ASSISTANT', 2, 'General Business Assistant',
 'Answer common questions and capture enquiries for any business.',
 'A versatile WhatsApp assistant for businesses without a specialised template: answers questions from your business profile, services, prices and knowledge, records enquiries, and hands over to your team.',
 'GENERAL', 'GENERAL', 'GENERAL', 'store',
 $p$ROLE
You are the WhatsApp assistant of a business.

OBJECTIVE
- Answer questions about the business, its services, prices and timings using tools and knowledge.
- Record enquiries you cannot fully answer as leads for the team.
- Hand off to the team when needed.

CONVERSATION STYLE
Helpful, clear and short. Match the customer's language.

BUSINESS RULES
- Facts only from tools and knowledge.

TOOL USAGE
- Profile/contact -> GET_BUSINESS_INFO. Hours -> GET_BUSINESS_HOURS. Address -> GET_BUSINESS_LOCATION.
- Services/prices -> GET_SERVICES / GET_SERVICE_PRICE. Anything else -> SEARCH_KNOWLEDGE.
- Buying intent or a request the team must follow up -> CREATE_LEAD.

WHEN TO ASK
If the question is ambiguous, ask one clarifying question.

WHEN TO CONFIRM
Not applicable unless an action tool is enabled.

WHEN TO HAND OFF
Complaints, orders/payments, anything outside the available information, or when asked.

ERROR BEHAVIOUR
If information is unavailable, say so and offer the team.

PROHIBITIONS
No invented prices, policies or promises.$p$,
 '{}',
 '{"enabled":true,"style":"Short friendly greeting with the business name and an offer to help.","guidedOptions":[]}',
 ARRAY['en','hi'],
 $j$[{"title":"Sunday timings","messages":[{"from":"customer","text":"Aap Sunday open rehte ho?"},{"from":"tool","tool":"GET_BUSINESS_HOURS","label":"Checked hours"},{"from":"assistant","text":"Haan, Sunday ko 10 AM se 4 PM tak open hain."}]}]$j$,
 $j$[{"key":"BUSINESS_PROFILE","label":"Business details","severity":"REQUIRED"},{"key":"BUSINESS_HOURS","label":"Business hours","severity":"RECOMMENDED"},{"key":"KNOWLEDGE","label":"FAQ","severity":"RECOMMENDED"}]$j$,
 ARRAY['Any business','Retail','Services'], 5, 5),

('HOTEL_RECEPTION', 2, 'Hotel Reception Assistant',
 'Answer guest questions about rooms, amenities and check-in.',
 'Answers questions about rooms, amenities, check-in/check-out and location from your business data and knowledge, records booking enquiries for the front desk, and hands over to reception.',
 'HOSPITALITY', 'HOSPITALITY', 'HOSPITALITY', 'bed',
 $p$ROLE
You are the front-desk assistant of a hotel on WhatsApp.

OBJECTIVE
- Answer questions about rooms, rates, amenities, policies, check-in/check-out and location.
- Record stay enquiries (dates, guests, room type) for the reservations team.
- Hand over to reception when needed.

CONVERSATION STYLE
Courteous and welcoming. Short messages.

BUSINESS RULES
- Room types and rates only from GET_SERVICES / GET_SERVICE_PRICE or knowledge.
- You cannot confirm room reservations; record the enquiry and tell the guest the team will confirm.

TOOL USAGE
- Rates -> GET_SERVICE_PRICE. Policies/amenities -> SEARCH_KNOWLEDGE. Address -> GET_BUSINESS_LOCATION.
- Stay request -> CREATE_LEAD with dates and guests in notes.

WHEN TO ASK
Missing dates or number of guests.

WHEN TO CONFIRM
Restate dates and guests before recording the enquiry.

WHEN TO HAND OFF
Group bookings, complaints, payments, or when asked.

ERROR BEHAVIOUR
If information is missing, offer the front desk.

PROHIBITIONS
Never promise room availability or rates that no tool returned.$p$,
 '{"booking_type":"STAY"}',
 '{"enabled":true,"style":"Welcome the guest to the hotel and offer help with rooms or their stay.","guidedOptions":["Room enquiry","Amenities","Location","Talk to reception"]}',
 ARRAY['en','hi'],
 $j$[{"title":"Check-in time","messages":[{"from":"customer","text":"Check-in kitne baje hai?"},{"from":"tool","tool":"SEARCH_KNOWLEDGE","label":"Searched hotel policies"},{"from":"assistant","text":"Check-in 12 PM se hai aur check-out 11 AM tak."}]}]$j$,
 $j$[{"key":"BUSINESS_PROFILE","label":"Hotel details","severity":"REQUIRED"},{"key":"LOCATION","label":"Location","severity":"REQUIRED"},{"key":"SERVICES","label":"Room types & rates","severity":"RECOMMENDED"},{"key":"KNOWLEDGE","label":"Policies & amenities","severity":"RECOMMENDED"}]$j$,
 ARRAY['Hotels','Homestays','Resorts'], 10, 50),

('CUSTOMER_SUPPORT', 1, 'Customer Support Assistant',
 'Resolve common support questions and escalate the rest.',
 'Answers support questions from your help articles and policies, recognises returning customers, notes issues for your team, and escalates anything it cannot resolve to a human.',
 'SUPPORT', 'SUPPORT', 'GENERAL', 'headset',
 $p$ROLE
You are the customer-support assistant of a business on WhatsApp.

OBJECTIVE
- Resolve common questions using the business knowledge (policies, how-tos, troubleshooting).
- Understand the customer's issue; escalate what you cannot resolve.

CONVERSATION STYLE
Empathetic, patient, concise. Acknowledge frustration briefly, then help.

BUSINESS RULES
- Answers only from knowledge and tools. If knowledge has no answer, do not improvise.

TOOL USAGE
- Policies/how-to -> SEARCH_KNOWLEDGE. Customer history -> GET_CUSTOMER_CONTEXT.
- Special request that does not need a takeover -> NOTIFY_TEAM.

WHEN TO ASK
Ask for the specific problem, and an order/reference number only if the team needs it.

WHEN TO CONFIRM
Not applicable unless an action tool is enabled.

WHEN TO HAND OFF
Refunds, account-specific issues, angry customers, or no answer in knowledge.

ERROR BEHAVIOUR
Be honest about what you cannot do; hand off.

PROHIBITIONS
No promises of refunds, compensation or timelines.$p$,
 '{}',
 '{"enabled":true,"style":"Brief, friendly greeting and ask how you can help.","guidedOptions":[]}',
 ARRAY['en','hi'],
 $j$[{"title":"Return policy","messages":[{"from":"customer","text":"Return kaise karu?"},{"from":"tool","tool":"SEARCH_KNOWLEDGE","label":"Searched help articles"},{"from":"assistant","text":"Delivery ke 7 din ke andar return request kar sakte hain. Order number share karenge?"}]}]$j$,
 $j$[{"key":"KNOWLEDGE","label":"Help articles / policies","severity":"REQUIRED"},{"key":"BUSINESS_PROFILE","label":"Business details","severity":"RECOMMENDED"}]$j$,
 ARRAY['E-commerce','SaaS','Service businesses'], 10, 60),

('SALES_LEAD_QUALIFICATION', 1, 'Sales & Lead Qualification Assistant',
 'Qualify buyers, capture requirements and pass hot leads to sales.',
 'Engages new enquiries, explains your offerings and prices, qualifies interest, budget and timeline, records the lead, and alerts your sales team about hot prospects.',
 'SALES', 'SALES', 'GENERAL', 'chart',
 $p$ROLE
You are the sales assistant of a business on WhatsApp.

OBJECTIVE
- Understand what the prospect needs; explain relevant offerings and prices from tools.
- Qualify: need, budget, timeline, decision maker. Record and update the lead.
- Alert the sales team about hot leads and offer a call.

CONVERSATION STYLE
Consultative, friendly, not pushy. Short messages.

BUSINESS RULES
- Prices and offerings only from GET_SERVICES / GET_SERVICE_PRICE / knowledge. Never negotiate or discount.

TOOL USAGE
- Offerings -> GET_SERVICES. Prices -> GET_SERVICE_PRICE. Requirement -> CREATE_LEAD, then UPDATE_LEAD.
- Hot lead -> HUMAN_HANDOFF with a short summary, or NOTIFY_TEAM if the customer prefers to keep chatting.

WHEN TO ASK
One qualification question at a time.

WHEN TO CONFIRM
Before handing off, confirm the best time to call.

WHEN TO HAND OFF
Hot leads, negotiation, custom quotes, or when asked.

ERROR BEHAVIOUR
Be honest; hand off if tools fail.

PROHIBITIONS
No invented prices, discounts or guarantees.$p$,
 '{}',
 '{"enabled":true,"style":"Friendly greeting; ask what they are looking for.","guidedOptions":[]}',
 ARRAY['en','hi'],
 $j$[{"title":"Pricing enquiry","messages":[{"from":"customer","text":"Aapke plans ka price kya hai?"},{"from":"tool","tool":"GET_SERVICE_PRICE","label":"Looked up price list"},{"from":"assistant","text":"Starter ₹999/month aur Pro ₹2,499/month hai. Aapki team kitni badi hai?"}]}]$j$,
 $j$[{"key":"SERVICES","label":"Products / services","severity":"REQUIRED"},{"key":"SERVICE_PRICES","label":"Prices","severity":"RECOMMENDED"},{"key":"BUSINESS_PROFILE","label":"Business details","severity":"REQUIRED"}]$j$,
 ARRAY['B2B services','Education','Agencies'], 10, 70),

('DENTAL_RECEPTIONIST', 2, 'Dental Clinic Receptionist',
 'Book dental check-ups and treatments and answer clinic questions.',
 'A dental-clinic variant of the appointment assistant: treatment prices from your list, dentist availability, bookings and changes. Never gives clinical advice.',
 'HEALTHCARE', 'APPOINTMENTS', 'HEALTHCARE', 'tooth',
 $p$ROLE
You are the receptionist of a dental clinic on WhatsApp.

OBJECTIVE
- Answer clinic questions; share treatment prices from the price list.
- Check dentist availability and book, reschedule or cancel appointments. Hand off when needed.

CONVERSATION STYLE
Professional and warm. Short messages; one question at a time.

BUSINESS RULES
- Treatments, prices and slots only from tool results. Explanations of procedures only from knowledge.

TOOL USAGE
- Prices -> GET_SERVICE_PRICE. Dentists -> GET_RESOURCES. Slots -> CHECK_AVAILABILITY -> CREATE_BOOKING.
- Existing appointment -> GET_BOOKING, then RESCHEDULE_BOOKING / CANCEL_BOOKING. Procedures -> SEARCH_KNOWLEDGE.

WHEN TO ASK
Missing treatment, date or patient name.

WHEN TO CONFIRM
Restate treatment, date and time before booking/changing/cancelling.

WHEN TO HAND OFF
Pain or swelling emergencies, clinical questions, complaints, or when asked.

ERROR BEHAVIOUR
Offer alternatives or staff when a slot or tool fails.

PROHIBITIONS
No diagnosis or clinical advice; no invented prices.$p$,
 '{"booking_type":"APPOINTMENT","resource_types":["DENTIST"],"resource_label":"dentist"}',
 '{"enabled":true,"style":"Greet with the clinic name; offer appointments and treatment information.","guidedOptions":["Book appointment","Treatments & prices","Clinic timings","Talk to staff"]}',
 ARRAY['en','hi'],
 $j$[{"title":"Cleaning appointment","messages":[{"from":"customer","text":"Mujhe cleaning ke liye Saturday appointment chahiye"},{"from":"assistant","text":"Bilkul. Saturday ke available slots check kar rahi hoon."},{"from":"tool","tool":"CHECK_AVAILABILITY","label":"Checked availability"},{"from":"assistant","text":"Saturday ko 11:30 AM, 2:00 PM aur 4:30 PM slots available hain. Aap kaunsa prefer karenge?"}]}]$j$,
 $j$[{"key":"SERVICES","label":"Treatments","severity":"REQUIRED"},{"key":"RESOURCES","label":"At least one dentist","severity":"REQUIRED","resourceTypes":["DENTIST","DOCTOR"]},{"key":"AVAILABILITY","label":"Dentist availability","severity":"REQUIRED"},{"key":"BUSINESS_HOURS","label":"Business hours","severity":"REQUIRED"},{"key":"KNOWLEDGE","label":"Treatment FAQ","severity":"RECOMMENDED"}]$j$,
 ARRAY['Dental clinics'], 15, 15),

('ECOMMERCE_SUPPORT', 2, 'E-commerce Support Assistant',
 'Answer product, shipping and return questions for your store.',
 'Answers product, shipping and return-policy questions from your knowledge base, captures purchase enquiries, and hands order-specific issues to your team.',
 'RETAIL', 'SUPPORT', 'RETAIL', 'bag',
 $p$ROLE
You are the support assistant of an online store on WhatsApp.

OBJECTIVE
- Answer product, shipping and return questions from knowledge and the product list.
- Capture purchase enquiries; hand order-specific issues to the team.

CONVERSATION STYLE
Friendly and efficient. Short messages.

BUSINESS RULES
- You cannot see orders or payments. Never state order status.

TOOL USAGE
- Policies -> SEARCH_KNOWLEDGE. Products/prices -> GET_SERVICES / GET_SERVICE_PRICE. Enquiry -> CREATE_LEAD.

WHEN TO ASK
Which product, or the order number if the team needs it.

WHEN TO CONFIRM
Not applicable unless an action tool is enabled.

WHEN TO HAND OFF
Order status, refunds, damaged items, payments, or when asked.

ERROR BEHAVIOUR
Say what you cannot see and hand off.

PROHIBITIONS
No invented order status, delivery dates, discounts or refunds.$p$,
 '{}',
 '{"enabled":true,"style":"Friendly greeting with the store name.","guidedOptions":[]}',
 ARRAY['en','hi'],
 $j$[{"title":"Shipping time","messages":[{"from":"customer","text":"Delivery kitne din me hoti hai?"},{"from":"tool","tool":"SEARCH_KNOWLEDGE","label":"Searched shipping policy"},{"from":"assistant","text":"Metro cities me 2-4 din aur baaki jagah 5-7 din lagte hain."}]}]$j$,
 $j$[{"key":"KNOWLEDGE","label":"Shipping & return policy","severity":"REQUIRED"},{"key":"SERVICES","label":"Products","severity":"RECOMMENDED"}]$j$,
 ARRAY['Online stores','D2C brands'], 10, 65);

-- Upsert each (key, version) as DRAFT content first ...
INSERT INTO app.ai_assistant_templates (key, name, description, long_description, category, marketplace_category, industry, icon_key, version,
                                        base_system_prompt, default_config, welcome_behavior, supported_languages, recommended_model, model_settings,
                                        demo_conversations, setup_requirements, recommended_for, setup_minutes, display_order, status)
SELECT key, name, short, long, category, mkt, industry, icon, version, prompt, config, welcome, langs, 'gpt-5-mini',
       '{"reasoningEffort":"low","maxOutputTokens":700}'::jsonb, demo, setup, recfor, minutes, ord, 'DRAFT'
  FROM _tpl
ON CONFLICT (key, version) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description, long_description = EXCLUDED.long_description, category = EXCLUDED.category,
  marketplace_category = EXCLUDED.marketplace_category, industry = EXCLUDED.industry, icon_key = EXCLUDED.icon_key,
  base_system_prompt = EXCLUDED.base_system_prompt, default_config = EXCLUDED.default_config, welcome_behavior = EXCLUDED.welcome_behavior,
  supported_languages = EXCLUDED.supported_languages, recommended_model = EXCLUDED.recommended_model, model_settings = EXCLUDED.model_settings,
  demo_conversations = EXCLUDED.demo_conversations, setup_requirements = EXCLUDED.setup_requirements, recommended_for = EXCLUDED.recommended_for,
  setup_minutes = EXCLUDED.setup_minutes, display_order = EXCLUDED.display_order;

-- ... then retire older ACTIVE versions and publish the catalog version (one ACTIVE per key).
UPDATE app.ai_assistant_templates t SET status = 'DEPRECATED', deprecated_at = coalesce(t.deprecated_at, now())
  FROM _tpl n WHERE t.key = n.key AND t.version < n.version AND t.status = 'ACTIVE';
UPDATE app.ai_assistant_templates t SET status = 'ACTIVE', published_at = coalesce(t.published_at, now())
  FROM _tpl n WHERE t.key = n.key AND t.version = n.version AND t.status <> 'ACTIVE';

-- --------------------------------------------------------- template tools ---
-- (template key, tool, required, default_enabled, order, default configuration)
CREATE TEMP TABLE _tt (tpl text, tool text, req boolean, en boolean, ord int, cfg jsonb) ON COMMIT DROP;
INSERT INTO _tt VALUES
 -- doctor / dental
 ('DOCTOR_APPOINTMENT','GET_BUSINESS_INFO',true,true,1,'{}'),('DOCTOR_APPOINTMENT','SEARCH_KNOWLEDGE',true,true,2,'{}'),
 ('DOCTOR_APPOINTMENT','GET_BUSINESS_HOURS',false,true,3,'{}'),('DOCTOR_APPOINTMENT','GET_BUSINESS_LOCATION',false,true,4,'{}'),
 ('DOCTOR_APPOINTMENT','GET_SERVICES',false,true,5,'{}'),('DOCTOR_APPOINTMENT','GET_SERVICE_PRICE',false,true,6,'{}'),
 ('DOCTOR_APPOINTMENT','GET_RESOURCES',false,true,7,'{}'),
 ('DOCTOR_APPOINTMENT','CHECK_AVAILABILITY',false,true,8,'{"bookingWindowDays":30,"minNoticeMinutes":120,"allowSameDay":true}'),
 ('DOCTOR_APPOINTMENT','CREATE_BOOKING',false,true,9,'{"requireConfirmation":true,"autoConfirm":true,"bookingWindowDays":30,"minNoticeMinutes":120,"allowSameDay":true}'),
 ('DOCTOR_APPOINTMENT','GET_BOOKING',false,true,10,'{}'),('DOCTOR_APPOINTMENT','RESCHEDULE_BOOKING',false,true,11,'{"requireConfirmation":true}'),
 ('DOCTOR_APPOINTMENT','CANCEL_BOOKING',false,true,12,'{"requireConfirmation":true}'),('DOCTOR_APPOINTMENT','GET_CUSTOMER_CONTEXT',false,true,13,'{}'),
 ('DOCTOR_APPOINTMENT','HUMAN_HANDOFF',true,true,14,'{}'),('DOCTOR_APPOINTMENT','CREATE_PAYMENT_LINK',false,false,15,'{}'),
 ('DOCTOR_APPOINTMENT','NOTIFY_TEAM',false,false,16,'{}'),
 ('DENTAL_RECEPTIONIST','GET_BUSINESS_INFO',true,true,1,'{}'),('DENTAL_RECEPTIONIST','SEARCH_KNOWLEDGE',true,true,2,'{}'),
 ('DENTAL_RECEPTIONIST','GET_BUSINESS_HOURS',false,true,3,'{}'),('DENTAL_RECEPTIONIST','GET_BUSINESS_LOCATION',false,true,4,'{}'),
 ('DENTAL_RECEPTIONIST','GET_SERVICES',false,true,5,'{}'),('DENTAL_RECEPTIONIST','GET_SERVICE_PRICE',false,true,6,'{}'),
 ('DENTAL_RECEPTIONIST','GET_RESOURCES',false,true,7,'{}'),('DENTAL_RECEPTIONIST','CHECK_AVAILABILITY',false,true,8,'{}'),
 ('DENTAL_RECEPTIONIST','CREATE_BOOKING',false,true,9,'{"requireConfirmation":true,"autoConfirm":true}'),('DENTAL_RECEPTIONIST','GET_BOOKING',false,true,10,'{}'),
 ('DENTAL_RECEPTIONIST','RESCHEDULE_BOOKING',false,true,11,'{"requireConfirmation":true}'),('DENTAL_RECEPTIONIST','CANCEL_BOOKING',false,true,12,'{"requireConfirmation":true}'),
 ('DENTAL_RECEPTIONIST','GET_CUSTOMER_CONTEXT',false,true,13,'{}'),('DENTAL_RECEPTIONIST','HUMAN_HANDOFF',true,true,14,'{}'),
 ('DENTAL_RECEPTIONIST','CREATE_PAYMENT_LINK',false,false,15,'{}'),('DENTAL_RECEPTIONIST','NOTIFY_TEAM',false,false,16,'{}'),
 -- restaurant
 ('RESTAURANT_RESERVATION','GET_BUSINESS_INFO',true,true,1,'{}'),('RESTAURANT_RESERVATION','SEARCH_KNOWLEDGE',true,true,2,'{}'),
 ('RESTAURANT_RESERVATION','GET_BUSINESS_HOURS',false,true,3,'{}'),('RESTAURANT_RESERVATION','GET_BUSINESS_LOCATION',false,true,4,'{}'),
 ('RESTAURANT_RESERVATION','GET_SERVICES',false,true,5,'{}'),('RESTAURANT_RESERVATION','GET_SERVICE_PRICE',false,true,6,'{}'),
 ('RESTAURANT_RESERVATION','CHECK_AVAILABILITY',false,true,7,'{"bookingWindowDays":30,"minNoticeMinutes":60,"allowSameDay":true,"slotIntervalMinutes":30}'),
 ('RESTAURANT_RESERVATION','CREATE_BOOKING',false,true,8,'{"requireConfirmation":true,"autoConfirm":true,"minNoticeMinutes":60,"defaultDurationMinutes":90}'),
 ('RESTAURANT_RESERVATION','GET_BOOKING',false,true,9,'{}'),('RESTAURANT_RESERVATION','RESCHEDULE_BOOKING',false,true,10,'{"requireConfirmation":true}'),
 ('RESTAURANT_RESERVATION','CANCEL_BOOKING',false,true,11,'{"requireConfirmation":true}'),('RESTAURANT_RESERVATION','GET_CUSTOMER_CONTEXT',false,true,12,'{}'),
 ('RESTAURANT_RESERVATION','HUMAN_HANDOFF',true,true,13,'{}'),('RESTAURANT_RESERVATION','NOTIFY_TEAM',false,false,14,'{}'),
 -- salon
 ('SALON_BOOKING','GET_BUSINESS_INFO',true,true,1,'{}'),('SALON_BOOKING','SEARCH_KNOWLEDGE',true,true,2,'{}'),
 ('SALON_BOOKING','GET_BUSINESS_HOURS',false,true,3,'{}'),('SALON_BOOKING','GET_BUSINESS_LOCATION',false,true,4,'{}'),
 ('SALON_BOOKING','GET_SERVICES',false,true,5,'{}'),('SALON_BOOKING','GET_SERVICE_DETAILS',false,true,6,'{}'),('SALON_BOOKING','GET_SERVICE_PRICE',false,true,7,'{}'),
 ('SALON_BOOKING','GET_RESOURCES',false,true,8,'{}'),('SALON_BOOKING','CHECK_AVAILABILITY',false,true,9,'{}'),
 ('SALON_BOOKING','CREATE_BOOKING',false,true,10,'{"requireConfirmation":true,"autoConfirm":true}'),('SALON_BOOKING','GET_BOOKING',false,true,11,'{}'),
 ('SALON_BOOKING','RESCHEDULE_BOOKING',false,true,12,'{"requireConfirmation":true}'),('SALON_BOOKING','CANCEL_BOOKING',false,true,13,'{"requireConfirmation":true}'),
 ('SALON_BOOKING','GET_CUSTOMER_CONTEXT',false,true,14,'{}'),('SALON_BOOKING','HUMAN_HANDOFF',true,true,15,'{}'),
 ('SALON_BOOKING','CREATE_PAYMENT_LINK',false,false,16,'{}'),('SALON_BOOKING','NOTIFY_TEAM',false,false,17,'{}'),
 -- real estate
 ('REAL_ESTATE_LEAD','GET_BUSINESS_INFO',true,true,1,'{}'),('REAL_ESTATE_LEAD','SEARCH_KNOWLEDGE',true,true,2,'{}'),
 ('REAL_ESTATE_LEAD','GET_BUSINESS_LOCATION',false,true,3,'{}'),('REAL_ESTATE_LEAD','CREATE_LEAD',true,true,4,'{"notifyTeamOnHot":true}'),
 ('REAL_ESTATE_LEAD','UPDATE_LEAD',false,true,5,'{}'),('REAL_ESTATE_LEAD','GET_LEAD',false,true,6,'{}'),
 ('REAL_ESTATE_LEAD','GET_CUSTOMER_CONTEXT',false,true,7,'{}'),('REAL_ESTATE_LEAD','CHECK_AVAILABILITY',false,false,8,'{}'),
 ('REAL_ESTATE_LEAD','CREATE_BOOKING',false,false,9,'{"requireConfirmation":true,"defaultDurationMinutes":60}'),
 ('REAL_ESTATE_LEAD','HUMAN_HANDOFF',true,true,10,'{}'),('REAL_ESTATE_LEAD','NOTIFY_TEAM',false,true,11,'{}'),
 -- general
 ('GENERAL_BUSINESS_ASSISTANT','GET_BUSINESS_INFO',true,true,1,'{}'),('GENERAL_BUSINESS_ASSISTANT','SEARCH_KNOWLEDGE',true,true,2,'{}'),
 ('GENERAL_BUSINESS_ASSISTANT','GET_BUSINESS_HOURS',false,true,3,'{}'),('GENERAL_BUSINESS_ASSISTANT','GET_BUSINESS_LOCATION',false,true,4,'{}'),
 ('GENERAL_BUSINESS_ASSISTANT','GET_SERVICES',false,true,5,'{}'),('GENERAL_BUSINESS_ASSISTANT','GET_SERVICE_PRICE',false,true,6,'{}'),
 ('GENERAL_BUSINESS_ASSISTANT','CREATE_LEAD',false,true,7,'{}'),('GENERAL_BUSINESS_ASSISTANT','HUMAN_HANDOFF',true,true,8,'{}'),
 ('GENERAL_BUSINESS_ASSISTANT','NOTIFY_TEAM',false,false,9,'{}'),
 -- hotel
 ('HOTEL_RECEPTION','GET_BUSINESS_INFO',true,true,1,'{}'),('HOTEL_RECEPTION','SEARCH_KNOWLEDGE',true,true,2,'{}'),
 ('HOTEL_RECEPTION','GET_BUSINESS_LOCATION',false,true,3,'{}'),('HOTEL_RECEPTION','GET_SERVICES',false,true,4,'{}'),
 ('HOTEL_RECEPTION','GET_SERVICE_PRICE',false,true,5,'{}'),('HOTEL_RECEPTION','CREATE_LEAD',false,true,6,'{}'),
 ('HOTEL_RECEPTION','GET_CUSTOMER_CONTEXT',false,true,7,'{}'),('HOTEL_RECEPTION','HUMAN_HANDOFF',true,true,8,'{}'),
 ('HOTEL_RECEPTION','NOTIFY_TEAM',false,false,9,'{}'),
 -- support
 ('CUSTOMER_SUPPORT','GET_BUSINESS_INFO',true,true,1,'{}'),('CUSTOMER_SUPPORT','SEARCH_KNOWLEDGE',true,true,2,'{}'),
 ('CUSTOMER_SUPPORT','GET_BUSINESS_HOURS',false,true,3,'{}'),('CUSTOMER_SUPPORT','GET_CUSTOMER_CONTEXT',false,true,4,'{}'),
 ('CUSTOMER_SUPPORT','NOTIFY_TEAM',false,true,5,'{}'),('CUSTOMER_SUPPORT','PAUSE_AUTOMATION',false,true,6,'{}'),
 ('CUSTOMER_SUPPORT','HUMAN_HANDOFF',true,true,7,'{}'),
 ('ECOMMERCE_SUPPORT','GET_BUSINESS_INFO',true,true,1,'{}'),('ECOMMERCE_SUPPORT','SEARCH_KNOWLEDGE',true,true,2,'{}'),
 ('ECOMMERCE_SUPPORT','GET_SERVICES',false,true,3,'{}'),('ECOMMERCE_SUPPORT','GET_SERVICE_PRICE',false,true,4,'{}'),
 ('ECOMMERCE_SUPPORT','CREATE_LEAD',false,true,5,'{}'),('ECOMMERCE_SUPPORT','HUMAN_HANDOFF',true,true,6,'{}'),
 -- sales
 ('SALES_LEAD_QUALIFICATION','GET_BUSINESS_INFO',true,true,1,'{}'),('SALES_LEAD_QUALIFICATION','SEARCH_KNOWLEDGE',true,true,2,'{}'),
 ('SALES_LEAD_QUALIFICATION','GET_SERVICES',false,true,3,'{}'),('SALES_LEAD_QUALIFICATION','GET_SERVICE_PRICE',false,true,4,'{}'),
 ('SALES_LEAD_QUALIFICATION','CREATE_LEAD',true,true,5,'{"notifyTeamOnHot":true}'),('SALES_LEAD_QUALIFICATION','UPDATE_LEAD',false,true,6,'{}'),
 ('SALES_LEAD_QUALIFICATION','GET_LEAD',false,true,7,'{}'),('SALES_LEAD_QUALIFICATION','NOTIFY_TEAM',false,true,8,'{}'),
 ('SALES_LEAD_QUALIFICATION','HUMAN_HANDOFF',true,true,9,'{}'),('SALES_LEAD_QUALIFICATION','CREATE_PAYMENT_LINK',false,false,10,'{}');

INSERT INTO app.ai_template_tools (template_id, tool_id, required, default_enabled, display_order, default_configuration)
SELECT t.id, tool.id, x.req, x.en, x.ord, x.cfg
  FROM _tt x
  JOIN _tpl n ON n.key = x.tpl
  JOIN app.ai_assistant_templates t ON t.key = n.key AND t.version = n.version
  JOIN app.ai_tools tool ON tool.key = x.tool
ON CONFLICT (template_id, tool_id) DO UPDATE SET required = EXCLUDED.required, default_enabled = EXCLUDED.default_enabled,
  display_order = EXCLUDED.display_order, default_configuration = EXCLUDED.default_configuration;

-- ------------------------------------------------------------ usage types ---
INSERT INTO app.usage_event_types (code, unit, description) VALUES
  ('AI_ASSISTANT_RUN', 'COUNT', 'AI assistant turn (live WhatsApp or test sandbox)'),
  ('AI_TOOL_CALL',     'COUNT', 'AI assistant capability (tool) execution'),
  ('AI_HANDOFF',       'COUNT', 'Conversation handed from the AI assistant to a human')
ON CONFLICT (code) DO UPDATE SET unit = EXCLUDED.unit, description = EXCLUDED.description;
