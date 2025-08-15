// server.js
const http = require('http');
const fs    = require('fs');
const url   = require('url');

const PORT = process.env.PORT || 5000;

// In-memory data
const rooms = [
  { id: 1, name: 'Office 1', type: 'office',    priority: 1 },
  { id: 2, name: 'Office 2', type: 'office',    priority: 2 },
  { id: 3, name: 'Office 3', type: 'office',    priority: 3 },
  { id: 4, name: 'Office 4', type: 'office',    priority: 4 },
  { id: 5, name: 'Conference A', type: 'conference', priority: 5 },
  { id: 6, name: 'Conference B', type: 'conference', priority: 6 }
];

let bookings = [];
const adminUsers = [
  { id: 1, email: 'admin@example.com', password: 'admin123', name: 'Administrator' }
];
let nextUserId = 2;
const sessions = {};
const emailTokens = {};

// ---- helpers ----
function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function generateToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sendEmail(to, subject, body) {
  // Demo email sender: just log to console
  console.log('EMAIL ➡️', to, '\nSubject:', subject, '\n', body);
}

function parseJson(body) {
  try { return { ok: true, data: JSON.parse(body) }; }
  catch (e) { return { ok: false, error: e }; }
}

function authenticateAdmin(req) {
  const auth = req.headers['authorization'];
  if (!auth) return null;
  const parts = auth.split(' ');
  const token = parts[1];
  const userId = sessions[token];
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
    return bs < e && be > s;
  });
}

// Auto-book next available (non-conference) desk/office
function autoBook(roomList, startISO, endISO) {
  // sort by priority ascending
  const sorted = roomList.filter(r => r.type !== 'conference')
                         .sort((a,b) => (a.priority || 0) - (b.priority || 0));
  for (const r of sorted) {
    if (!hasConflict(r.id, startISO, endISO)) return r;
  }
  return null;
}

// Determine availability for each room
function availability(date, start_time, end_time) {
  const start = new Date(`${date}T${start_time}`).toISOString();
  const end   = new Date(`${date}T${end_time}`).toISOString();
  return rooms.map(room => ({
    room_id: room.id,
    name: room.name,
    type: room.type,
    available: !hasConflict(room.id, start, end)
  }));
}

// Email with deletion token and reminder
function handleEmailForBooking(booking) {
  const room = rooms.find(r => r.id === booking.room_id);
  const token = generateToken();
  booking.token = token;
  emailTokens[token] = booking.id;

  // confirmation
  sendEmail(booking.email,
            'Booking Confirmation',
            `You booked ${room.name} on ${new Date(booking.start).toLocaleString()}–${new Date(booking.end).toLocaleString()}\n` +
            `To cancel, click: http://localhost:${PORT}/api/bookings/delete?token=${token}`);

  // reminder one day before
  const startDate = new Date(booking.start);
  const msUntilReminder = startDate.getTime() - Date.now() - (24*60*60*1000);
  if (msUntilReminder > 0) {
    setTimeout(() => {
      sendEmail(booking.email,
                'Booking Reminder',
                `Reminder: your booking for ${room.name} is tomorrow (${startDate.toLocaleString()}).`);
    }, msUntilReminder);
  }
}

