// data-supabase.js – the website's database functions, using Supabase with Google sign-in.
// Written for the RFID database design:
//   organizations, profiles (one per Google login, made automatically on first sign-in),
//   org_members (who is in which organization, role 'admin' or 'member'),
//   org_invites (people an admin added who haven't signed in yet),
//   resources (status: available / reserved / in_use / maintenance),
//   reservations (starts_at / ends_at, status: reserved / checked_in / completed / cancelled / no_show).
//
// Every HTML page loads these lines, in this order:
//     <script src="ui.js"></script>
//     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
//     <script src="data-supabase.js"></script>

// ---------- settings: Supabase → Project Settings → API ----------
const SUPABASE_URL = 'https://ciybtljbqogoknnfffmv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_d4fOjaAWNwHum95wAwSI4A_mfLh0XWQ';

// sessionStorage = each browser tab has its own login (handy for showing an admin and a member side by side)
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storage: sessionStorage } });

// A person can belong to several organizations; this remembers which one this tab is using
const ORG_KEY = 'rnc-current-org';

// ---------- small helpers ----------

// Turns a Supabase error into a normal Error with a readable message
function check(error) {
  if (!error) return;
  if (error.code === '23P01') throw new Error('Someone has already reserved part of that time.');
  if (error.code === '42501') throw new Error("You don't have permission to do that.");
  throw new Error(error.message);
}

const hhmm = t => (t || '').slice(0, 5);  // Postgres sends "10:00:00", the pages use "10:00"

// The website shows roles as 'admin' / 'user'; the database calls them 'admin' / 'member'
const toWebRole = role => (role === 'admin' ? 'admin' : 'user');

// The website shows resources as 'available' / 'unavailable'; in the database 'unavailable' is 'maintenance'
// (reserved / in_use are set by the RFID system and still count as reservable)
const toWebStatus = status => (status === 'maintenance' ? 'unavailable' : 'available');

// "2026-11-20" + "14:30" (your local time) → a timestamp the database stores
function toTimestamp(date, time) {
  return new Date(`${date}T${time}:00`).toISOString();
}

// A database timestamp → { date: "2026-11-20", time: "14:30" } in your local time
function fromTimestamp(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return {
    date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
    time: pad(d.getHours()) + ':' + pad(d.getMinutes())
  };
}

// "01:30:00" or "1 day 02:00:00" (a database interval) → minutes
function intervalToMinutes(text) {
  if (!text) return 60;
  let minutes = 0;
  const days = /(\d+)\s+day/.exec(text);
  if (days) minutes += Number(days[1]) * 24 * 60;
  const time = /(\d+):(\d+)(?::(\d+))?/.exec(text);
  if (time) minutes += Number(time[1]) * 60 + Number(time[2]);
  return minutes;
}

// 90 → "1 hour 30 minutes"
function describeMinutes(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  const parts = [];
  if (h) parts.push(h + (h === 1 ? ' hour' : ' hours'));
  if (m) parts.push(m + (m === 1 ? ' minute' : ' minutes'));
  return parts.join(' ') || '0 minutes';
}

// ================= Organizations =================

// → list of organizations [{ id, name, title, color, logo }]. Works before signing in.
async function getOrgs() {
  const { data, error } = await sb.rpc('org_directory');
  check(error);
  return data;
}

// orgId → one organization { id, name, title, color, logo }, or null. Works before signing in.
async function getOrg(orgId) {
  if (!orgId) return null;
  const { data, error } = await sb.rpc('org_directory', { p_org: orgId });
  check(error);
  return data[0] || null;
}

// orgId, { title, color, logo } → the updated organization (admins only)
async function saveBranding(orgId, branding) {
  const { data, error } = await sb.from('organizations')
    .update({ title: branding.title || null, color: branding.color, logo: branding.logo || null })
    .eq('id', orgId).select('id, name, title, color, logo').single();
  check(error);
  return data;
}

// ================= Signing in (Google) =================

