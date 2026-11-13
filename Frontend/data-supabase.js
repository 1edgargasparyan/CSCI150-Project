// data-supabase.js – database functions using Supabase, with Google sign-in.
//
// Every HTML page loads these two lines (instead of data.js):
//     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
//     <script src="data-supabase.js"></script>

// ---------- settings: Supabase → Project Settings → API ----------
const SUPABASE_URL = 'https://ciybtljbqogoknnfffmv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_d4fOjaAWNwHum95wAwSI4A_mfLh0XWQ';

// sessionStorage = each browser tab has its own login (handy for showing an admin and a member side by side)
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storage: sessionStorage } });

const hhmm = t => (t || '').slice(0, 5);  // Postgres sends "10:00:00", the pages use "10:00"

// Turns a Supabase error into a normal Error with a readable message
function check(error) {
  if (!error) return;
  if (error.code === '23P01') throw new Error('Someone has already reserved part of that time.');
  if (error.code === '23505') throw new Error('That Google account is already registered (it may belong to another organization).');
  if (error.code === '42501') throw new Error("You don't have permission to do that.");
  throw new Error(error.message);
}

// ================= Organizations =================

// → list of organizations [{ id, name, title, color, logo }]
async function getOrgs() {
  const { data, error } = await sb.from('organizations').select('*').order('name');
  check(error);
  return data;
}

// orgId → one organization, or null
async function getOrg(orgId) {
  const { data, error } = await sb.from('organizations').select('*').eq('id', orgId).maybeSingle();
  check(error);
  return data;
}

// orgId, { title, color, logo } → the updated organization (admins only)
async function saveBranding(orgId, branding) {
  const { data, error } = await sb.from('organizations').update(branding).eq('id', orgId).select().single();
  check(error);
  return data;
}

// ================= Logging in (Google) =================

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

// → the email of the Google account signed in on this tab, or null.
// (Works even if that account doesn't belong to any organization yet.)
async function getGoogleEmail() {
  const { data } = await sb.auth.getSession();
  return data.session ? (data.session.user.email || '').toLowerCase() : null;
}

// { name, title, color, logo, adminName } → the new organization's id.
// The signed-in Google account becomes its first admin. Throws if not signed in,
// if the name is missing, or if that Google account already belongs to an organization.
async function createOrganization({ name, title, color, logo, adminName }) {
  const { data, error } = await sb.rpc('create_organization', {
    org_name: name, org_title: title, org_color: color, org_logo: logo, admin_name: adminName
  });
  check(error);
  return data;
}

// Signs out of Google on this tab without leaving the page
async function signOutOnly() {
  await sb.auth.signOut();
}

// orgId, role → called when login.html opens.
// Returns the person's profile if they just signed in with Google and belong to this organization
// with this role, or null if nobody is signed in yet. Throws (and signs out) if their Google account isn't allowed here.
async function finishLogin(orgId, role) {
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  const email = (data.session.user.email || '').toLowerCase();
  const { data: profile } = await sb.from('profiles').select('*').eq('email', email).maybeSingle();
  if (!profile || profile.org_id !== orgId) {
    await sb.auth.signOut();
    throw new Error(`${email} isn't registered with this organization. Ask your admin to add this Google account.`);
  }
  if (profile.role !== role) {
    await sb.auth.signOut();
    throw new Error(role === 'admin' ? `${email} is not an admin. Use Member login.` : `${email} is an admin account. Use Admin login.`);
  }
  return profile;
}

// → { user, org } for whoever is logged in on this tab, or null
async function getSession() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  const email = (data.session.user.email || '').toLowerCase();
  const { data: user } = await sb.from('profiles').select('*').eq('email', email).maybeSingle();
  if (!user) return null;
  return { user, org: await getOrg(user.org_id) };
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

// Logs out and returns to the home page
async function logout() {
  await sb.auth.signOut();
  location.href = 'home.html';
}

// ================= Members (admin) =================

// orgId → everyone in the organization (admins first, then members), sorted by name.
// Each: { id, org_id, name, email, role: 'admin'|'user' }
async function listUsers(orgId) {
  const { data, error } = await sb.from('profiles').select('*').eq('org_id', orgId).order('role').order('name');
  check(error);
  return data;
}

