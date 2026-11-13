// data-supabase.js – the ONLY file that talks to the database.
//
// Adapter between the pages (which think in "date + start_time + end_time",
// one org per user, role 'user'|'admin') and the real schema in /database
// (starts_at/ends_at timestamps, org_members many-to-many, role 'member'|'admin',
// live resource status driven by the RFID readers).
// The HTML pages don't need to change: every function keeps its old name and return shape.
//
// Every HTML page loads these two lines:
//     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
//     <script src="data-supabase.js"></script>

// ---------- settings: Supabase → Project Settings → API ----------
// The publishable key is meant to be public (it ships in the website). RLS protects the data.
// NEVER put the service_role / secret key here.
const SUPABASE_URL = 'https://ciybtljbqogoknnfffmv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_d4fOjaAWNwHum95wAwSI4A_mfLh0XWQ';

// sessionStorage = each browser tab has its own login (handy for showing an admin and a member side by side)
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storage: sessionStorage } });

const ORG_KEY = 'rnc_current_org';         // which org this tab is logged into
const ORG_FIELDS = 'id, name, title, color, logo';

// ---------- small converters ----------
const hhmm = t => (t || '').slice(0, 5);    // Postgres sends "10:00:00", the pages use "10:00"
const pad = n => String(n).padStart(2, '0');

// page role <-> database role
const toDbRole = role => (role === 'admin' ? 'admin' : 'member');
const toPageRole = role => (role === 'admin' ? 'admin' : 'user');

// "2026-11-14" + "10:30" (browser's local time) → ISO timestamp for timestamptz
const toTimestamp = (date, time) => new Date(`${date}T${time}:00`).toISOString();

// ISO timestamp → { date: "YYYY-MM-DD", time: "HH:MM" } in the browser's local time
function fromTimestamp(ts) {
  const d = new Date(ts);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

// Postgres interval text ("01:00:00", "2 hours", "7 days", "1 day 02:00:00") → minutes
function intervalMinutes(text) {
  if (!text) return Infinity;
  let mins = 0;
  const days = /(\d+)\s*day/.exec(text); if (days) mins += +days[1] * 1440;
  const hrs = /(\d+)\s*hour/.exec(text); if (hrs) mins += +hrs[1] * 60;
  const hms = /(\d+):(\d+)(?::(\d+))?/.exec(text); if (hms) mins += +hms[1] * 60 + +hms[2];
  return mins || Infinity;
}

// Database row → the resource shape the pages expect.
// The DB has 4 live states (available / reserved / in_use / maintenance, set by the RFID readers);
// the pages only know "available" vs "unavailable" (= maintenance). live_status keeps the real one.
function toPageResource(r) {
  return {
    ...r,
    status: r.status === 'maintenance' ? 'unavailable' : 'available',
    live_status: r.status,
    open_time: hhmm(r.open_time),
    close_time: hhmm(r.close_time)
  };
}

// Turns a Supabase error into a normal Error with a readable message
function check(error, context) {
  if (!error) return;
  if (error.code === '23P01') throw new Error('Someone has already reserved part of that time.');
  if (error.code === '23505') throw new Error('That already exists.');
  if (error.code === '23514') {
    if (/hours_check/.test(error.message)) throw new Error('"Available until" must be after "Available from".');
    if (/reservations/.test(error.message)) throw new Error('Reservations must be at least 15 minutes long.');
  }
  if (error.code === '42501') {
    if (context === 'reserve') throw new Error("That reservation isn't allowed. It must start in the future, within 30 days, and fit the resource's time limit.");
    if (context === 'cancel') throw new Error('You can only cancel your own reservations before they start.');
    throw new Error("You don't have permission to do that.");
  }
  throw new Error(error.message);   // includes friendly messages raised by our SQL functions
}

// ================= Organizations =================

// → list of organizations [{ id, name, title, color, logo }]  (works before login)
async function getOrgs() {
  const { data, error } = await sb.rpc('org_directory');
  check(error);
  return data;
}

// orgId → one organization, or null  (works before login)
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
    .eq('id', orgId).select(ORG_FIELDS).single();
  check(error);
  return data;
}

// ================= Logging in (Google) =================

// page → sends the browser to Google's sign-in page. When Google is done it comes back to `page`
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
async function getGoogleEmail() {
  const { data } = await sb.auth.getSession();
  return data.session ? (data.session.user.email || '').toLowerCase() : null;
}

// { name, title, color, logo, adminName } → the new organization's id.
// The signed-in Google account becomes its first admin.
async function createOrganization({ name, title, color, logo, adminName }) {
  const { data, error } = await sb.rpc('create_organization', {
    org_name: name, org_title: title, org_color: color, org_logo: logo, admin_name: adminName
  });
  check(error);
  sessionStorage.setItem(ORG_KEY, data);   // so adminDashboard opens the new org
  return data;
}

// Signs out of Google on this tab without leaving the page
async function signOutOnly() {
  sessionStorage.removeItem(ORG_KEY);
  await sb.auth.signOut();
}

