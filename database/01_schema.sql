-- =====================================================================
-- Reserve and Check-In/Out (Radio RNC) - Supabase schema v1
-- Run in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- FR = functional requirement number from the requirements doc
-- =====================================================================

-- Needed so the reservation overlap rule (FR12 non-functional) can mix
-- "same resource" (=) with "overlapping time" (&&) in one constraint.
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- 1. ENUMS (fixed lists of allowed values)
-- ---------------------------------------------------------------------
create type member_role        as enum ('member', 'admin');                                   -- FR27
create type resource_type      as enum ('room', 'equipment');                                 -- FR26
create type resource_status    as enum ('available', 'reserved', 'in_use', 'maintenance');     -- FR3, FR14, FR29
create type reservation_status as enum ('reserved', 'checked_in', 'completed', 'cancelled', 'no_show'); -- FR17, FR28

-- ---------------------------------------------------------------------
-- 2. TABLES
-- ---------------------------------------------------------------------

-- FR8: every resource, reservation and log belongs to one organization
create table organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  email_domain  text,                       -- e.g. 'mail.fresnostate.edu' (FR6)
  created_at    timestamptz not null default now()
);

-- One row per signed-in person. Filled automatically by the trigger in
-- section 4 when someone logs in with Google for the first time (FR6).
create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null unique,
  full_name   text,
  created_at  timestamptz not null default now()
);

-- Which orgs a user belongs to, and whether they're an admin there (FR8, FR27)
create table org_members (
  org_id   uuid not null references organizations (id) on delete cascade,
  user_id  uuid not null references profiles (id) on delete cascade,
  role     member_role not null default 'member',
  primary key (org_id, user_id)
);

-- FR20: physical card UID -> user. user_id is null while a card is unassigned.
-- UID format matches the firmware: uppercase hex, 4-byte (8 chars) or 7-byte (14 chars).
create table rfid_cards (
  uid          text primary key check (uid ~ '^[0-9A-F]{8}([0-9A-F]{6})?$'),
  user_id      uuid unique references profiles (id) on delete set null,
  assigned_at  timestamptz
);

-- FR26: rooms and equipment
create table resources (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  name        text not null,
  type        resource_type not null,
  building    text,
  tag_uid     text unique check (tag_uid ~ '^[0-9A-F]{8}([0-9A-F]{6})?$'), -- equipment tag (FR13)
  max_hold    interval not null default interval '1 hour',  -- e.g. 1 hour room, 7 days calculator
  status      resource_status not null default 'available', -- live status (FR14), Realtime-enabled
  created_at  timestamptz not null default now(),
  unique (id, org_id),                                       -- lets child tables prove org matches
  check (type = 'equipment' or tag_uid is null)              -- only equipment carries a tag
);

-- Each ESP32. id must match READER_ID in the firmware (e.g. 'ESP32_01').
-- resource_id = the room this reader is mounted on (null for an equipment-only station).
create table readers (
  id           text primary key,
  org_id       uuid not null references organizations (id) on delete cascade,
  resource_id  uuid,
  location     text,
  foreign key (resource_id, org_id) references resources (id, org_id) on delete set null (resource_id)
);

-- FR10, FR11, FR17, FR28
create table reservations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  resource_id  uuid not null,
  user_id      uuid not null references profiles (id) on delete cascade,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  status       reservation_status not null default 'reserved',
  created_at   timestamptz not null default now(),
  foreign key (resource_id, org_id) references resources (id, org_id) on delete cascade,
  check (ends_at - starts_at >= interval '15 minutes'),     -- FR10 minimum length
  -- FR12 non-functional: 100% of overlapping bookings blocked, even under
  -- simultaneous requests. Cancelled / completed / no-show rows don't count.
  constraint no_overlapping_reservations exclude using gist (
    resource_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('reserved', 'checked_in'))
);

-- FR15: one row per session; check-out time is filled in on the second scan
create table usage_logs (
  id              bigint generated always as identity primary key,
  org_id          uuid not null,
  resource_id     uuid not null,
  user_id         uuid not null references profiles (id) on delete cascade,
  reader_id       text references readers (id) on delete set null,
  reservation_id  uuid references reservations (id) on delete set null,
  checked_in_at   timestamptz not null default now(),       -- database clock (FR15 sync rule)
  checked_out_at  timestamptz,
  no_checkout     boolean not null default false,           -- auto-closed session flag (FR15)
  foreign key (resource_id, org_id) references resources (id, org_id) on delete cascade,
  check (checked_out_at is null or checked_out_at >= checked_in_at)
);

