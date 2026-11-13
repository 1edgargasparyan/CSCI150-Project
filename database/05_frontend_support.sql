-- =====================================================================
-- 05 - What the website (Frontend/) needs on top of 01-03.
-- Run AFTER 01_schema.sql, 02_seed.sql and 03_handle_scan.sql.
--
-- Adds: org branding (title/color/logo), resource opening hours,
-- an org list the home page can read before login, invites (an admin
-- adds a Google email before that person has ever signed in),
-- create_organization / add_member / remove_member, and an
-- admin "edit branding" policy.
-- Nothing in here changes how handle_scan or the ESP32 works.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. New columns
-- ---------------------------------------------------------------------
alter table organizations
  add column if not exists title text,
  add column if not exists color text not null default '#2563eb',
  add column if not exists logo  text;                       -- data: URL, page limits it to 200 KB

alter table resources
  add column if not exists open_time  time not null default '08:00',
  add column if not exists close_time time not null default '18:00';

alter table resources drop constraint if exists resources_hours_check;
alter table resources add  constraint resources_hours_check check (open_time < close_time);

-- ---------------------------------------------------------------------
-- 2. Admins can edit their own org's branding (01 only allowed reading)
-- ---------------------------------------------------------------------
drop policy if exists "admins update their org" on organizations;
create policy "admins update their org" on organizations
  for update to authenticated using (is_org_admin(id)) with check (is_org_admin(id));

-- ---------------------------------------------------------------------
-- 3. Public org list for home.html / login.html (visitor isn't signed in)
-- Only the display fields. The organizations table itself stays locked.
-- ---------------------------------------------------------------------
create or replace function public.org_directory(p_org uuid default null)
returns table (id uuid, name text, title text, color text, logo text)
language sql stable security definer set search_path = public
as $$
  select o.id, o.name, o.title, o.color, o.logo
  from organizations o
  where p_org is null or o.id = p_org
  order by o.name;
$$;

-- ---------------------------------------------------------------------
-- 4. Invites: admin adds an email that hasn't signed in yet (FR8, FR27)
-- ---------------------------------------------------------------------
create table if not exists org_invites (
  org_id      uuid not null references organizations (id) on delete cascade,
  email       text not null check (email = lower(email)),
  full_name   text,
  role        member_role not null default 'member',
  invited_at  timestamptz not null default now(),
  primary key (org_id, email)
);
alter table org_invites enable row level security;

drop policy if exists "admins manage org invites" on org_invites;
create policy "admins manage org invites" on org_invites
  for all to authenticated using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- First Google login: create the profile (as before) AND turn any
-- pending invites for that email into real memberships.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(new.email);
  v_name  text := coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name');
begin
  insert into profiles (id, email, full_name)
  values (new.id, v_email,
          coalesce(v_name, (select i.full_name from org_invites i
                            where i.email = v_email and i.full_name is not null limit 1)));

  insert into org_members (org_id, user_id, role)
  select i.org_id, new.id, i.role from org_invites i where i.email = v_email
  on conflict do nothing;

  delete from org_invites where email = v_email;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. create_organization: signed-in user makes an org and becomes admin
-- (same name and arguments the frontend already calls)
-- ---------------------------------------------------------------------
create or replace function public.create_organization(
  org_name text, org_title text, org_color text, org_logo text, admin_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'Please sign in with Google first.';
  end if;
  if coalesce(trim(org_name), '') = '' then
    raise exception 'Enter a name for the organization.';
  end if;
  if exists (select 1 from organizations where lower(name) = lower(trim(org_name))) then
    raise exception 'An organization named "%" already exists.', trim(org_name);
  end if;

  insert into organizations (name, title, color, logo)
  values (trim(org_name), nullif(trim(org_title), ''),
          coalesce(nullif(org_color, ''), '#2563eb'), nullif(org_logo, ''))
  returning id into v_org;

  insert into org_members (org_id, user_id, role) values (v_org, v_uid, 'admin');

  if coalesce(trim(admin_name), '') <> '' then
    update profiles set full_name = trim(admin_name) where id = v_uid;
  end if;

  return v_org;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. add_member: existing account -> member now; new email -> invite.
-- security definer because admins can't look up profiles outside
-- their org (and shouldn't be able to browse them).
-- ---------------------------------------------------------------------
create or replace function public.add_member(
  p_org uuid, p_email text, p_name text, p_role member_role default 'member'
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_user  uuid;
begin
  if not is_org_admin(p_org) then
    raise exception 'Only admins can add members.' using errcode = '42501';
  end if;

  select id into v_user from profiles where email = v_email;

  if v_user is not null then
    insert into org_members (org_id, user_id, role) values (p_org, v_user, p_role)
    on conflict (org_id, user_id) do update set role = excluded.role;
    update profiles set full_name = coalesce(full_name, nullif(trim(p_name), '')) where id = v_user;
    return json_build_object('status', 'added', 'id', v_user);
  end if;

  insert into org_invites (org_id, email, full_name, role)
  values (p_org, v_email, nullif(trim(p_name), ''), p_role)
  on conflict (org_id, email) do update set full_name = excluded.full_name, role = excluded.role;
  return json_build_object('status', 'invited', 'id', null);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. remove_member: drops the membership (NOT the person's account,
-- which may belong to other orgs) and cancels their future bookings here.
-- ---------------------------------------------------------------------
create or replace function public.remove_member(p_org uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_org_admin(p_org) then
    raise exception 'Only admins can remove members.' using errcode = '42501';
  end if;
  if exists (select 1 from org_members where org_id = p_org and user_id = p_user and role = 'admin')
     and (select count(*) from org_members where org_id = p_org and role = 'admin') = 1 then
    raise exception 'You can''t remove the last admin.';
  end if;

  update reservations set status = 'cancelled'
  where org_id = p_org and user_id = p_user and status = 'reserved' and starts_at > now();

  delete from org_members where org_id = p_org and user_id = p_user;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Who may call what
-- ---------------------------------------------------------------------
revoke all on function public.org_directory(uuid)                            from public;
revoke all on function public.create_organization(text, text, text, text, text) from public, anon;
revoke all on function public.add_member(uuid, text, text, member_role)     from public, anon;
revoke all on function public.remove_member(uuid, uuid)                     from public, anon;
revoke all on function public.handle_new_user()                             from public, anon, authenticated;

grant execute on function public.org_directory(uuid)                            to anon, authenticated;
grant execute on function public.create_organization(text, text, text, text, text) to authenticated;
grant execute on function public.add_member(uuid, text, text, member_role)     to authenticated;
grant execute on function public.remove_member(uuid, uuid)                     to authenticated;