// The signed-in person's profile in the shape the pages use, for one org
async function loadUser(authUser, orgId) {
  const { data: membership, error } = await sb.from('org_members')
    .select('role').eq('org_id', orgId).eq('user_id', authUser.id).maybeSingle();
  check(error);
  if (!membership) return null;
  const { data: profile } = await sb.from('profiles').select('id, email, full_name').eq('id', authUser.id).maybeSingle();
  return {
    id: authUser.id,
    org_id: orgId,
    email: (profile?.email || authUser.email || '').toLowerCase(),
    name: profile?.full_name || authUser.user_metadata?.full_name || authUser.email,
    role: toPageRole(membership.role)
  };
}

// orgId, role → called when login.html opens.
// Returns the person's profile if they just signed in with Google and belong to this organization
// with this role, or null if nobody is signed in yet. Throws (and signs out) if they aren't allowed here.
async function finishLogin(orgId, role) {
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  const authUser = data.session.user;
  const email = (authUser.email || '').toLowerCase();
  const user = await loadUser(authUser, orgId);
  if (!user) {
    await signOutOnly();
    throw new Error(`${email} isn't registered with this organization. Ask your admin to add this Google account.`);
  }
  if (user.role !== role) {
    await signOutOnly();
    throw new Error(role === 'admin' ? `${email} is not an admin. Use Member login.` : `${email} is an admin account. Use Admin login.`);
  }
  sessionStorage.setItem(ORG_KEY, orgId);
  return user;
}

// → { user, org } for whoever is logged in on this tab, or null.
// A person can belong to several orgs; we use the one they logged into on this tab.
async function getSession() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  const authUser = data.session.user;

  let orgId = sessionStorage.getItem(ORG_KEY);
  let user = orgId ? await loadUser(authUser, orgId) : null;
  if (!user) {
    const { data: first } = await sb.from('org_members').select('org_id').eq('user_id', authUser.id).limit(1).maybeSingle();
    if (!first) return null;
    orgId = first.org_id;
    user = await loadUser(authUser, orgId);
    sessionStorage.setItem(ORG_KEY, orgId);
  }
  return { user, org: await getOrg(orgId) };
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
  await signOutOnly();
  location.href = 'home.html';
}

// ================= Members (admin) =================

// orgId → everyone in the organization (admins first, then members), sorted by name.
// Each: { id, org_id, name, email, role: 'admin'|'user', pending }
// People who were added but haven't signed in yet show with "(invited)".
async function listUsers(orgId) {
  const [members, invites] = await Promise.all([
    sb.from('org_members').select('role, profiles(id, email, full_name)').eq('org_id', orgId),
    sb.from('org_invites').select('email, full_name, role').eq('org_id', orgId)
  ]);
  check(members.error);
  check(invites.error);

  const people = members.data.map(m => ({
    id: m.profiles.id, org_id: orgId, email: m.profiles.email,
    name: m.profiles.full_name || m.profiles.email, role: toPageRole(m.role), pending: false
  })).concat(invites.data.map(i => ({
    id: 'invite:' + encodeURIComponent(i.email).replace(/'/g, '%27'), org_id: orgId, email: i.email,
    name: (i.full_name || i.email) + ' (invited)', role: toPageRole(i.role), pending: true
  })));

  return people.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'admin' ? -1 : 1));
}

// orgId, name, email, role ('user' or 'admin') → the new person.
// If they've signed in before they're added now; otherwise they're added on their first Google sign-in.
async function addUser(orgId, name, email, role = 'user') {
  email = email.trim().toLowerCase();
  if (!name.trim()) throw new Error('Enter the person\'s name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter their Google email address.');
  const { data, error } = await sb.rpc('add_member', { p_org: orgId, p_email: email, p_name: name.trim(), p_role: toDbRole(role) });
  check(error);
  return { id: data.id, org_id: orgId, name: name.trim(), email, role: role === 'admin' ? 'admin' : 'user', pending: data.status === 'invited' };
}

// userId → removes the member from THIS organization (their Google account and other orgs are untouched)
// and cancels their upcoming reservations here.
async function removeUser(userId) {
  const orgId = sessionStorage.getItem(ORG_KEY);
  if (String(userId).startsWith('invite:')) {
    const email = decodeURIComponent(userId.slice(7));
    const { error } = await sb.from('org_invites').delete().eq('org_id', orgId).eq('email', email);
    check(error);
    return;
  }
  const { error } = await sb.rpc('remove_member', { p_org: orgId, p_user: userId });
  check(error);
}

// ================= Resources =================

// orgId → the organization's rooms and equipment, sorted by name
async function listResources(orgId) {
  const { data, error } = await sb.from('resources').select('*').eq('org_id', orgId).order('name');
  check(error);
  return data.map(toPageResource);
}