// orgId, name, email, role ('user' or 'admin') → the new person.
// They can then sign in with Google using that email.
async function addUser(orgId, name, email, role = 'user') {
  email = email.trim().toLowerCase();
  if (!name.trim()) throw new Error('Enter the person\'s name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter their Google email address.');
  if (role !== 'admin') role = 'user';
  const { data, error } = await sb.from('profiles').insert({ org_id: orgId, name: name.trim(), email, role }).select().single();
  check(error);
  return data;
}

// userId → removes the member (they can no longer sign in here) and their reservations
async function removeUser(userId) {
  const { error } = await sb.from('profiles').delete().eq('id', userId);
  check(error);
}

// ================= Resources =================

// orgId → the organization's rooms and equipment, sorted by name
async function listResources(orgId) {
  const { data, error } = await sb.from('resources').select('*').eq('org_id', orgId).order('name');
  check(error);
  return data.map(r => ({ ...r, open_time: hhmm(r.open_time), close_time: hhmm(r.close_time) }));
}

// orgId, resource (with id = edit, without id = add) → the saved resource. Throws on bad input.
async function saveResource(orgId, resource) {
  if (!resource.name.trim()) throw new Error('Enter a name.');
  if (!(resource.open_time < resource.close_time)) throw new Error('"Available until" must be after "Available from".');
  const fields = { org_id: orgId, name: resource.name.trim(), type: resource.type, open_time: resource.open_time, close_time: resource.close_time, status: resource.status };
  const { data, error } = resource.id
    ? await sb.from('resources').update(fields).eq('id', resource.id).select().single()
    : await sb.from('resources').insert(fields).select().single();
  check(error);
  return { ...data, open_time: hhmm(data.open_time), close_time: hhmm(data.close_time) };
}

// resourceId → removes the resource (its reservations are removed automatically)
async function removeResource(resourceId) {
  const { error } = await sb.from('resources').delete().eq('id', resourceId);
  check(error);
}

// ================= Reservations =================

// { orgId, userId?, resourceId?, date? } → matching reservations sorted by date and time.
// Each: { id, org_id, resource_id, user_id, date, start_time, end_time, resourceName, userName }
async function listReservations({ orgId, userId, resourceId, date }) {
  let query = sb.from('reservations').select('*, resources(name), profiles(name)').eq('org_id', orgId);
  if (userId) query = query.eq('user_id', userId);
  if (resourceId) query = query.eq('resource_id', resourceId);
  if (date) query = query.eq('date', date);
  const { data, error } = await query.order('date').order('start_time');
  check(error);
  return data.map(r => ({
    id: r.id, org_id: r.org_id, resource_id: r.resource_id, user_id: r.user_id, date: r.date,
    start_time: hhmm(r.start_time), end_time: hhmm(r.end_time),
    resourceName: r.resources?.name || 'Deleted resource',
    userName: r.profiles?.name || 'Deleted user'
  }));
}

// orgId, userId, resourceId, date, start, end → the new reservation.
// Throws if the time is invalid, outside the resource's hours, in the past, or already taken.
// The database also blocks overlapping reservations, even if two people click at the same moment.
async function reserve(orgId, userId, resourceId, date, start, end) {
  const { data: resource } = await sb.from('resources').select('*').eq('id', resourceId).maybeSingle();
  if (!resource) throw new Error('Choose a resource.');
  const open = hhmm(resource.open_time), close = hhmm(resource.close_time);
  if (resource.status !== 'available') throw new Error(resource.name + ' is unavailable right now.');
  if (!date || !start || !end) throw new Error('Choose a date, start time and end time.');
  if (!(start < end)) throw new Error('End time must be after start time.');
  if (start < open || end > close) throw new Error(`${resource.name} can only be reserved between ${formatTime(open)} and ${formatTime(close)}.`);
  if (date < today() || (date === today() && start < nowTime())) throw new Error('That time has already passed.');

  const { data, error } = await sb.from('reservations')
    .insert({ org_id: orgId, resource_id: resourceId, user_id: userId, date, start_time: start, end_time: end })
    .select().single();
  check(error);
  return data;
}

// reservationId → cancels it
async function cancelReservation(reservationId) {
  const { error } = await sb.from('reservations').delete().eq('id', reservationId);
  check(error);
}
