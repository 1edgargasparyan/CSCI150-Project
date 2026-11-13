-- =====================================================================
-- 00 - RESET. Wipes every app table and function in the public schema
-- so 01 -> 02 -> 03 -> 05 can rebuild from a clean slate.
-- DELETES ALL APP DATA. Run only on purpose. Login accounts
-- (auth.users) are kept; their profiles are recreated by the trigger
-- the next time each person signs in.
--
-- Written Nov 2026 to undo the simplified 4-table schema that replaced
-- 01_schema.sql on the live project (it had no RFID tables, and it
-- broke Google sign-up because the old trigger expected profiles.full_name).
-- =====================================================================

drop trigger if exists on_auth_user_created on auth.users;

-- frontend-only schema (organizations/profiles/resources/reservations with date+time columns)
-- and the full schema from 01 - whichever is there
drop table if exists scan_events, usage_logs, reservations, readers, resources,
                     rfid_cards, org_invites, org_members, profiles, organizations cascade;

drop function if exists public.handle_scan(text, text, text, text);
drop function if exists public._scan_respond(uuid, text, text, text, int, text);
drop function if exists public.handle_new_user();
drop function if exists public.is_org_member(uuid);
drop function if exists public.is_org_admin(uuid);
drop function if exists public.create_organization(text, text, text, text, text);
drop function if exists public.add_member(uuid, text, text, member_role);
drop function if exists public.remove_member(uuid, uuid);
drop function if exists public.org_directory(uuid);
drop function if exists public.is_admin();
drop function if exists public.my_email();
drop function if exists public.my_org();
drop function if exists public.my_profile_id();

drop type if exists reservation_status, resource_status, resource_type, member_role;