// page → sends the browser to Google's sign-in page. When Google is done it comes back to `page`
// (e.g. 'createOrg.html' or 'login.html?org=...&role=...').
async function signInWithGoogle(page) {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: new URL(page, location.href).href, queryParams: { prompt: 'select_account' } }
  });
  check(error);
}

// orgId, role → Google sign-in for login.html. Comes back to login.html with the same org and role.
async function loginWithGoogle(orgId, role) {
  await signInWithGoogle('login.html?' + new URLSearchParams({ org: orgId, role }).toString());
}

// → the email of the Google account signed in on this tab, or null
async function getGoogleEmail() {
  const { data } = await sb.auth.getSession();
  return data.session ? (data.session.user.email || '').toLowerCase() : null;
}

// Signs out of Google on this tab without leaving the page
async function signOutOnly() {
  sessionStorage.removeItem(ORG_KEY);
  await sb.auth.signOut();
}

// Builds the { user, org } the pages use, for one organization this person belongs to
async function buildSession(authUser, membership) {
  const { data: profile } = await sb.from('profiles').select('full_name, email').eq('id', authUser.id).maybeSingle();
  const email = (profile && profile.email) || (authUser.email || '').toLowerCase();
  const user = {
    id: authUser.id,
    org_id: membership.org_id,
    name: (profile && profile.full_name) || email,
    email,
    role: toWebRole(membership.role)
  };
  return { user, org: await getOrg(membership.org_id) };
}

// orgId, role → called when login.html opens.
// Returns the user if they just signed in with Google and belong to this organization with this role,
// or null if nobody is signed in yet. Throws (and signs out) if their Google account isn't allowed here.
async function finishLogin(orgId, role) {
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  const authUser = data.session.user;
  const email = (authUser.email || '').toLowerCase();
  const { data: membership, error } = await sb.from('org_members').select('org_id, role')
    .eq('org_id', orgId).eq('user_id', authUser.id).maybeSingle();
  check(error);
  if (!membership) {
    await signOutOnly();
    throw new Error(`${email} isn't a member of this organization. Ask an admin to add this Google account.`);
  }
  if (toWebRole(membership.role) !== role) {
    await signOutOnly();
    throw new Error(role === 'admin' ? `${email} is not an admin here. Use Member login.` : `${email} is an admin here. Use Admin login.`);
  }
  sessionStorage.setItem(ORG_KEY, orgId);
  return (await buildSession(authUser, membership)).user;
}

// → { user, org } for whoever is signed in on this tab, or null.
// user = { id, org_id, name, email, role: 'admin'|'user' }; org = { id, name, title, color, logo }
async function getSession() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  const authUser = data.session.user;
  const { data: memberships, error } = await sb.from('org_members').select('org_id, role').eq('user_id', authUser.id);
  check(error);
  if (!memberships || !memberships.length) return null;   // signed in, but not in any organization yet
  const membership = memberships.find(m => m.org_id === sessionStorage.getItem(ORG_KEY)) || memberships[0];
  sessionStorage.setItem(ORG_KEY, membership.org_id);
  return buildSession(authUser, membership);
}

// role → { user, org }. Sends the visitor back to the home page if they aren't allowed here.
async function requireLogin(role) {
  const session = await getSession();
  if (!session || session.user.role !== role) {
    location.href = 'home.html';
    return new Promise(() => {}); // stop the page while it leaves
  }
  return session;
}

// Signs out and returns to the home page
async function logout() {
  await signOutOnly();
  location.href = 'home.html';
}

// { name, title, color, logo, adminName } → the new organization's id.
// The signed-in Google account becomes its first admin. Throws if not signed in or the name is missing/taken.
async function createOrganization({ name, title, color, logo, adminName }) {
  const { data, error } = await sb.rpc('create_organization', {
    org_name: name, org_title: title, org_color: color, org_logo: logo, admin_name: adminName
  });
  check(error);
  sessionStorage.setItem(ORG_KEY, data);   // open the new organization's dashboard next
  return data;
}

// ================= People (admin) =================

