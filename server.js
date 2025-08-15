// server.js
const http = require('http');
const fs = require('fs');
const url = require('url');

// Use cloud port if provided, otherwise 5000
const PORT = process.env.PORT || 5000;

/*
 * In-memory data stores
 * (For production you’d use a database. This is a simple, file-free MVP.)
 */
const rooms = [
  { id: 1, name: 'Office 1', type: 'office' },
  { id: 2, name: 'Office 2', type: 'office' },
  { id: 3, name: 'Office 3', type: 'office' },
  { id: 4, name: 'Office 4', type: 'office' },
  { id: 5, name: 'Conference A', type: 'conference' },
  { id: 6, name: 'Conference B', type: 'conference' }
];

// Each booking: { id, room_id, start, end, name, email, recurrence_group?, recurrence_label? }
let bookings = [];

// Admin users + sessions (seed a default admin)
const adminUsers = [
  { id: 1, email: 'admin@example.com', password: 'admin123', name: 'Administrator' }
];
let nextUserId = 2;
const sessions = {}; // token -> userId

/* ---------- helpers ---------- */
function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); }
    else { res.writeHead(200, { 'Content-Type': contentType }); res.end(data); }
  });
}
function generateToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function parseJson(body) {
  try { return { ok: true, data: JSON.parse(body) }; }
  catch (e) { return { ok: false, error: e }; }
}
function authenticateAdmin(req) {
  const auth = req.headers['authorization'];
  if (!auth) return null;
  const parts = auth.split(' ');
  if (parts.length !== 2) return null;
  const token = parts[1];
  const userId = sessions[token];
  if (!userId) return null;
  return adminUsers.find(u => u.id === userId) || null;
}
function hasConflict(roomId, startISO, endISO, ignoreId = null) {
  const s = new Date(startISO).getTime();
  const e = new Date(endISO).getTime();
  return bookings.some(b => {
    if (ignoreId && b.id === ignoreId) return false;
    if (b.room_id !== roomId) return false;
    const bs = new Date(b.start).getTime();
    const be = new Date(b.end).getTime();
    return bs < e && be > s; // overlap
  });
}
function createRecurring(base, frequency, occurrences, recurrenceGroup, recurrenceLabel) {
  const out = [];
  let s = new Date(base.start);
  let e = new Date(base.end);
  for (let i = 0; i < occurrences; i++) {
    const start = s.toISOString();
    const end = e.toISOString();
    if (!hasConflict(base.room_id, start, end)) {
      out.push({
        id: 0, // will fill when pushing
        room_id: base.room_id,
        start, end,
        name: base.name, email: base.email,
        recurrence_group: recurrenceGroup,
        recurrence_label: recurrenceLabel
      });
    }
    if (frequency === 'daily') { s.setDate(s.getDate() + 1); e.setDate(e.getDate() + 1); }
    else if (frequency === 'weekly') { s.setDate(s.getDate() + 7); e.setDate(e.getDate() + 7); }
    else if (frequency === 'monthly') { s.setMonth(s.getMonth() + 1); e.setMonth(e.getMonth() + 1); }
  }
  return out;
}

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const { pathname, query } = parsed;
  const method = req.method;

  // Pages
  if (method === 'GET') {
    if (pathname === '/')   return serveFile(res, __dirname + '/public/index.html', 'text/html');
    if (pathname === '/admin') return serveFile(res, __dirname + '/public/admin.html', 'text/html');
    if (pathname.startsWith('/public/')) {
      const filePath = __dirname + pathname;
      const ext = filePath.split('.').pop();
      const types = { html: 'text/html', js: 'application/javascript', css: 'text/css' };
      return serveFile(res, filePath, types[ext] || 'text/plain');
    }
  }

  /* --------- Public API --------- */

  // Rooms
  if (method === 'GET' && pathname === '/api/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(rooms));
  }

  // Bookings with filters (date, room_id)
  if (method === 'GET' && pathname === '/api/bookings') {
    let list = bookings;
    if (query.date) {
      list = list.filter(b => new Date(b.start).toISOString().slice(0,10) === query.date);
    }
    if (query.room_id) {
      const r = parseInt(query.room_id, 10);
      list = list.filter(b => b.room_id === r);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }

  // Create a (non-admin) booking
  if (method === 'POST' && pathname === '/api/bookings') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const d = r.data;
      if (!d.room_id || !d.date || !d.start_time || !d.end_time || !d.name || !d.email) {
        res.writeHead(400); return res.end('Missing fields');
      }
      const roomId = parseInt(d.room_id, 10);
      const start = new Date(`${d.date}T${d.start_time}`);
      const end = new Date(`${d.date}T${d.end_time}`);
      if (isNaN(start) || isNaN(end)) { res.writeHead(400); return res.end('Invalid date/time'); }
      if (end <= start) { res.writeHead(400); return res.end('End time must be after start time'); }
      if (hasConflict(roomId, start.toISOString(), end.toISOString())) {
        res.writeHead(409); return res.end('Booking conflict');
      }
      const booking = {
        id: bookings.length + 1,
        room_id: roomId,
        start: start.toISOString(),
        end: end.toISOString(),
        name: d.name,
        email: d.email
      };
      bookings.push(booking);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  /* --------- Admin auth --------- */

  if (method === 'POST' && pathname === '/api/admin/login') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const { email, password } = r.data;
      const user = adminUsers.find(u => u.email === email && u.password === password);
      if (!user) { res.writeHead(401); return res.end('Invalid credentials'); }
      const token = generateToken();
      sessions[token] = user.id;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token }));
    });
    return;
  }

  /* --------- Admin: Bookings --------- */

  // Get bookings (with filters)
  if (method === 'GET' && pathname === '/api/admin/bookings') {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    let list = bookings;
    if (query.date) list = list.filter(b => new Date(b.start).toISOString().slice(0,10) === query.date);
    if (query.room_id) {
      const r = parseInt(query.room_id, 10);
      list = list.filter(b => b.room_id === r);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }

  // Create booking(s) — supports recurrence
  if (method === 'POST' && pathname === '/api/admin/bookings') {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const d = r.data;
      if (!d.room_id || !d.date || !d.start_time || !d.end_time || !d.name || !d.email) {
        res.writeHead(400); return res.end('Missing fields');
      }
      const roomId = parseInt(d.room_id, 10);
      const baseStart = new Date(`${d.date}T${d.start_time}`);
      const baseEnd = new Date(`${d.date}T${d.end_time}`);
      if (isNaN(baseStart) || isNaN(baseEnd)) { res.writeHead(400); return res.end('Invalid date/time'); }
      if (baseEnd <= baseStart) { res.writeHead(400); return res.end('End time must be after start time'); }

      const freq = d.frequency || 'none';              // none | daily | weekly | monthly
      const occ = parseInt(d.occurrences, 10) || 1;    // how many
      const recurrenceGroup = Math.random().toString(36).slice(2);
      const recurrenceLabel = d.recurrence_label || (freq !== 'none' ? `${freq} x${occ}` : '');

      let created = [];
      if (freq === 'none' || occ === 1) {
        const s = baseStart.toISOString();
        const e = baseEnd.toISOString();
        if (hasConflict(roomId, s, e)) { res.writeHead(409); return res.end('Booking conflict'); }
        created = [{
          id: 0, room_id: roomId, start: s, end: e,
          name: d.name, email: d.email,
          recurrence_group: undefined, recurrence_label: ''
        }];
      } else {
        created = createRecurring(
          { room_id: roomId, start: baseStart.toISOString(), end: baseEnd.toISOString(), name: d.name, email: d.email },
          freq, occ, recurrenceGroup, recurrenceLabel
        );
      }

      created.forEach(b => { b.id = bookings.length + 1; bookings.push(b); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, created: created.length, recurrence_group: recurrenceGroup }));
    });
    return;
  }

  // Edit ONE booking
  if (method === 'PATCH' && pathname.startsWith('/api/admin/bookings/')) {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    const id = parseInt(pathname.split('/').pop(), 10);
    const idx = bookings.findIndex(b => b.id === id);
    if (idx === -1) { res.writeHead(404); return res.end('Not found'); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const d = r.data;
      const old = bookings[idx];
      const roomId = d.room_id ? parseInt(d.room_id, 10) : old.room_id;

      // If dates are provided, recompute start/end
      let startISO = old.start;
      let endISO = old.end;
      if (d.date || d.start_time || d.end_time) {
        const date = d.date || old.start.slice(0,10);
        const startT = d.start_time || new Date(old.start).toISOString().slice(11,16);
        const endT   = d.end_time   || new Date(old.end).toISOString().slice(11,16);
        const s = new Date(`${date}T${startT}`);
        const e = new Date(`${date}T${endT}`);
        if (isNaN(s) || isNaN(e)) { res.writeHead(400); return res.end('Invalid date/time'); }
        if (e <= s) { res.writeHead(400); return res.end('End time must be after start time'); }
        startISO = s.toISOString();
        endISO = e.toISOString();
      }

      // Check conflict (ignore the booking itself)
      if (hasConflict(roomId, startISO, endISO, id)) { res.writeHead(409); return res.end('Booking conflict'); }

      // Apply updates
      bookings[idx] = {
        ...old,
        room_id: roomId,
        start: startISO,
        end: endISO,
        name: d.name ?? old.name,
        email: d.email ?? old.email
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, booking: bookings[idx] }));
    });
    return;
  }

  // Delete ONE booking
  if (method === 'DELETE' && pathname.startsWith('/api/admin/bookings/')) {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    const id = parseInt(pathname.split('/').pop(), 10);
    const idx = bookings.findIndex(b => b.id === id);
    if (idx === -1) { res.writeHead(404); return res.end('Not found'); }
    bookings.splice(idx, 1);
    res.writeHead(200); return res.end('Deleted');
  }

  // Delete a WHOLE recurrence series
  if (method === 'DELETE' && pathname.startsWith('/api/admin/recurrence/')) {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    const groupId = pathname.split('/').pop();
    const before = bookings.length;
    bookings = bookings.filter(b => b.recurrence_group !== groupId);
    const removed = before - bookings.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, removed }));
  }

  /* --------- Admin: Rooms --------- */

  if (method === 'GET' && pathname === '/api/admin/rooms') {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(rooms));
  }

  if (method === 'POST' && pathname === '/api/admin/rooms') {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const d = r.data;
      if (!d.name || !d.type) { res.writeHead(400); return res.end('Missing fields'); }
      const newRoom = { id: rooms.length + 1, name: d.name, type: d.type };
      rooms.push(newRoom);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, room: newRoom }));
    });
    return;
  }

  if (method === 'PATCH' && pathname.startsWith('/api/admin/rooms/')) {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    const id = parseInt(pathname.split('/').pop(), 10);
    const idx = rooms.findIndex(r => r.id === id);
    if (idx === -1) { res.writeHead(404); return res.end('Not found'); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const d = r.data;
      rooms[idx] = { ...rooms[idx], ...d };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, room: rooms[idx] }));
    });
    return;
  }

  /* --------- Admin: Users --------- */

  if (method === 'GET' && pathname === '/api/admin/users') {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    const sanitized = adminUsers.map(u => ({ id: u.id, email: u.email, name: u.name }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(sanitized));
  }

  if (method === 'POST' && pathname === '/api/admin/users') {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const d = r.data;
      if (!d.email || !d.password || !d.name) { res.writeHead(400); return res.end('Missing fields'); }
      if (adminUsers.some(u => u.email === d.email)) { res.writeHead(409); return res.end('Email already exists'); }
      const user = { id: nextUserId++, email: d.email, password: d.password, name: d.name };
      adminUsers.push(user);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, user: { id: user.id, email: user.email, name: user.name } }));
    });
    return;
  }

  if (method === 'PATCH' && pathname.startsWith('/api/admin/users/')) {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    const id = parseInt(pathname.split('/').pop(), 10);
    const idx = adminUsers.findIndex(u => u.id === id);
    if (idx === -1) { res.writeHead(404); return res.end('Not found'); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const d = r.data;
      if (d.email && adminUsers.some(u => u.email === d.email && u.id !== id)) {
        res.writeHead(409); return res.end('Email already exists');
      }
      adminUsers[idx] = { ...adminUsers[idx], ...d };
      const { password, ...safe } = adminUsers[idx];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, user: safe }));
    });
    return;
  }

  // Fallback
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