// orgId, resource (with id = edit, without id = add) → the saved resource. Throws on bad input.
async function saveResource(orgId, resource) {
  if (!resource.name.trim()) throw new Error('Enter a name.');
  if (!(resource.open_time < resource.close_time)) throw new Error('"Available until" must be after "Available from".');
  const fields = { org_id: orgId, name: resource.name.trim(), type: resource.type, open_time: resource.open_time, close_time: resource.close_time };

  // Only touch status when switching in/out of maintenance. Otherwise saving a room that's
  // checked in (in_use) would wipe the live status the RFID reader set.
  if (resource.status === 'unavailable') fields.status = 'maintenance';

  if (resource.id) {
    if (resource.status === 'available') {
      const { data: current } = await sb.from('resources').select('status').eq('id', resource.id).single();
      if (current?.status === 'maintenance') fields.status = 'available';
    }
    if (resource.type === 'room') fields.tag_uid = null;   // DB rule: only equipment carries a tag
  }

  const { data, error } = resource.id
    ? await sb.from('resources').update(fields).eq('id', resource.id).select().single()
    : await sb.from('resources').insert(fields).select().single();
  check(error);
  return toPageResource(data);
}

// resourceId → removes the resource (its reservations and logs are removed automatically)
async function removeResource(resourceId) {
  const { error } = await sb.from('resources').delete().eq('id', resourceId);
  check(error);
}

// ================= Reservations =================

// { orgId, userId?, resourceId?, date? } → active (not cancelled/finished) reservations sorted by start.
// Each: { id, org_id, resource_id, user_id, date, start_time, end_time, status, resourceName, userName }
async function listReservations({ orgId, userId, resourceId, date }) {
  let query = sb.from('reservations')
    .select('*, resources(name), profiles(full_name, email)')
    .eq('org_id', orgId)
    .in('status', ['reserved', 'checked_in']);
  if (userId) query = query.eq('user_id', userId);
  if (resourceId) query = query.eq('resource_id', resourceId);
  if (date) {
    // everything that overlaps that local calendar day
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    query = query.lt('starts_at', dayEnd.toISOString()).gt('ends_at', dayStart.toISOString());
  }
  const { data, error } = await query.order('starts_at');
  check(error);
  return data.map(r => {
    const s = fromTimestamp(r.starts_at), e = fromTimestamp(r.ends_at);
    return {
      id: r.id, org_id: r.org_id, resource_id: r.resource_id, user_id: r.user_id, status: r.status,
      date: s.date, start_time: s.time, end_time: e.date === s.date ? e.time : '23:59',
      resourceName: r.resources?.name || 'Deleted resource',
      // members can only see their own name (privacy rule in the DB); admins see everyone's
      userName: r.profiles?.full_name || r.profiles?.email || 'Another member'
    };
  });
}

// orgId, userId, resourceId, date, start, end → the new reservation.
// Throws if the time is invalid, outside the resource's hours, in the past, too long, or already taken.
// The database also blocks overlapping reservations, even if two people click at the same moment.
async function reserve(orgId, userId, resourceId, date, start, end) {
  const { data: resource } = await sb.from('resources').select('*').eq('id', resourceId).maybeSingle();
  if (!resource) throw new Error('Choose a resource.');
  const open = hhmm(resource.open_time), close = hhmm(resource.close_time);
  if (resource.status === 'maintenance') throw new Error(resource.name + ' is unavailable right now.');
  if (!date || !start || !end) throw new Error('Choose a date, start time and end time.');
  if (!(start < end)) throw new Error('End time must be after start time.');
  if (start < open || end > close) throw new Error(`${resource.name} can only be reserved between ${formatTime(open)} and ${formatTime(close)}.`);

  const startsAt = new Date(`${date}T${start}:00`), endsAt = new Date(`${date}T${end}:00`);
  const minutes = (endsAt - startsAt) / 60000;
  if (startsAt <= new Date()) throw new Error('That time has already passed.');
  if (startsAt > new Date(Date.now() + 30 * 86400000)) throw new Error('You can only reserve up to 30 days ahead.');
  if (minutes < 15) throw new Error('Reservations must be at least 15 minutes long.');
  const maxMinutes = intervalMinutes(resource.max_hold);
  if (minutes > maxMinutes) {
    const limit = maxMinutes >= 1440 ? `${maxMinutes / 1440} day(s)` : maxMinutes % 60 ? `${maxMinutes} minutes` : `${maxMinutes / 60} hour(s)`;
    throw new Error(`${resource.name} can be reserved for at most ${limit} at a time.`);
  }

  const { data, error } = await sb.from('reservations')
    .insert({ org_id: orgId, resource_id: resourceId, user_id: userId, starts_at: toTimestamp(date, start), ends_at: toTimestamp(date, end) })
    .select().single();
  check(error, 'reserve');
  return data;
}

// reservationId → cancels it (kept in the table as 'cancelled' for the usage history)
async function cancelReservation(reservationId) {
  const { data, error } = await sb.from('reservations').update({ status: 'cancelled' }).eq('id', reservationId).select('id');
  check(error, 'cancel');
  if (!data || !data.length) throw new Error('You can only cancel your own reservations before they start.');
}
