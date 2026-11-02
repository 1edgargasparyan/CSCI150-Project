const DB_KEY = 'reservehub-demo';
const SESSION_KEY = 'reservehub-user';

// ---------- demo data ----------
function makeDemoData() {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowText = tomorrow.getFullYear() + '-' + String(tomorrow.getMonth() + 1).padStart(2, '0') + '-' + String(tomorrow.getDate()).padStart(2, '0');
    const hour = new Date().getHours();
    const pad = n => String(n).padStart(2, '0');
    return {
        orgs: [
        { id: 'org1', name: 'Riverside Library', title: 'Riverside Library Reservations', color: '#2563eb', logo: '' },
        { id: 'org2', name: 'Northgate Makerspace', title: 'Northgate Makerspace', color: '#0f766e', logo: '' }
        ],
        users: [
        { id: 'u1', org_id: 'org1', name: 'Library Admin', username: 'admin', password: 'admin123', role: 'admin' },
        { id: 'u2', org_id: 'org1', name: 'Jordan Doe', username: 'jdoe', password: 'password', role: 'user' },
        { id: 'u3', org_id: 'org1', name: 'Alex Smith', username: 'asmith', password: 'password', role: 'user' },
        { id: 'u4', org_id: 'org2', name: 'Makerspace Admin', username: 'admin', password: 'admin123', role: 'admin' },
        { id: 'u5', org_id: 'org2', name: 'Morgan Lee', username: 'mlee', password: 'password', role: 'user' }
        ],
        resources: [
        { id: 'r1', org_id: 'org1', name: 'Study Room A', type: 'room', open_time: '08:00', close_time: '20:00', status: 'available' },
        { id: 'r2', org_id: 'org1', name: 'Conference Room B', type: 'room', open_time: '09:00', close_time: '17:00', status: 'available' },
        { id: 'r3', org_id: 'org1', name: 'Laptop #1', type: 'equipment', open_time: '00:00', close_time: '23:59', status: 'available' },
        { id: 'r4', org_id: 'org1', name: 'Projector', type: 'equipment', open_time: '09:00', close_time: '17:00', status: 'unavailable' },
        { id: 'r5', org_id: 'org2', name: 'Wood Shop', type: 'room', open_time: '10:00', close_time: '22:00', status: 'available' },
        { id: 'r6', org_id: 'org2', name: 'Laser Cutter', type: 'equipment', open_time: '10:00', close_time: '21:00', status: 'available' }
        ],
        reservations: [
        { id: 'b1', org_id: 'org1', resource_id: 'r1', user_id: 'u2', date: tomorrowText, start_time: '10:00', end_time: '11:00' },
        // Alex has the laptop right now, so "In use" and the current holder show up in the demo
        { id: 'b2', org_id: 'org1', resource_id: 'r3', user_id: 'u3', date: today(), start_time: pad(Math.max(hour - 1, 0)) + ':00', end_time: pad(Math.min(hour + 1, 23)) + ':59' }
        ]
    };
}

