-- =============================================================================
-- PLATFORM SEED (Havan booking): capabilities for the "Havan Booking Assistant"
-- template + the platform festival calendar. Idempotent, platform data only.
-- Tool keys are what the model calls; descriptions are what it reads.
-- No tool ever returns a dakshina amount (see src/ai/tools/handlers/havan.ts).
-- =============================================================================

INSERT INTO app.ai_tools (key, name, description, category, handler_key, side_effect, is_read_only, has_side_effects, risk_level,
                          requires_confirmation, availability, capability_name, capability_description, input_schema, output_schema, config_schema, version)
SELECT t.key, t.name, t.description, t.category, t.handler, t.side_effect, t.side_effect = 'READ', t.side_effect <> 'READ', t.risk,
       t.confirm, 'READY', t.cap, t.capdesc, t.input::jsonb, '{"type":"object"}'::jsonb, t.config::jsonb, 1
FROM (VALUES
  ('SEARCH_BAGLAMUKHI_KNOWLEDGE', 'Search Baglamukhi knowledge',
   'Search Pandit Ji''s verified knowledge base: Maa Baglamukhi, Dashamahavidya, katha, Pitambara/peela rang, public devotional mantra information, havan vidhi, samagri, jaap vs havan vs anushthan, the online havan process, Navratri worship. Call it BEFORE answering any religious or factual question. If it returns nothing, do not answer from memory: say Pandit Ji will confirm.',
   'KNOWLEDGE', 'knowledge.search', 'READ', 'LOW', false, 'Baglamukhi knowledge', 'Answers religious questions only from the knowledge Pandit Ji adds.',
   $j${"type":"object","additionalProperties":false,"required":["query"],"properties":{"query":{"type":"string","minLength":2,"maxLength":300},"limit":{"type":"integer","minimum":1,"maximum":8}}}$j$,
   $j${"type":"object","properties":{"maxResults":{"type":"integer","minimum":1,"maximum":8,"default":4}}}$j$),
  ('GET_TEMPLE_INFORMATION', 'Get temple information',
   'Nalkheda Maa Baglamukhi mandir information published by Pandit Ji: address/map, darshan timings, how to reach, temple rules, notes, plus matching knowledge-base passages (history, legends). Use for anything that can change (timings, rules, travel).',
   'BUSINESS_INFO', 'havan.temple_info', 'READ', 'LOW', false, 'Temple information', 'Shares mandir address, darshan timings, how to reach and rules.',
   $j${"type":"object","additionalProperties":false,"properties":{"topic":{"type":"string","enum":["LOCATION","DARSHAN_TIMINGS","HOW_TO_REACH","RULES","HISTORY","ALL"]}}}$j$,
   '{"type":"object","properties":{}}'),
  ('GET_HAVAN_SERVICE_DETAILS', 'Get havan service details',
   'The havan types Pandit Ji offers - SAMANYA (samanya samagri), VISHESH (21 jadi-buti), MAHA_VISHESH (31 jadi-buti) - with description, herb count (and names only if listed), samagri, duration, number of Pandits, whether Nalkheda in-person and/or online sankalp is offered, and exactly which online facilities exist (live video call, recording, photos, prasad courier, international courier) and what the yajman should prepare. Never contains dakshina.',
   'BUSINESS_INFO', 'havan.service_details', 'READ', 'LOW', false, 'Havan types & online process', 'Explains Samanya, Vishesh and Maha Vishesh havan and the online havan facilities.',
   $j${"type":"object","additionalProperties":false,"properties":{"tier":{"type":"string","enum":["SAMANYA","VISHESH","MAHA_VISHESH"]}}}$j$,
   '{"type":"object","properties":{}}'),
  ('GET_DAKSHINA_POLICY', 'Get dakshina policy',
   'Use when the customer asks about dakshina, charges, price, "approx", "range" or "sabse sasta". Returns the policy only: dakshina is told by Pandit Ji on a phone call, never in chat. No amounts exist in any tool.',
   'BUSINESS_INFO', 'havan.dakshina_policy', 'READ', 'LOW', false, 'Dakshina on call', 'Makes sure dakshina is only discussed by Pandit Ji on a call.',
   $j${"type":"object","additionalProperties":false,"properties":{}}$j$, '{"type":"object","properties":{}}'),
  ('GET_FESTIVAL_CONTEXT', 'Get festival context',
   'Today''s date and weekday in the temple timezone, Navratri status (NAVRATRI_ACTIVE / BEFORE_NAVRATRI / AFTER_NAVRATRI / NO_NAVRATRI_NEAR), active and upcoming festivals (Navratri, Baglamukhi Jayanti...) and Pandit Ji''s own special dates. Call before mentioning ANY festival, tithi or "Navratri chal rahi hai".',
   'BUSINESS_INFO', 'havan.festival_context', 'READ', 'LOW', false, 'Festival calendar', 'Knows Navratri and festival dates so replies are never stale.',
   $j${"type":"object","additionalProperties":false,"properties":{"lookahead_days":{"type":"integer","minimum":1,"maximum":120}}}$j$,
   '{"type":"object","properties":{}}'),
  ('GET_YAJMAN_LEAD', 'Get yajman enquiry',
   'What is already known about this yajman: name, stored enquiry (stage, havan interest, online/Nalkheda, preferred date/time, city, sankalp topic), whether a call-back was already requested, and how many upcoming havan bookings they have. Call at the start of a conversation and never re-ask what it returns.',
   'SALES', 'havan.lead_get', 'READ', 'LOW', false, 'Remember yajman', 'Remembers what each yajman already told you.',
   $j${"type":"object","additionalProperties":false,"properties":{}}$j$, '{"type":"object","properties":{}}'),
  ('UPDATE_YAJMAN_LEAD', 'Update yajman enquiry',
   'Save what became clear about this yajman (creates the enquiry if needed): lead_stage, service_interest, participation_mode, preferred_date/time, city, urgency, a one-line sankalp_topic (no sensitive detail), an objection, notes. Never tell the customer these labels.',
   'SALES', 'havan.lead_update', 'WRITE', 'LOW', false, 'Track enquiries', 'Keeps each yajman''s enquiry up to date for Pandit Ji.',
   $j${"type":"object","additionalProperties":false,"properties":{"lead_stage":{"type":"string","enum":["NEW","INFORMATION_SEEKER","EXPLORING","INTERESTED","HIGH_INTENT","CALLBACK_REQUESTED","READY_TO_BOOK","BOOKING_IN_PROGRESS","BOOKED","FOLLOW_UP","HUMAN_HANDOFF"]},"service_interest":{"type":"string","enum":["SAMANYA","VISHESH","MAHA_VISHESH","NOT_DECIDED"]},"participation_mode":{"type":"string","enum":["NALKHEDA_IN_PERSON","ONLINE_SANKALP","NOT_DECIDED"]},"preferred_date":{"type":"string","format":"date"},"preferred_time":{"type":"string","maxLength":40},"city":{"type":"string","maxLength":100},"urgency":{"type":"string","enum":["LOW","NORMAL","HIGH"]},"sankalp_topic":{"type":"string","maxLength":120},"objection":{"type":"string","maxLength":200},"notes":{"type":"string","maxLength":500}}}$j$,
   '{"type":"object","properties":{}}'),
  ('CHECK_PANDIT_AVAILABILITY', 'Check Pandit Ji availability',
   'Is Pandit Ji free on ONE specific date (e.g. "12 October ko ho jayega?")? Optional preferred_time (HH:MM, 24h) returns requestedTimeFree and the nearest free slots; optional havan tier uses that havan''s duration. Returns only free slots, never other bookings.',
   'BOOKING', 'havan.check_availability', 'READ', 'LOW', false, 'Check a date', 'Checks Pandit Ji''s real calendar for a specific date.',
   $j${"type":"object","additionalProperties":false,"required":["date"],"properties":{"date":{"type":"string","format":"date"},"preferred_time":{"type":"string","format":"time"},"tier":{"type":"string","enum":["SAMANYA","VISHESH","MAHA_VISHESH"]}}}$j$,
   $j${"type":"object","properties":{"bookingWindowDays":{"type":"integer","minimum":1,"maximum":365,"default":60},"minNoticeMinutes":{"type":"integer","minimum":0,"maximum":10080,"default":240},"allowSameDay":{"type":"boolean","default":true},"slotIntervalMinutes":{"type":"integer","minimum":5,"maximum":240,"default":30},"maxSlots":{"type":"integer","minimum":1,"maximum":20,"default":6},"defaultDurationMinutes":{"type":"integer","minimum":15,"maximum":1440,"default":120}}}$j$),
  ('GET_AVAILABLE_SLOTS', 'Get available slots',
   'Pandit Ji''s free havan slots over a range of up to 7 days ("kab available hain", "Navratri mein kab ho sakta hai", "next week shaam ko"). Optional havan tier and time_of_day. Offer 2-3 of the returned slots; never invent one.',
   'BOOKING', 'havan.available_slots', 'READ', 'LOW', false, 'Find free slots', 'Offers real free slots from Pandit Ji''s calendar.',
   $j${"type":"object","additionalProperties":false,"required":["date_from"],"properties":{"date_from":{"type":"string","format":"date"},"date_to":{"type":"string","format":"date"},"tier":{"type":"string","enum":["SAMANYA","VISHESH","MAHA_VISHESH"]},"time_of_day":{"type":"string","enum":["MORNING","AFTERNOON","EVENING","ANY"]},"preferred_time":{"type":"string","format":"time"}}}$j$,
   $j${"type":"object","properties":{"bookingWindowDays":{"type":"integer","minimum":1,"maximum":365,"default":60},"minNoticeMinutes":{"type":"integer","minimum":0,"maximum":10080,"default":240},"allowSameDay":{"type":"boolean","default":true},"slotIntervalMinutes":{"type":"integer","minimum":5,"maximum":240,"default":30},"maxSlots":{"type":"integer","minimum":1,"maximum":20,"default":6},"defaultDurationMinutes":{"type":"integer","minimum":15,"maximum":1440,"default":120}}}$j$),
  ('CREATE_HAVAN_BOOKING', 'Create havan booking',
   'Book a havan for this yajman at a start time returned by the slot tools. Needs participation_mode, yajman_name and city (ask name and city together); tier if decided; gotra/family_names/sankalp (one line)/prasad_address only when the yajman is going ahead (online). Re-checks the slot. Call it as soon as slot, mode, name and city are known: its CONFIRMATION_REQUIRED result is the single confirmation (never ask "book kar doon?" yourself before calling). On success it also schedules the 1-day-before reminders for Pandit Ji and the yajman and returns their status. Dakshina stays "call par".',
   'BOOKING', 'havan.create_booking', 'WRITE', 'MEDIUM', true, 'Book havan', 'Books havan in Pandit Ji''s calendar and sets reminders.',
   $j${"type":"object","additionalProperties":false,"required":["start_at","participation_mode","yajman_name","city"],"properties":{"start_at":{"type":"string","format":"date-time"},"participation_mode":{"type":"string","enum":["NALKHEDA_IN_PERSON","ONLINE_SANKALP"]},"yajman_name":{"type":"string","minLength":1,"maxLength":100},"city":{"type":"string","minLength":2,"maxLength":100},"tier":{"type":"string","enum":["SAMANYA","VISHESH","MAHA_VISHESH"]},"gotra":{"type":"string","maxLength":80},"family_names":{"type":"string","maxLength":500},"sankalp":{"type":"string","maxLength":300},"prasad_address":{"type":"string","maxLength":500},"notes":{"type":"string","maxLength":300}}}$j$,
   $j${"type":"object","properties":{"requireConfirmation":{"type":"boolean","default":true},"autoConfirm":{"type":"boolean","default":true},"autoReminders":{"type":"boolean","default":true},"bookingWindowDays":{"type":"integer","minimum":1,"maximum":365,"default":60},"minNoticeMinutes":{"type":"integer","minimum":0,"maximum":10080,"default":240},"allowSameDay":{"type":"boolean","default":true},"requireCustomerName":{"type":"boolean","default":true},"defaultDurationMinutes":{"type":"integer","minimum":15,"maximum":1440,"default":120},"slotIntervalMinutes":{"type":"integer","minimum":5,"maximum":240,"default":30}}}$j$),
  ('GET_HAVAN_BOOKING', 'Get havan bookings',
   'This yajman''s upcoming havan bookings (or one by id) with havan type, online/Nalkheda, dakshina status (always "Pandit Ji call par batayenge" until agreed on a call) and pending reminders. Use before rescheduling or cancelling.',
   'BOOKING', 'havan.get_booking', 'READ', 'LOW', false, 'Look up havan bookings', 'Tells yajmans about their havan bookings.',
   $j${"type":"object","additionalProperties":false,"properties":{"booking_id":{"type":"string","format":"uuid"}}}$j$, '{"type":"object","properties":{}}'),
  ('RESCHEDULE_HAVAN_BOOKING', 'Reschedule havan booking',
   'Move one of this yajman''s havan bookings to a new free start time in one step (never create a second booking). Keeps the havan details, cancels the old reminders and schedules new ones. The customer must confirm first.',
   'BOOKING', 'havan.reschedule', 'WRITE', 'MEDIUM', true, 'Reschedule havan', 'Moves a havan to another free slot and updates reminders.',
   $j${"type":"object","additionalProperties":false,"required":["booking_id","new_start_at"],"properties":{"booking_id":{"type":"string","format":"uuid"},"new_start_at":{"type":"string","format":"date-time"}}}$j$,
   $j${"type":"object","properties":{"requireConfirmation":{"type":"boolean","default":true},"autoReminders":{"type":"boolean","default":true},"minNoticeMinutes":{"type":"integer","minimum":0,"maximum":10080,"default":240},"bookingWindowDays":{"type":"integer","minimum":1,"maximum":365,"default":60},"slotIntervalMinutes":{"type":"integer","minimum":5,"maximum":240,"default":30}}}$j$),
  ('CANCEL_HAVAN_BOOKING', 'Cancel havan booking',
   'Cancel one of this yajman''s upcoming havan bookings and its pending reminders. The customer must confirm first.',
   'BOOKING', 'havan.cancel', 'WRITE', 'MEDIUM', true, 'Cancel havan', 'Cancels a havan booking on request.',
   $j${"type":"object","additionalProperties":false,"required":["booking_id"],"properties":{"booking_id":{"type":"string","format":"uuid"},"reason":{"type":"string","maxLength":300}}}$j$,
   $j${"type":"object","properties":{"requireConfirmation":{"type":"boolean","default":true},"minNoticeMinutes":{"type":"integer","minimum":0,"maximum":10080,"default":0}}}$j$),
  ('CREATE_YAJMAN_REMINDER', 'Create yajman reminder',
   'Schedule a WhatsApp reminder to THIS yajman in this chat - only when they asked to be reminded (e.g. "Navratri se pehle yaad dila dena"). remind_at at least 5 minutes ahead, at most 60 days; short message. Booking reminders are created automatically by CREATE_HAVAN_BOOKING - do not duplicate them.',
   'COMMUNICATION', 'havan.yajman_reminder', 'WRITE', 'LOW', false, 'Yajman reminders', 'Sends a reminder to the yajman when they ask for one.',
   $j${"type":"object","additionalProperties":false,"required":["remind_at","message"],"properties":{"remind_at":{"type":"string","format":"date-time"},"message":{"type":"string","minLength":2,"maxLength":300},"booking_id":{"type":"string","format":"uuid"}}}$j$,
   '{"type":"object","properties":{}}'),
  ('CREATE_PANDIT_REMINDER', 'Create Pandit Ji reminder',
   'Send Pandit Ji a note about this yajman now, or at remind_at (dashboard notification + WhatsApp to Pandit Ji''s number if set). The yajman''s name and number are added automatically. For call-backs use REQUEST_PANDIT_HANDOFF instead.',
   'COMMUNICATION', 'havan.pandit_reminder', 'WRITE', 'LOW', false, 'Pandit Ji reminders', 'Reminds Pandit Ji about follow-ups.',
   $j${"type":"object","additionalProperties":false,"required":["message"],"properties":{"message":{"type":"string","minLength":2,"maxLength":500},"remind_at":{"type":"string","format":"date-time"},"booking_id":{"type":"string","format":"uuid"}}}$j$,
   '{"type":"object","properties":{}}'),
  ('REQUEST_PANDIT_HANDOFF', 'Request Pandit Ji',
   'Involve Pandit Ji. type CALLBACK: Pandit Ji will phone the yajman (dakshina, which havan, booking, guidance) - pass callback_number as typed, or use_whatsapp_number=true when they say "isi number par"; the number is validated and Pandit Ji is notified immediately; YOU KEEP HELPING in this chat. Write summary as one line in simple Hindi (Devanagari) for Pandit Ji. type CHAT_HANDOFF: Pandit Ji takes over this WhatsApp chat (complaint, payment issue, personal spiritual guidance, tantra/diksha questions, repeated misunderstanding); you stop replying after one closing message. Only claim success after this tool succeeds.',
   'COMMUNICATION', 'havan.request_pandit', 'WRITE', 'LOW', false, 'Pandit Ji call-back / handoff', 'Arranges a call-back from Pandit Ji or hands the chat over.',
   $j${"type":"object","additionalProperties":false,"required":["type","reason","summary"],"properties":{"type":{"type":"string","enum":["CALLBACK","CHAT_HANDOFF"]},"reason":{"type":"string","enum":["DAKSHINA","HAVAN_TYPE","BOOKING","GUIDANCE","MANTRA_OR_TANTRA","COMPLAINT","PAYMENT","NOT_UNDERSTOOD","OTHER"]},"summary":{"type":"string","minLength":2,"maxLength":500},"callback_number":{"type":"string","minLength":6,"maxLength":32},"use_whatsapp_number":{"type":"boolean"},"preferred_call_time":{"type":"string","maxLength":100},"tier":{"type":"string","enum":["SAMANYA","VISHESH","MAHA_VISHESH","NOT_DECIDED"]},"participation_mode":{"type":"string","enum":["NALKHEDA_IN_PERSON","ONLINE_SANKALP","NOT_DECIDED"]}}}$j$,
   '{"type":"object","properties":{}}')
) AS t(key, name, description, category, handler, side_effect, risk, confirm, cap, capdesc, input, config)
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, category = EXCLUDED.category, handler_key = EXCLUDED.handler_key,
  side_effect = EXCLUDED.side_effect, is_read_only = EXCLUDED.is_read_only, has_side_effects = EXCLUDED.has_side_effects, risk_level = EXCLUDED.risk_level,
  requires_confirmation = EXCLUDED.requires_confirmation, availability = EXCLUDED.availability, status = 'ACTIVE',
  capability_name = EXCLUDED.capability_name, capability_description = EXCLUDED.capability_description, input_schema = EXCLUDED.input_schema, config_schema = EXCLUDED.config_schema;

