// ui.js – small helpers used by every page.
// No database code lives here, so this file stays the same for the demo and Supabase versions.

// Makes text safe to put inside HTML (stops names like "<b>" from breaking the page)
function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Today's date as "YYYY-MM-DD"
function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// The current time as "HH:MM"
function nowTime() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// "2026-10-31" → "Sat, Oct 31"
function formatDate(dateText) {
    const [y, m, d] = dateText.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// "14:30" → "2:30 PM"
function formatTime(timeText) {
    let [h, m] = timeText.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

// true if a reservation hasn't finished yet
function isUpcoming(r) {
    return r.date > today() || (r.date === today() && r.end_time > nowTime());
    }

// true if a reservation is happening right now
function isNow(r) {
    return r.date === today() && r.start_time <= nowTime() && nowTime() < r.end_time;
}


// What a resource is doing right now → { text, cssClass, holder }
function resourceStatus(resource, reservations) {
    if (resource.status === 'unavailable') return { text: 'Unavailable', cssClass: 'unavailable', holder: '' };
    const current = reservations.find(r => r.resource_id === resource.id && isNow(r));
    if (current) return { text: 'In use until ' + formatTime(current.end_time), cssClass: 'in-use', holder: current.userName };
    return { text: 'Available', cssClass: 'available', holder: '' };
}

// Colors the page with the organization's brand color
function applyBranding(org) {
    document.documentElement.style.setProperty('--color', org.color || '#2563eb');
}

// Fills the <header> with the logo, title, page links and a Log out button
function showHeader(session, currentPage) {
    const { user, org } = session;
    applyBranding(org);
    const links = user.role === 'admin'
        ? [['adminDashboard.html', 'Dashboard'], ['adminResources.html', 'Resources']]
        : [['userDashboard.html', 'Home'], ['userReserve.html', 'Reserve']];
    document.querySelector('header').innerHTML = `
        ${org.logo ? `<img src="${esc(org.logo)}" alt="logo">` : ''}
        <span class="title">${esc(org.title || org.name)}</span>
        ${links.map(([page, label]) => `<a href="${page}" class="${page === currentPage ? 'current' : ''}">${label}</a>`).join('')}
        <span>${esc(user.name)}</span>
        <button class="secondary small" onclick="logout()">Log out</button>`;
}

// Shows a message under a form. isError = true makes it red, otherwise green.
function showMessage(elementId, text, isError) {
    const el = document.getElementById(elementId);
    el.textContent = text;
    el.className = 'msg ' + (isError ? 'error' : 'ok');
}