function loadDb() {
    let db = null;
    try { db = JSON.parse(localStorage.getItem(DB_KEY)); } catch (e) { db = null; }
    if (!db) { db = makeDemoData(); saveDb(db); }
    return db;
}
function saveDb(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
function newId() { return Math.random().toString(36).slice(2, 10); }

// Demo only: put the demo data back the way it started
async function resetDemo() {
    localStorage.removeItem(DB_KEY);
    sessionStorage.removeItem(SESSION_KEY);
}

// ================= Organizations =================

// → list of organizations [{ id, name, title, color, logo }]
async function getOrgs() {
    return loadDb().orgs;
}

// orgId → one organization, or null
async function getOrg(orgId) {
    return loadDb().orgs.find(o => o.id === orgId) || null;
}

// orgId, { title, color, logo } → the updated organization
async function saveBranding(orgId, branding) {
    const db = loadDb();
    const org = db.orgs.find(o => o.id === orgId);
    Object.assign(org, branding);
    saveDb(db);
    return org;
}

// ================= Logging in =================

// orgId, username, password, role ('admin' or 'user') → the user. Throws if the login is wrong.
async function login(orgId, username, password, role) {
    const user = loadDb().users.find(u => u.org_id === orgId && u.username === username.trim().toLowerCase());
    if (!user || user.password !== password) throw new Error('Wrong username or password.');
    if (user.role !== role) throw new Error(role === 'admin' ? 'This is not an admin account.' : 'Admins sign in with the admin login.');
    sessionStorage.setItem(SESSION_KEY, user.id);
    return user;
}

// → { user, org } for whoever is logged in on this tab, or null
async function getSession() {
    const db = loadDb();
    const user = db.users.find(u => u.id === sessionStorage.getItem(SESSION_KEY));
    if (!user) return null;
    return { user, org: db.orgs.find(o => o.id === user.org_id) };
}

// role → { user, org }. Sends the visitor back to the start page if they aren't allowed here.
async function requireLogin(role) {
    const session = await getSession();
    if (!session || session.user.role !== role) {
        location.href = 'home.html';
        return new Promise(() => {}); // stop the page while it leaves
    }
    return session;
}

// Logs out and returns to the start page
async function logout() {
    sessionStorage.removeItem(SESSION_KEY);
    location.href = 'home.html';
}

// ================= Members (admin) =================

// orgId → the organization's members (not admins), sorted by name
async function listUsers(orgId) {
    return loadDb().users.filter(u => u.org_id === orgId && u.role === 'user').sort((a, b) => a.name.localeCompare(b.name));
}

// orgId, name, username, password → the new member. Throws if something is missing or the username is taken.
async function addUser(orgId, name, username, password) {
    const db = loadDb();
    username = username.trim().toLowerCase();
    if (!name.trim()) throw new Error('Enter the member\'s name.');
    if (!/^[a-z0-9._]{3,32}$/.test(username)) throw new Error('Username must be 3–32 letters, numbers, dots or underscores.');
    if (password.length < 6) throw new Error('Password must be at least 6 characters.');
    if (db.users.some(u => u.org_id === orgId && u.username === username)) throw new Error('That username is already taken.');
    const user = { id: newId(), org_id: orgId, name: name.trim(), username, password, role: 'user' };
    db.users.push(user);
    saveDb(db);
    return user;
}

// userId → removes the member and their reservations
async function removeUser(userId) {
    const db = loadDb();
    db.users = db.users.filter(u => u.id !== userId);
    db.reservations = db.reservations.filter(r => r.user_id !== userId);
    saveDb(db);
}

// ================= Resources =================

// orgId → the organization's rooms and equipment, sorted by name
// Each: { id, org_id, name, type: 'room'|'equipment', open_time: 'HH:MM', close_time: 'HH:MM', status: 'available'|'unavailable' }
async function listResources(orgId) {
    return loadDb().resources.filter(r => r.org_id === orgId).sort((a, b) => a.name.localeCompare(b.name));
}

// orgId, resource (with id = edit, without id = add) → the saved resource. Throws on bad input.
async function saveResource(orgId, resource) {
    if (!resource.name.trim()) throw new Error('Enter a name.');
    if (!(resource.open_time < resource.close_time)) throw new Error('"Available until" must be after "Available from".');
    const db = loadDb();
    const fields = { name: resource.name.trim(), type: resource.type, open_time: resource.open_time, close_time: resource.close_time, status: resource.status };
    let saved;
    if (resource.id) {
        saved = db.resources.find(r => r.id === resource.id);
        Object.assign(saved, fields);
    } else {
        saved = { id: newId(), org_id: orgId, ...fields };
        db.resources.push(saved);
    }
    saveDb(db);
    return saved;
}

// resourceId → removes the resource and its reservations
async function removeResource(resourceId) {
    const db = loadDb();
    db.resources = db.resources.filter(r => r.id !== resourceId);
    db.reservations = db.reservations.filter(r => r.resource_id !== resourceId);
    saveDb(db);
}

// ================= Reservations =================

// { orgId, userId?, resourceId?, date? } → matching reservations sorted by date and time.
// Each: { id, org_id, resource_id, user_id, date, start_time, end_time, resourceName, userName }
async function listReservations({ orgId, userId, resourceId, date }) {
    const db = loadDb();
    return db.reservations
        .filter(r => r.org_id === orgId && (!userId || r.user_id === userId) && (!resourceId || r.resource_id === resourceId) && (!date || r.date === date))
        .sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time))
        .map(r => ({
        ...r,
        resourceName: db.resources.find(x => x.id === r.resource_id)?.name || 'Deleted resource',
        userName: db.users.find(u => u.id === r.user_id)?.name || 'Deleted user'
        }));
}

// orgId, userId, resourceId, date, start, end → the new reservation.
// Throws if the time is invalid, outside the resource's hours, in the past, or already taken.
async function reserve(orgId, userId, resourceId, date, start, end) {
    const db = loadDb();
    const resource = db.resources.find(r => r.id === resourceId && r.org_id === orgId);
    if (!resource) throw new Error('Choose a resource.');
    if (resource.status !== 'available') throw new Error(resource.name + ' is unavailable right now.');
    if (!date || !start || !end) throw new Error('Choose a date, start time and end time.');
    if (!(start < end)) throw new Error('End time must be after start time.');
    if (start < resource.open_time || end > resource.close_time) throw new Error(`${resource.name} can only be reserved between ${formatTime(resource.open_time)} and ${formatTime(resource.close_time)}.`);
    if (date < today() || (date === today() && start < nowTime())) throw new Error('That time has already passed.');
    const clash = db.reservations.some(r => r.resource_id === resourceId && r.date === date && r.start_time < end && start < r.end_time);
    if (clash) throw new Error('Someone has already reserved part of that time.');
    const reservation = { id: newId(), org_id: orgId, resource_id: resourceId, user_id: userId, date, start_time: start, end_time: end };
    db.reservations.push(reservation);
    saveDb(db);
    return reservation;
}

// reservationId → cancels it
async function cancelReservation(reservationId) {
    const db = loadDb();
    db.reservations = db.reservations.filter(r => r.id !== reservationId);
    saveDb(db);
}
