-- =====================================================================
-- Test data for Reserve and Check-In/Out. Run AFTER 01_schema.sql.
-- Fixed IDs so you and your teammates can reference them in tests.
-- =====================================================================

-- One organization
insert into organizations (id, name, email_domain) values
  ('00000000-0000-0000-0000-000000000001', 'Fresno State CS', 'mail.fresnostate.edu');

-- One room and one piece of equipment
insert into resources (id, org_id, name, type, building, tag_uid, max_hold) values
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001',
   'Study Room 101', 'room', 'Library', null, interval '2 hours'),
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000001',
   'TI-84 Calculator #1', 'equipment', 'Library', 'A1B2C3D4', interval '7 days');

-- The ESP32, mounted on Room 101 (id matches READER_ID in the firmware)
insert into readers (id, org_id, resource_id, location) values
  ('ESP32_01', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000101', 'Outside Study Room 101');

-- ---------------------------------------------------------------------
-- TEST USER: users must exist in auth.users first.
--   1. Dashboard -> Authentication -> Users -> Add user (any email/password)
--   2. Copy that user's UUID and paste it below in place of YOUR-USER-UUID
--   3. Replace 04A3B21C with the real UID your partner's reader prints
--      for your student ID card (uppercase hex)
--   4. Uncomment and run
-- ---------------------------------------------------------------------
-- insert into org_members (org_id, user_id, role) values
--   ('00000000-0000-0000-0000-000000000001', 'YOUR-USER-UUID', 'admin');
--
-- insert into rfid_cards (uid, user_id, assigned_at) values
--   ('04A3B21C', 'YOUR-USER-UUID', now());
--
-- -- A reservation starting now, so a scan has something to check in to
-- -- (inserted directly as the database owner, which skips the "must be
-- -- in the future" rule that applies to the web app)
-- insert into reservations (org_id, resource_id, user_id, starts_at, ends_at) values
--   ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101',
--    'YOUR-USER-UUID', now(), now() + interval '1 hour');