// orgId → everyone in the organization: admins first, then members, then people invited who haven't signed in yet.
// Each: { id, org_id, name, email, role: 'admin'|'user', pending }
async function listUsers(orgId) {
  const [members, invites] = await Promise.all([
    sb.from('org_members').select('user_id, role, profiles(full_name, email)').eq('org_id', orgId),
    sb.from('org_invites').select('email, full_name, role').eq('org_id', orgId)
  ]);
  check(members.error);
  check(invites.error);
  const people = members.data.map(m => ({
    id: m.user_id, org_id: orgId,
    name: (m.profiles && (m.profiles.full_name || m.profiles.email)) || 'Unknown',
    email: (m.profiles && m.profiles.email) || '',
    role: toWebRole(m.role), pending: false
  }));
  const invited = invites.data.map(i => ({
    id: 'invite:' + i.email, org_id: orgId,
    name: (i.full_name || i.email) + ' (invited – hasn\'t signed in yet)',
    email: i.email, role: toWebRole(i.role), pending: true
  }));
  const order = p => (p.pending ? 2 : p.role === 'admin' ? 0 : 1);
  return people.concat(invited).sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

// orgId, name, email, role ('user' or 'admin') → { name, email, role, status: 'added'|'invited' }.
// They can then sign in with Google using that email.
async function addUser(orgId, name, email, role = 'user') {
  email = email.trim().toLowerCase();
  if (!name.trim()) throw new Error('Enter the person\'s name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter their Google email address.');
  const dbRole = role === 'admin' ? 'admin' : 'member';
  const { data, error } = await sb.rpc('add_member', { p_org: orgId, p_email: email, p_name: name.trim(), p_role: dbRole });
  check(error);
  return { name: name.trim(), email, role: toWebRole(dbRole), status: data && data.status };
}

// userId → removes the person from the current organization (their future reservations are cancelled).
// For someone invited who hasn't signed in yet, cancels the invite.
async function removeUser(userId) {
  const orgId = sessionStorage.getItem(ORG_KEY);
  if (String(userId).startsWith('invite:')) {
    const { error } = await sb.from('org_invites').delete().eq('org_id', orgId).eq('email', userId.slice('invite:'.length));
    check(error);
    return;
  }
  const { error } = await sb.rpc('remove_member', { p_org: orgId, p_user: userId });
  check(error);
}

// ================= Resources =================

// Database row → what the pages use
function toWebResource(r) {
  return {
    id: r.id, org_id: r.org_id, name: r.name, type: r.type,
    open_time: hhmm(r.open_time), close_time: hhmm(r.close_time),
    status: toWebStatus(r.status),               // 'available' | 'unavailable'
    db_status: r.status,                         // available / reserved / in_use / maintenance
    max_hold_minutes: intervalToMinutes(r.max_hold),
    building: r.building, tag_uid: r.tag_uid
  };
}

// orgId → the organization's rooms and equipment, sorted by name
async function listResources(orgId) {
  const { data, error } = await sb.from('resources').select('*').eq('org_id', orgId).order('name');
  check(error);
  return data.map(toWebResource);
}

// orgId, resource (with id = edit, without id = add) → the saved resource. Throws on bad input.
// Only the fields the website manages are changed; RFID fields (building, tag_uid, max_hold) are left alone.
async function saveResource(orgId, resource) {
  if (!resource.name.trim()) throw new Error('Enter a name.');
  if (!(resource.open_time < resource.close_time)) throw new Error('"Available until" must be after "Available from".');
  const fields = { org_id: orgId, name: resource.name.trim(), type: resource.type, open_time: resource.open_time, close_time: resource.close_time };

  let query;
  if (resource.id) {
    // Only touch the status when switching to or from maintenance, so the RFID system's
    // 'reserved' / 'in_use' states aren't overwritten
    const { data: current } = await sb.from('resources').select('status').eq('id', resource.id).maybeSingle();
    if (resource.status === 'unavailable') fields.status = 'maintenance';
    else if (current && current.status === 'maintenance') fields.status = 'available';
    query = sb.from('resources').update(fields).eq('id', resource.id);
  } else {
    fields.status = resource.status === 'unavailable' ? 'maintenance' : 'available';
    query = sb.from('resources').insert(fields);
  }
  const { data, error } = await query.select().single();
  check(error);
  return toWebResource(data);
}

// resourceId → removes the resource (its reservations are removed too)
async function removeResource(resourceId) {
  const { error } = await sb.from('resources').delete().eq('id', resourceId);
  check(error);
}

// ================= Reservations =================

// { orgId, userId?, resourceId?, date? } → reservations that aren't cancelled, sorted by time.
// Each: { id, org_id, resource_id, user_id, date, start_time, end_time, status, resourceName, userName }
async function listReservations({ orgId, userId, resourceId, date }) {
  let query = sb.from('reservations')
    .select('id, org_id, resource_id, user_id, starts_at, ends_at, status, resources(name), profiles(full_name, email)')
    .eq('org_id', orgId).neq('status', 'cancelled');
  if (userId) query = query.eq('user_id', userId);
  if (resourceId) query = query.eq('resource_id', resourceId);
  if (date) {
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    query = query.gte('starts_at', dayStart.toISOString()).lt('starts_at', dayEnd.toISOString());
  }
  const { data, error } = await query.order('starts_at');
  check(error);
  return data.map(r => {
    const start = fromTimestamp(r.starts_at), end = fromTimestamp(r.ends_at);
    return {
      id: r.id, org_id: r.org_id, resource_id: r.resource_id, user_id: r.user_id,
      date: start.date, start_time: start.time, end_time: end.time, status: r.status,
      resourceName: (r.resources && r.resources.name) || 'Deleted resource',
      // members can only see their own name; other people's bookings show as "Reserved"
      userName: (r.profiles && (r.profiles.full_name || r.profiles.email)) || 'Reserved'
    };
  });
}

// orgId, userId, resourceId, date, start, end → the new reservation.
// Throws a readable message if the booking breaks one of the database's rules:
// in the past, more than 30 days ahead, longer than the resource's limit, outside its hours,
// under maintenance, or overlapping another booking.
async function reserve(orgId, userId, resourceId, date, start, end) {
  const { data: row } = await sb.from('resources').select('*').eq('id', resourceId).maybeSingle();
  if (!row) throw new Error('Choose a resource.');
  const resource = toWebResource(row);
  if (resource.status !== 'available') throw new Error(resource.name + ' is under maintenance right now.');
  if (!date || !start || !end) throw new Error('Choose a date, start time and end time.');
  if (!(start < end)) throw new Error('End time must be after start time.');
  if (start < resource.open_time || end > resource.close_time) {
    throw new Error(`${resource.name} can only be reserved between ${formatTime(resource.open_time)} and ${formatTime(resource.close_time)}.`);
  }
  const startsAt = new Date(`${date}T${start}:00`), endsAt = new Date(`${date}T${end}:00`);
  if (startsAt <= new Date()) throw new Error('That time has already passed.');
  if (startsAt > new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)) throw new Error('You can only book up to 30 days ahead.');
  const minutes = (endsAt - startsAt) / 60000;
  if (minutes > resource.max_hold_minutes) {
    throw new Error(`${resource.name} can be reserved for at most ${describeMinutes(resource.max_hold_minutes)} at a time.`);
  }

  const { data, error } = await sb.from('reservations')
    .insert({ org_id: orgId, resource_id: resourceId, user_id: userId, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() })
    .select('id').single();
  if (error && error.code === '42501') throw new Error("That booking isn't allowed. Check the time limits for this resource.");
  check(error);
  return data;
}

// reservationId → cancels it (members: their own bookings that haven't started; admins: any in their organization)
async function cancelReservation(reservationId) {
  const { data, error } = await sb.from('reservations').update({ status: 'cancelled' })
    .eq('id', reservationId).select('id');
  check(error);
  if (!data || !data.length) throw new Error("This reservation can't be cancelled (it may have already started).");
}