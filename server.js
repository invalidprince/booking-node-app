const http = require('http');
const fs = require('fs');
const url = require('url');

// Use an environment-specified port when available (e.g. on Render)
const PORT = process.env.PORT || 5000;

// In-memory list of rooms; adjust this list to add or remove spaces
const rooms = [
  { id: 1, name: 'Office 1', type: 'office' },
  { id: 2, name: 'Office 2', type: 'office' },
  { id: 3, name: 'Office 3', type: 'office' },
  { id: 4, name: 'Office 4', type: 'office' },
  { id: 5, name: 'Conference A', type: 'conference' },
  { id: 6, name: 'Conference B', type: 'conference' }
];

// In-memory bookings array. Each booking holds room, start/end ISO timestamps, name, and email.
let bookings = [];

/** Serve a static file from /public */
function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
}

/** Check for conflicting bookings (same room with overlapping times) */
function hasConflict(newBooking) {
  const start = new Date(newBooking.start).getTime();
  const end = new Date(newBooking.end).getTime();
  return bookings.some(b => {
    if (b.room_id !== newBooking.room_id) return false;
    const existingStart = new Date(b.start).getTime();
    const existingEnd = new Date(b.end).getTime();
    return existingEnd > start && existingStart < end;
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // Main page
  if (req.method === 'GET' && parsed.pathname === '/') {
    return serveFile(res, __dirname + '/public/index.html', 'text/html');
  }

  // Rooms list
  if (req.method === 'GET' && parsed.pathname === '/api/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(rooms));
  }

  // All bookings
  if (req.method === 'GET' && parsed.pathname === '/api/bookings') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(bookings));
  }

  // Create a booking
  if (req.method === 'POST' && parsed.pathname === '/api/bookings') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);

        // Required fields
        if (!data.room_id || !data.date || !data.start_time ||
            !data.end_time || !data.name || !data.email) {
          res.writeHead(400);
          return res.end('Missing fields');
        }

        const startDateTime = new Date(`${data.date}T${data.start_time}`);
        const endDateTime   = new Date(`${data.date}T${data.end_time}`);

        if (isNaN(startDateTime) || isNaN(endDateTime)) {
          res.writeHead(400);
          return res.end('Invalid date or time');
        }
        if (endDateTime <= startDateTime) {
          res.writeHead(400);
          return res.end('End time must be after start time');
        }

        const newBooking = {
          id: bookings.length + 1,
          room_id: data.room_id,
          start: startDateTime.toISOString(),
          end: endDateTime.toISOString(),
          name: data.name,
          email: data.email
        };

        if (hasConflict(newBooking)) {
          res.writeHead(409);
          return res.end('Booking conflict');
        }

        bookings.push(newBooking);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400);
        return res.end('Invalid JSON');
      }
    });
    return;
  }

  // Static files under /public
  if (req.method === 'GET' && parsed.pathname.startsWith('/public/')) {
    const filePath = __dirname + parsed.pathname;
    const ext = filePath.split('.').pop();
    const types = { js: 'application/javascript', css: 'text/css', html: 'text/html' };
    return serveFile(res, filePath, types[ext] || 'text/plain');
  }

  // Default 404
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