-- FR4: raw log of every scan attempt, approved or not
create table scan_events (
  id             bigint generated always as identity primary key,
  org_id         uuid references organizations (id) on delete cascade, -- null if reader unknown
  reader_id      text,
  card_uid       text not null,
  equipment_uid  text,
  http_status    int,             -- 200 or 403 returned to the ESP32
  reason         text,            -- text shown on the OLED (FR16)
  scanned_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. INDEXES
-- ---------------------------------------------------------------------
-- A resource can only have ONE open session at a time (blocks double check-in)
create unique index one_open_session_per_resource
  on usage_logs (resource_id) where checked_out_at is null;

create index reservations_user_start     on reservations (user_id, starts_at);      -- My Reservations (FR17)
create index reservations_resource_start on reservations (resource_id, starts_at);  -- availability (FR9)
create index usage_logs_org_time         on usage_logs (org_id, checked_in_at desc); -- admin view (FR18)
create index scan_events_time            on scan_events (scanned_at desc);
create index resources_org               on resources (org_id);

-- ---------------------------------------------------------------------
-- 4. AUTO-CREATE A PROFILE ON FIRST LOGIN (FR6)
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 5. ROW-LEVEL SECURITY (FR8 - zero cross-organization leakage)
-- ---------------------------------------------------------------------
-- Helper checks. security definer so they can read org_members without
-- triggering org_members' own policies (avoids infinite recursion).
create or replace function public.is_org_member(p_org uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from org_members where org_id = p_org and user_id = auth.uid()
  );
$$;

create or replace function public.is_org_admin(p_org uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from org_members
    where org_id = p_org and user_id = auth.uid() and role = 'admin'
  );
$$;

alter table organizations enable row level security;
alter table profiles      enable row level security;
alter table org_members   enable row level security;
alter table rfid_cards    enable row level security;
alter table resources     enable row level security;
alter table readers       enable row level security;
alter table reservations  enable row level security;
alter table usage_logs    enable row level security;
alter table scan_events   enable row level security;

-- organizations
create policy "members read their orgs" on organizations
  for select to authenticated using (is_org_member(id));

-- profiles
create policy "read own profile" on profiles
  for select to authenticated using (id = auth.uid());
create policy "update own profile" on profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "admins read their members' profiles" on profiles
  for select to authenticated using (
    exists (select 1 from org_members m
            where m.user_id = profiles.id and is_org_admin(m.org_id))
  );

-- org_members
create policy "read own memberships or as admin" on org_members
  for select to authenticated using (user_id = auth.uid() or is_org_admin(org_id));
create policy "admins manage members" on org_members
  for all to authenticated using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- rfid_cards: users can see their own card. Assigning cards (FR20) will go
-- through an admin function later, so no write policy here.
create policy "read own card" on rfid_cards
  for select to authenticated using (user_id = auth.uid());

-- resources
create policy "members read org resources" on resources
  for select to authenticated using (is_org_member(org_id));
create policy "admins manage org resources" on resources
  for all to authenticated using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- readers
create policy "admins manage org readers" on readers
  for all to authenticated using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- reservations
create policy "members read org reservations" on reservations   -- FR9/FR10: everyone sees "Reserved"
  for select to authenticated using (is_org_member(org_id));

create policy "members create own reservations" on reservations -- FR10, FR11
  for insert to authenticated with check (
    reservations.user_id = auth.uid()
    and is_org_member(reservations.org_id)
    and reservations.status = 'reserved'
    and reservations.starts_at > now()
    and reservations.starts_at <= now() + interval '30 days'
    and exists (
      select 1 from resources r
      where r.id = reservations.resource_id
        and r.org_id = reservations.org_id
        and r.status <> 'maintenance'
        and reservations.ends_at - reservations.starts_at <= r.max_hold
    )
  );

create policy "users cancel own future reservations" on reservations -- FR17
  for update to authenticated
  using (user_id = auth.uid() and status = 'reserved' and starts_at > now())
  with check (user_id = auth.uid() and status = 'cancelled');

create policy "admins manage org reservations" on reservations
  for all to authenticated using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- Regular users may only change the status column (so "cancel" can't
-- also move the time). Admin edits go through the same column limit;
-- widen this later if admins need to edit times.
revoke update on reservations from authenticated;
grant  update (status) on reservations to authenticated;

-- usage_logs + scan_events: admins read only (FR15, FR18).
-- No insert/update policies on purpose: only the scan function
-- (security definer, built next) is allowed to write these.
create policy "admins read org usage logs" on usage_logs
  for select to authenticated using (is_org_admin(org_id));
create policy "admins read org scan events" on scan_events
  for select to authenticated using (is_org_admin(org_id));

-- No policies grant anything to the "anon" role, so the public key alone
-- can read or write NOTHING in these tables.

-- ---------------------------------------------------------------------
-- 6. REALTIME (FR14: web app shows status change within 5 seconds)
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table resources;