INSERT INTO app.ai_tool_dependencies (tool_id, depends_on_tool_id, relation)
SELECT a.id, b.id, d.rel FROM (VALUES
  ('CREATE_HAVAN_BOOKING', 'GET_AVAILABLE_SLOTS', 'RECOMMENDS'), ('RESCHEDULE_HAVAN_BOOKING', 'GET_HAVAN_BOOKING', 'REQUIRES'),
  ('RESCHEDULE_HAVAN_BOOKING', 'GET_AVAILABLE_SLOTS', 'RECOMMENDS'), ('CANCEL_HAVAN_BOOKING', 'GET_HAVAN_BOOKING', 'REQUIRES'),
  ('UPDATE_YAJMAN_LEAD', 'GET_YAJMAN_LEAD', 'RECOMMENDS')
) AS d(tool, dep, rel) JOIN app.ai_tools a ON a.key = d.tool JOIN app.ai_tools b ON b.key = d.dep
ON CONFLICT (tool_id, depends_on_tool_id) DO UPDATE SET relation = EXCLUDED.relation;

-- Festival calendar (platform reference data). Sources checked 30 Sep 2026; regional panchangs can differ by a day,
-- so the assistant always says exact muhurat will be confirmed by Pandit Ji.
INSERT INTO app.festival_calendar (key, name, kind, starts_on, ends_on, notes, source) VALUES
  ('SHARADIYA_NAVRATRI_2026', 'Sharadiya Navratri', 'NAVRATRI', '2026-10-11', '2026-10-19',
   'Ghatasthapana 11 Oct; Durga Ashtami and Maha Navami both on 19 Oct 2026.', 'indiatvnews.com / astrovidhi.com'),
  ('VIJAYADASHAMI_2026', 'Vijayadashami (Dussehra)', 'FESTIVAL', '2026-10-20', '2026-10-20', NULL, 'indiatvnews.com'),
  ('CHAITRA_NAVRATRI_2027', 'Chaitra Navratri', 'NAVRATRI', '2027-04-07', '2027-04-15',
   'Ghatasthapana 7 Apr (Gudi Padwa / Ugadi); Ram Navami 15 Apr 2027.', 'hinducalendar.app / divinehindu.in'),
  ('BAGLAMUKHI_JAYANTI_2027', 'Maa Baglamukhi Jayanti', 'JAYANTI', '2027-05-13', '2027-05-13',
   'Vaishakh Shukla Ashtami.', 'bhaktibharat.com')
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on,
  notes = EXCLUDED.notes, source = EXCLUDED.source;
