-- =====================================================================
-- 04 - Checks & tests. The CHECK queries are safe to run anytime.
-- Tip: in the Supabase SQL Editor, highlight one query and click Run
-- to see just that result.
-- =====================================================================

-- CHECK 1: Is the database set up correctly?
-- Expect: tables 9 | resources: Study Room 101, TI-84 Calculator #1
--         readers: ESP32_01 - secret set | RLS off on: none
select 'tables' as what, count(*)::text as result
  from information_schema.tables
  where table_schema = 'public'
    and table_name in ('organizations','profiles','org_members','rfid_cards','resources',
                       'readers','reservations','usage_logs','scan_events')
union all
select 'resources', string_agg(name || ' (' || status || ')', ', ') from resources
union all
select 'readers', string_agg(id || case when device_secret_hash is null
                                        then ' - NO SECRET SET' else ' - secret set' end, ', ')
  from readers
union all
select 'RLS off on', coalesce(string_agg(tablename, ', '), 'none')
  from pg_tables where schemaname = 'public' and not rowsecurity;

-- CHECK 2: Last 10 scans (what the ESP32 sent and what it got back)
select scanned_at, reader_id, card_uid, equipment_uid, http_status, reason
from scan_events
order by scanned_at desc
limit 10;

-- CHECK 3: Recent sessions (who is checked in where)
select u.checked_in_at, u.checked_out_at, p.email, r.name as resource
from usage_logs u
join profiles p on p.id = u.user_id
join resources r on r.id = u.resource_id
order by u.checked_in_at desc
limit 10;

-- =====================================================================
-- SCAN TESTS: simulate the ESP32. These DO change data.
-- Run one line at a time, waiting 5+ seconds between taps.
-- Replace SECRET only while testing. NEVER save or commit the real key.
-- =====================================================================
-- select handle_scan('04A3B21C', 'ESP32_01', 'SECRET');               -- tap 1: Checked in / tap 2: Checked out
-- select handle_scan('FFFFFFFF', 'ESP32_01', 'SECRET');               -- unknown card: Not authorized
-- select handle_scan('04A3B21C', 'ESP32_01', 'wrong');                -- bad key: Unknown device
-- select handle_scan('04A3B21C', 'ESP32_01', 'SECRET', 'A1B2C3D4');   -- equipment: Checked out / Checked in

-- =====================================================================
-- ADMIN: rotate the reader key. Shows the NEW secret once.
-- The old key stops working immediately; update the ESP32's secrets.h.
-- =====================================================================
-- with s as (select encode(extensions.gen_random_bytes(24), 'hex') as secret)
-- update readers
-- set device_secret_hash = extensions.crypt(s.secret, extensions.gen_salt('bf'))
-- from s
-- where id = 'ESP32_01'
-- returning s.secret;