// ---- server logic ----
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const { pathname, query } = parsed;
  const method = req.method;

  // Static pages
  if (method === 'GET') {
    if (pathname === '/') return serveFile(res, __dirname + '/public/index.html', 'text/html');
    if (pathname === '/admin') return serveFile(res, __dirname + '/public/admin.html', 'text/html');
    if (pathname.startsWith('/public/')) {
      const filePath = __dirname + pathname;
      const ext = filePath.split('.').pop();
      const types = { html:'text/html', css:'text/css', js:'application/javascript' };
      return serveFile(res, filePath, types[ext] || 'text/plain');
    }
  }

  // Public API: rooms
  if (method === 'GET' && pathname === '/api/rooms') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify(rooms));
  }

  // Public API: bookings list with optional filters
  if (method === 'GET' && pathname === '/api/bookings') {
    let list = bookings;
    if (query.date) list = list.filter(b => new Date(b.start).toISOString().slice(0,10) === query.date);
    if (query.room_id) list = list.filter(b => b.room_id === parseInt(query.room_id,10));
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify(list));
  }

  // Public API: create one-off booking
  if (method === 'POST' && pathname === '/api/bookings') {
    let body = ''; req.on('data', c=>body+=c); req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const d = r.data;
      if (!d.room_id || !d.date || !d.start_time || !d.end_time || !d.name || !d.email) {
        res.writeHead(400); return res.end('Missing fields');
      }
      const roomId = parseInt(d.room_id,10);
      const start = new Date(`${d.date}T${d.start_time}`);
      const end   = new Date(`${d.date}T${d.end_time}`);
      if (isNaN(start) || isNaN(end)) { res.writeHead(400); return res.end('Invalid date/time'); }
      if (end <= start) { res.writeHead(400); return res.end('End time must be after start time'); }
      if (hasConflict(roomId, start.toISOString(), end.toISOString())) {
        res.writeHead(409); return res.end('Booking conflict');
      }

      const booking = {
        id: bookings.length+1,
        room_id: roomId,
        start: start.toISOString(),
        end: end.toISOString(),
        name: d.name,
        email: d.email
      };
      bookings.push(booking);
      handleEmailForBooking(booking);
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ success:true, booking }));
    });
    return;
  }

  // Public API: check availability
  if (method === 'GET' && pathname === '/api/availability') {
    const { date, start_time, end_time } = query;
    if (!date || !start_time || !end_time) {
      res.writeHead(400); return res.end('Missing fields');
    }
    const avail = availability(date, start_time, end_time);
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify(avail));
  }

  // Public API: auto-book next available non-conference
  if (method === 'POST' && pathname === '/api/bookings/auto') {
    let body=''; req.on('data', c=>body+=c); req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const { date, start_time, end_time, name, email } = r.data;
      if (!date || !start_time || !end_time || !name || !email) {
        res.writeHead(400); return res.end('Missing fields');
      }
      const start = new Date(`${date}T${start_time}`);
      const end   = new Date(`${date}T${end_time}`);
      if (isNaN(start) || isNaN(end) || end <= start) {
        res.writeHead(400); return res.end('Invalid date/time');
      }
      const chosenRoom = autoBook(rooms, start.toISOString(), end.toISOString());
      if (!chosenRoom) { res.writeHead(409); return res.end('No available desk or office'); }
      const booking = {
        id: bookings.length+1,
        room_id: chosenRoom.id,
        start: start.toISOString(),
        end: end.toISOString(),
        name, email
      };
      bookings.push(booking);
      handleEmailForBooking(booking);
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ success:true, booking }));
    });
    return;
  }

  // Public API: cancel via token (GET or DELETE)
  if ((method === 'GET' || method === 'DELETE') && pathname === '/api/bookings/delete') {
    const token = query.token;
    const bookingId = emailTokens[token];
    if (!token || !bookingId) { res.writeHead(404); return res.end('Invalid token'); }
    const idx = bookings.findIndex(b => b.id === bookingId);
    if (idx === -1) { res.writeHead(404); return res.end('Not found'); }
    const [b] = bookings.splice(idx,1);
    delete emailTokens[token];
    sendEmail(b.email, 'Booking cancelled', `Your booking for room ${b.room_id} on ${new Date(b.start).toLocaleString()} has been cancelled.`);
    res.writeHead(200); return res.end('Cancelled');
  }

  // ---- Admin authentication ----
  if (method === 'POST' && pathname === '/api/admin/login') {
    let body=''; req.on('data', c=>body+=c); req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const { email, password } = r.data;
      const user = adminUsers.find(u => u.email === email && u.password === password);
      if (!user) { res.writeHead(401); return res.end('Invalid credentials'); }
      const token = generateToken();
      sessions[token] = user.id;
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ token }));
    });
    return;
  }

  // ---- Admin endpoints (require token) ----

  // Get bookings with filters
  if (method === 'GET' && pathname === '/api/admin/bookings') {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    let list = bookings;
    if (query.date) list = list.filter(b => new Date(b.start).toISOString().slice(0,10) === query.date);
    if (query.room_id) list = list.filter(b => b.room_id === parseInt(query.room_id,10));
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify(list));
  }

  // Create booking(s) with recurrence
  if (method === 'POST' && pathname === '/api/admin/bookings') {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    let body=''; req.on('data', c=>body+=c); req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const d = r.data;
      if (!d.room_id || !d.date || !d.start_time || !d.end_time || !d.name || !d.email) {
        res.writeHead(400); return res.end('Missing fields');
      }
      const roomId = parseInt(d.room_id, 10);
      const baseStart = new Date(`${d.date}T${d.start_time}`);
      const baseEnd   = new Date(`${d.date}T${d.end_time}`);
      if (isNaN(baseStart) || isNaN(baseEnd) || baseEnd <= baseStart) {
        res.writeHead(400); return res.end('Invalid date/time');
      }
      const freq  = d.frequency || 'none';
      const occ   = parseInt(d.occurrences, 10) || 1;
      const label = d.recurrence_label || '';
      const group = generateToken();

      let newBs = [];
      if (freq === 'none' || occ === 1) {
        const sISO = baseStart.toISOString();
        const eISO = baseEnd.toISOString();
        if (hasConflict(roomId, sISO, eISO)) { res.writeHead(409); return res.end('Booking conflict'); }
        newBs = [{
          id: 0,
          room_id: roomId,
          start: sISO,
          end: eISO,
          name: d.name, email: d.email,
          recurrence_group: null, recurrence_label: ''
        }];
      } else {
        newBs = createRecurring(
          { room_id: roomId, start: baseStart.toISOString(), end: baseEnd.toISOString(), name: d.name, email: d.email },
          freq, occ, group, label
        );
      }

      newBs.forEach(b => {
        b.id = bookings.length + 1;
        bookings.push(b);
        handleEmailForBooking(b);
      });
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ success:true, created:newBs.length, group }));
    });
    return;
  }

  // Edit a booking (PATCH)
  if (method === 'PATCH' && pathname.startsWith('/api/admin/bookings/')) {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    const id = parseInt(pathname.split('/').pop(), 10);
    const idx = bookings.findIndex(b => b.id === id);
    if (idx === -1) { res.writeHead(404); return res.end('Not found'); }
    let body=''; req.on('data', c=>body+=c); req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const upd = r.data;
      const current = bookings[idx];
      let roomId = current.room_id;
      if (upd.room_id) roomId = parseInt(upd.room_id, 10);
      let startISO = current.start;
      let endISO   = current.end;
      const date = upd.date || current.start.slice(0,10);
      const startT = upd.start_time || current.start.slice(11,16);
      const endT   = upd.end_time   || current.end.slice(11,16);
      const s = new Date(`${date}T${startT}`);
      const e = new Date(`${date}T${endT}`);
      if (isNaN(s) || isNaN(e) || e <= s) { res.writeHead(400); return res.end('Invalid date/time'); }
      startISO = s.toISOString(); endISO = e.toISOString();
      if (hasConflict(roomId, startISO, endISO, id)) { res.writeHead(409); return res.end('Booking conflict'); }
      bookings[idx] = {
        ...current,
        room_id: roomId,
        start: startISO,
        end: endISO,
        name: upd.name ?? current.name,
        email: upd.email ?? current.email
      };
      res.writeHead(200); res.end('Updated');
    });
    return;
  }

  // Delete a single booking
  if (method === 'DELETE' && pathname.startsWith('/api/admin/bookings/')) {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    const id = parseInt(pathname.split('/').pop(), 10);
    const idx = bookings.findIndex(b => b.id === id);
    if (idx === -1) { res.writeHead(404); return res.end('Not found'); }
    bookings.splice(idx,1);
    res.writeHead(200); return res.end('Deleted');
  }

  // Delete recurrence group
  if (method === 'DELETE' && pathname.startsWith('/api/admin/recurrence/')) {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    const groupId = pathname.split('/').pop();
    const before = bookings.length;
    bookings = bookings.filter(b => b.recurrence_group !== groupId);
    res.writeHead(200); return res.end(JSON.stringify({ success:true, removed: before - bookings.length }));
  }

  // Admin: rooms list
  if (method === 'GET' && pathname === '/api/admin/rooms') {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify(rooms));
  }

  // Admin: add room
  if (method === 'POST' && pathname === '/api/admin/rooms') {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    let body=''; req.on('data', c=>body+=c); req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const { name, type, priority } = r.data;
      if (!name || !type) { res.writeHead(400); return res.end('Missing fields'); }
      const pr = priority !== undefined ? parseInt(priority,10) : rooms.length+1;
      const newRoom = { id: rooms.length+1, name, type, priority: pr };
      rooms.push(newRoom);
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({ success:true, room:newRoom }));
    });
    return;
  }

  // Admin: update room (name/type/priority)
  if (method === 'PATCH' && pathname.startsWith('/api/admin/rooms/')) {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    const id = parseInt(pathname.split('/').pop(), 10);
    const idx = rooms.findIndex(r => r.id === id);
    if (idx === -1) { res.writeHead(404); return res.end('Not found'); }
    let body=''; req.on('data', c=>body+=c); req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const { name, type, priority } = r.data;
      if (name) rooms[idx].name = name;
      if (type) rooms[idx].type = type;
      if (priority !== undefined) rooms[idx].priority = parseInt(priority,10);
      res.writeHead(200); res.end('Updated');
    });
    return;
  }

  // Admin: user list
  if (method === 'GET' && pathname === '/api/admin/users') {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    const safe = adminUsers.map(u => ({ id:u.id, email:u.email, name:u.name }));
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify(safe));
  }

  // Admin: add user
  if (method === 'POST' && pathname === '/api/admin/users') {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    let body=''; req.on('data', c=>body+=c); req.on('end', () => {
      const r = parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const { name, email, password } = r.data;
      if (!name || !email || !password) { res.writeHead(400); return res.end('Missing fields'); }
      if (adminUsers.some(u => u.email === email)) { res.writeHead(409); return res.end('Email exists'); }
      const user = { id: nextUserId++, name, email, password };
      adminUsers.push(user);
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({ success:true, id:user.id }));
    });
    return;
  }

  // Admin: update user
  if (method === 'PATCH' && pathname.startsWith('/api/admin/users/')) {
    if (!authenticateAdmin(req)) { res.writeHead(401); return res.end('Unauthorized'); }
    const id = parseInt(pathname.split('/').pop(),10);
    const idx = adminUsers.findIndex(u => u.id===id);
    if (idx===-1) { res.writeHead(404); return res.end('Not found'); }
    let body=''; req.on('data', c=>body+=c); req.on('end', () => {
      const r=parseJson(body);
      if (!r.ok) { res.writeHead(400); return res.end('Invalid JSON'); }
      const { name, email, password } = r.data;
      if (email && adminUsers.some(u => u.email===email && u.id!==id)) {
        res.writeHead(409); return res.end('Email exists');
      }
      if (name) adminUsers[idx].name = name;
      if (email) adminUsers[idx].email= email;
      if (password) adminUsers[idx].password = password;
      res.writeHead(200); return res.end('Updated');
    });
    return;
  }

  // Default fallback
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
