const http = require('http');
const fs = require('fs');
const url = require('url');

// Port the server will listen on
const PORT = 5000;

// In-memory list of rooms and bookings
const rooms = [
  { id: 1, name: 'Office 1', type: 'office' },
  { id: 2, name: 'Office 2', type: 'office' },
  { id: 3, name: 'Office 3', type: 'office' },
  { id: 4, name: 'Office 4', type: 'office' },
  { id: 5, name: 'Conference A', type: 'conference' },
  { id: 6, name: 'Conference B', type: 'conference' }
];

let bookings = [];

/**
 * Serves a static file from the public directory.
 *
 * @param {http.ServerResponse} res 
 * @param {string} filePath
 * @param {string} contentType
 */
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

/**
 * Checks if a proposed booking overlaps any existing booking for the same room.
 * @param {Object} newBooking
 * @returns {boolean}
 */
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

  // Serve the main page
  if (req.method === 'GET' && parsed.pathname === '/') {
    return serveFile(res, __dirname + '/public/index.html', 'text/html');
  }

  // Endpoint to get rooms
  if (req.method === 'GET' && parsed.pathname === '/api/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rooms));
    return;
  }

  // Endpoint to get all bookings
  if (req.method === 'GET' && parsed.pathname === '/api/bookings') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(bookings));
    return;
  }

  // Endpoint to create a booking
  if (req.method === 'POST' && parsed.pathname === '/api/bookings') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        // Basic validation
        if (!data.room_id || !data.start || !data.end) {
          res.writeHead(400);
          res.end('Missing fields');
          return;
        }
        const newBooking = {
          id: bookings.length + 1,
          room_id: data.room_id,
          start: data.start,
          end: data.end
        };
        if (hasConflict(newBooking)) {
          res.writeHead(409);
          res.end('Booking conflict');
          return;
        }
        bookings.push(newBooking);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

  // Serve any other file under /public
  if (req.method === 'GET' && parsed.pathname.startsWith('/public/')) {
    const filePath = __dirname + parsed.pathname;
    const ext = filePath.split('.').pop();
    let type = 'text/plain';
    if (ext === 'js') type = 'application/javascript';
    if (ext === 'css') type = 'text/css';
    if (ext === 'html') type = 'text/html';
    return serveFile(res, filePath, type);
  }
  // Not found fallback
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  
});
