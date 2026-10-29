-- =====================================================================
-- Reserve and Check-In/Out - handle_scan (the function the ESP32 calls)
-- Run AFTER 01_schema.sql and 02_seed.sql.
-- ESP32 calls: POST https://<project>.supabase.co/rest/v1/rpc/handle_scan
-- JSON body:   {"card_uid":"04A3B21C","reader_id":"ESP32_01",
--               "device_key":"<secret>","equipment_uid":"A1B2C3D4"}
--              (equipment_uid only at an equipment station)
-- Returns:     HTTP 200 or 403 + {"ok":true/false,"message":"<OLED text>"}
-- Covers FR4, FR13, FR14, FR15, FR16, FR25
-- =====================================================================

-- Password-style hashing for each reader's secret key
create extension if not exists pgcrypto with schema extensions;

-- Each ESP32 gets its own secret. Only a hash is stored, like a password.
-- Why: the anon key is public (it ships inside the website), so without
-- this, anyone could fake a scan from their laptop.
alter table readers add column if not exists device_secret_hash text;

-- ---------------------------------------------------------------------
-- Helper: log the attempt (FR4), set the HTTP status, build the reply
-- ---------------------------------------------------------------------
create or replace function public._scan_respond(
  p_org uuid, p_reader text, p_card text, p_equip text,
  p_status int, p_message text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into scan_events (org_id, reader_id, card_uid, equipment_uid, http_status, reason)
  values (p_org, p_reader, p_card, p_equip, p_status, p_message);

  perform set_config('response.status', p_status::text, true);  -- real 200 / 403
  return json_build_object('ok', p_status = 200, 'message', p_message);
end;
$$;

-- ---------------------------------------------------------------------
-- Main function
-- ---------------------------------------------------------------------
create or replace function public.handle_scan(
  card_uid      text,
  reader_id     text,
  device_key    text,
  equipment_uid text default null
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  v_card   text := upper(trim(coalesce(handle_scan.card_uid, '')));
  v_equip  text := upper(nullif(trim(handle_scan.equipment_uid), ''));
  v_is_eq  boolean := upper(nullif(trim(handle_scan.equipment_uid), '')) is not null;
  v_reader readers%rowtype;
  v_user   uuid;
  v_res    resources%rowtype;
  v_rsv    reservations%rowtype;
  v_open   usage_logs%rowtype;
begin
  -- STEP 1: Is this a registered reader with the correct secret?
  select * into v_reader from readers r where r.id = handle_scan.reader_id;
  if not found
     or v_reader.device_secret_hash is null
     or crypt(coalesce(handle_scan.device_key, ''), v_reader.device_secret_hash)
        <> v_reader.device_secret_hash then
    return _scan_respond(null, handle_scan.reader_id, v_card, v_equip, 403, 'Unknown device');
  end if;

  -- STEP 2 (FR4): Whose card is this, and are they in this reader's org (FR8)?
  select c.user_id into v_user from rfid_cards c where c.uid = v_card;
  if v_user is null or not exists (
       select 1 from org_members m
       where m.org_id = v_reader.org_id and m.user_id = v_user) then
    return _scan_respond(v_reader.org_id, v_reader.id, v_card, v_equip, 403, 'Not authorized');
  end if;

  -- STEP 3 (FR13): Which resource? Equipment tag if one was sent,
  -- otherwise the room this reader is mounted on. "for update" locks the
  -- row so two simultaneous scans can't both check in.
  if v_is_eq then
    select * into v_res from resources r
    where r.tag_uid = v_equip and r.org_id = v_reader.org_id and r.type = 'equipment'
    for update;
  else
    select * into v_res from resources r
    where r.id = v_reader.resource_id and r.type = 'room'
    for update;
  end if;

  if not found then
    return _scan_respond(v_reader.org_id, v_reader.id, v_card, v_equip, 403,
      case when v_is_eq then 'Unknown equipment' else 'No room on reader' end);
  end if;

  if v_res.status = 'maintenance' then
    return _scan_respond(v_reader.org_id, v_reader.id, v_card, v_equip, 403, 'Under maintenance');
  end if;

  -- STEP 4: Is a session already open on this resource?
  select * into v_open from usage_logs u
  where u.resource_id = v_res.id and u.checked_out_at is null;

  if found then
    -- Someone else has it
    if v_open.user_id <> v_user then
      return _scan_respond(v_reader.org_id, v_reader.id, v_card, v_equip, 403, 'In use by another user');
    end if;

    -- Same person within 5 seconds = a double tap or an ESP32 retry.
    -- Repeat the last answer instead of immediately ending the session.
    if v_open.checked_in_at > now() - interval '5 seconds' then
      return _scan_respond(v_reader.org_id, v_reader.id, v_card, v_equip, 200,
        case when v_is_eq then 'Checked out' else 'Checked in' end);
    end if;

    -- END the session (FR15 check-out time, FR14 status)
    update usage_logs set checked_out_at = now() where id = v_open.id;

    if v_open.reservation_id is not null then
      update reservations set status = 'completed' where id = v_open.reservation_id;
    end if;

    update resources set status =
      case when exists (
             select 1 from reservations x
             where x.resource_id = v_res.id and x.status = 'reserved'
               and x.starts_at <= now() + interval '15 minutes' and x.ends_at > now())
           then 'reserved'::resource_status
           else 'available'::resource_status end
    where id = v_res.id;

    -- Room: second tap = leaving. Equipment: second tap = returning it.
    return _scan_respond(v_reader.org_id, v_reader.id, v_card, v_equip, 200,
      case when v_is_eq then 'Checked in' else 'Checked out' end);
  end if;

  -- STEP 5 (FR25): Nobody is using it. Is it reserved right now?
  -- (A reservation counts from 5 minutes before its start time.)
  select * into v_rsv from reservations x
  where x.resource_id = v_res.id and x.status = 'reserved'
    and x.starts_at <= now() + interval '5 minutes' and x.ends_at > now()
  order by x.starts_at
  limit 1;

  if v_rsv.id is not null and v_rsv.user_id <> v_user then
    return _scan_respond(v_reader.org_id, v_reader.id, v_card, v_equip, 403, 'Room is reserved');
  end if;

  if v_rsv.id is not null then
    update reservations set status = 'checked_in' where id = v_rsv.id;  -- stops FR28 no-show cancel
  end if;

  -- START the session (FR15) and mark the resource in use (FR14)
  insert into usage_logs (org_id, resource_id, user_id, reader_id, reservation_id)
  values (v_reader.org_id, v_res.id, v_user, v_reader.id, v_rsv.id);

  update resources set status = 'in_use' where id = v_res.id;

  -- Room: first tap = arriving. Equipment: first tap = taking it out.
  return _scan_respond(v_reader.org_id, v_reader.id, v_card, v_equip, 200,
    case when v_is_eq then 'Checked out' else 'Checked in' end);
end;
$$;

-- ---------------------------------------------------------------------
-- Permissions: ONLY the ESP32 (anon key + device secret) may call
-- handle_scan. Logged-in website users can't fake scans, and nobody
-- can call the helper directly.
-- ---------------------------------------------------------------------
revoke all on function public._scan_respond(uuid, text, text, text, int, text)
  from public, anon, authenticated;
revoke all on function public.handle_scan(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.handle_scan(text, text, text, text) to anon;
