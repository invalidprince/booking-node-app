const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

/*
 * Simple office booking application
 *
 * This Express server exposes a minimal API for managing office, desk and
 * conference room bookings. It keeps all data in memory (for demonstration
 * purposes) and implements basic CRUD endpoints for spaces, bookings and
 * admin users. It also supports an "auto booking" feature that picks the
 * next available space of a particular type (desk or office) based on a
 * configurable priority order. When bookings are created or cancelled an
 * email‑like notification is logged to the console to demonstrate where
 * you could integrate your own mail provider.
 *
 * Additionally this version re‑introduces support for recurring bookings.
 * Recurring bookings are stored as part of the bookings collection with
 * a `recurring` object describing the recurrence rule. Currently only
 * monthly recurrences are supported and two patterns are recognised:
 *   1. A specific day of the month (e.g. the 1st of every month).
 *   2. The Nth occurrence of a weekday in a month (e.g. the 3rd Friday).
 * These recurring bookings are considered when checking space availability.
 */

const app = express();
const PORT = process.env.PORT || 5050;

// Base URL used in emails for links. Should be set via the environment when deployed
const APP_BASE_URL = process.env.APP_BASE_URL || '';

// Initialise an email transporter if SMTP environment variables are provided.
// If not provided, sendEmail will fall back to console logging.
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: (process.env.SMTP_SECURE === 'true'),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

// ----- Data persistence configuration -----
// Path to the JSON file used to persist data across restarts.
const DATA_FILE = path.join(__dirname, 'data.json');

/**
 * Load persisted spaces, bookings and admins from disk. If the file does not
 * exist or cannot be parsed, the in-memory defaults remain unchanged.
 */
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.spaces)) {
      spaces.splice(0, spaces.length, ...data.spaces);
    }
    if (Array.isArray(data.bookings)) {
      bookings.splice(0, bookings.length, ...data.bookings);
    }
    if (Array.isArray(data.admins)) {
      admins.splice(0, admins.length, ...data.admins);
    }
  } catch (err) {
    // File not found or invalid JSON; will be created on first save
    // console.warn('No data file found or parse error:', err);
  }
}

/**
 * Persist the current spaces, bookings and admins to disk. Tokens are not
 * persisted because they are only valid for the lifetime of the process.
 */
function saveData() {
  const out = {
    spaces,
    bookings,
    admins
  };
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2));
  } catch (err) {
    console.error('Failed to save data:', err);
  }
}

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// ----- In‑memory data stores ------------------------------------------------

// Spaces represent the physical locations that can be booked. Each space has a
// unique identifier, a type (office, desk or conference) and a numeric
// priorityOrder used for the auto‑booking algorithm (lower numbers have
// higher priority).
const spaces = [
  { id: uuidv4(), name: 'Office 1', type: 'office', priorityOrder: 1 },
  { id: uuidv4(), name: 'Office 2', type: 'office', priorityOrder: 2 },
  { id: uuidv4(), name: 'Desk 1', type: 'desk', priorityOrder: 1 },
  { id: uuidv4(), name: 'Desk 2', type: 'desk', priorityOrder: 2 },
  { id: uuidv4(), name: 'Conference Room 1', type: 'conference', priorityOrder: 1 },
  { id: uuidv4(), name: 'Conference Room 2', type: 'conference', priorityOrder: 2 }
];

// Bookings store reservations made by end users. Each booking has
//   id, name, email, spaceId, date (YYYY‑MM‑DD) for one‑off bookings,
//   startTime and endTime in 24h format (HH:MM), and optional recurring
//   object describing a recurrence pattern. See comments above for supported
//   recurrence patterns.
const bookings = [];

// Admin accounts used to access the admin portal. Passwords are in plain text
// purely for demonstration purposes. In a real application you should never
// store passwords in plain text.
const admins = [
  { id: uuidv4(), username: 'admin@example.com', password: 'admin123' }
];

// Logged‑in admin tokens map token -> adminId
const tokens = {};

// Load persisted data from disk (if any). This will overwrite the default
// values defined above if a data file exists.
loadData();

// ----- Helper functions ------------------------------------------------------

function sendEmail(to, subject, text) {
  // If a transporter and from address are configured, attempt to send a real email
  if (mailTransporter && process.env.MAIL_FROM) {
    mailTransporter.sendMail({
      from: process.env.MAIL_FROM,
      to,
      subject,
      text
    }).catch(err => {
      console.error('Email send error:', err);
    });
  } else {
    // Fallback to console logging so that notifications are visible during development
    console.log('\n--- EMAIL NOTIFICATION ---');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(text);
    console.log('--------------------------\n');
  }
}

/**
 * Determine whether a recurring rule applies on a particular date.
 *
 * @param {string} dateStr ISO date string (YYYY‑MM‑DD)
 * @param {object|boolean} recurring The recurring object or false
 * @returns {boolean} True if the recurrence matches the provided date
 */
function isRecurringOnDate(dateStr, recurring) {
  if (!recurring || typeof recurring !== 'object') return false;
  const d = new Date(dateStr);
  // Normalise to midnight in the local timezone
  // Weekly recurrence: occurs on the same weekday each week
  if (recurring.frequency === 'weekly' && recurring.weekday !== undefined && recurring.weekday !== null) {
    return d.getDay() === Number(recurring.weekday);
  }
  if (recurring.dayOfMonth !== undefined && recurring.dayOfMonth !== null) {
    return d.getDate() === Number(recurring.dayOfMonth);
  } else if (
    recurring.nth !== undefined && recurring.weekday !== undefined &&
    recurring.nth !== null && recurring.weekday !== null
  ) {
    const weekday = d.getDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday
    if (weekday !== Number(recurring.weekday)) return false;
    // Determine the occurrence of this weekday in the month (1st, 2nd, etc.)
    let count = 0;
    for (let i = 1; i <= d.getDate(); i++) {
      const dt = new Date(d.getFullYear(), d.getMonth(), i);
      if (dt.getDay() === weekday) count++;
    }
    return count === Number(recurring.nth);
  }
  return false;
}

/**
 * Check whether a space is available for a given date and time range.
 *
 * A space is considered unavailable if any existing booking (regular or
 * recurring) for that space overlaps the requested time on the requested
 * date.
 *
 * @param {string} spaceId ID of the space being checked
 * @param {string} date ISO date string (YYYY‑MM‑DD)
 * @param {string} startTime start time in 24h format (HH:MM)
 * @param {string} endTime end time in 24h format (HH:MM)
 */
function isSpaceAvailable(spaceId, date, startTime, endTime) {
  return !bookings.some(b => {
    if (b.spaceId !== spaceId) return false;
    // Determine if this booking occurs on the requested date
    const occursOnDate = b.date === date || isRecurringOnDate(date, b.recurring);
    if (!occursOnDate) return false;
    // Check for time overlap (inclusive start, exclusive end)
    const overlaps =
      (startTime >= b.startTime && startTime < b.endTime) ||
      (endTime > b.startTime && endTime <= b.endTime) ||
      (startTime <= b.startTime && endTime >= b.endTime);
    return overlaps;
  });
}

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  if (!tokens[token]) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.adminId = tokens[token];
  next();
}

// ----- API routes -----------------------------------------------------------

// Admin login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const admin = admins.find(a => a.username === username && a.password === password);
  if (!admin) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = uuidv4();
  tokens[token] = admin.id;
  res.json({ token });
});

// Spaces endpoints
app.get('/api/spaces', (req, res) => {
  res.json(spaces);
});

app.post('/api/spaces', adminAuth, (req, res) => {
  const { name, type, priorityOrder } = req.body;
  if (!name || !type || priorityOrder === undefined) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const id = uuidv4();
  spaces.push({ id, name, type, priorityOrder: Number(priorityOrder) });
  // Persist changes
  saveData();
  res.json({ id });
});

app.delete('/api/spaces/:id', adminAuth, (req, res) => {
  const { id } = req.params;
  const index = spaces.findIndex(r => r.id === id);
  if (index >= 0) {
    spaces.splice(index, 1);
    saveData();
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Space not found' });
  }
});

// Bookings endpoints
app.get('/api/bookings', adminAuth, (req, res) => {
  const result = bookings.map(b => {
    const space = spaces.find(s => s.id === b.spaceId);
    return {
      id: b.id,
      name: b.name,
      email: b.email,
      spaceId: b.spaceId,
      spaceName: space ? space.name : '',
      date: b.date,
      startTime: b.startTime,
      endTime: b.endTime,
      recurring: !!b.recurring
    };
  });
  res.json(result);
});

/**
 * Create a new booking. The body must include name, email, spaceId,
 * date (for one‑off bookings and as the first occurrence for recurring
 * bookings), startTime and endTime. The `recurring` field may be
 * either false (or omitted) or an object describing the recurrence.
 * Supported recurrence object keys:
 *   - dayOfMonth: integer (1‑31) to repeat on that day of each month
 *   - nth: integer (1‑5) and weekday: integer (0‑6) representing the
 *     nth occurrence of weekday in the month.
 */
app.post('/api/bookings', (req, res) => {
  const { name, email, spaceId, date, startTime, endTime, recurring } = req.body;
  if (!name || !email || !spaceId || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  // Enforce company email domain (trim and normalise case)
  const emailNormalized = String(email).trim().toLowerCase();
  if (!emailNormalized.endsWith('@fbhi.net')) {
    return res.status(400).json({ error: 'Email must be a @fbhi.net address' });
  }
  if (String(spaceId).startsWith('auto-')) {
    return res.status(400).json({ error: 'Use /api/bookings/auto for auto-booking' });
  }
  const space = spaces.find(s => s.id === spaceId);
  if (!space) {
    return res.status(404).json({ error: 'Space not found' });
  }
  // Check availability for the first occurrence of a recurring booking or single booking
  const rec = recurring && typeof recurring === 'object' ? recurring : false;
  // If recurring, the provided date is the first occurrence. We still need
  // to ensure that date/time is free.
  if (!isSpaceAvailable(spaceId, date, startTime, endTime)) {
    return res.status(400).json({ error: 'Space is not available for the requested time' });
  }
  const id = uuidv4();
  bookings.push({ id, name, email: emailNormalized, spaceId, date, startTime, endTime, recurring: rec });
  // Persist changes
  saveData();
  // Build a cancellation link. If APP_BASE_URL is set, use it; otherwise omit the URL.
  let cancelLink = '';
  if (APP_BASE_URL) {
    cancelLink = `${APP_BASE_URL}/cancel/${id}`;
  }
  const confirmationMessage =
    `Your booking for ${space.name}${rec ? ' (recurring)' : ''} on ${date} from ${startTime} to ${endTime} has been confirmed.` +
    (cancelLink ? `\n\nIf you need to cancel this booking, please click the following link: ${cancelLink}` : '');
  sendEmail(
    emailNormalized,
    'Booking Confirmation',
    confirmationMessage
  );
  res.json({ id });
});

// Cancel a booking by ID (admin only)
app.delete('/api/bookings/:id', adminAuth, (req, res) => {
  const { id } = req.params;
  const index = bookings.findIndex(b => b.id === id);
  if (index >= 0) {
    const [removed] = bookings.splice(index, 1);
    const space = spaces.find(s => s.id === removed.spaceId);
    sendEmail(
      removed.email,
      'Booking Cancelled',
      `Your booking for ${space ? space.name : 'a space'} on ${removed.date} from ${removed.startTime} to ${removed.endTime} has been cancelled.`
    );
    // Persist changes
    saveData();
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Booking not found' });
  }
});

// Public cancellation link. Allows a user to cancel their own booking via a unique URL.
// When accessed, this removes the booking from the system, sends a cancellation email
// and returns a simple HTML response indicating the result.
app.get('/cancel/:id', (req, res) => {
  const { id } = req.params;
  const index = bookings.findIndex(b => b.id === id);
  if (index >= 0) {
    const [removed] = bookings.splice(index, 1);
    saveData();
    const space = spaces.find(s => s.id === removed.spaceId);
    // Send cancellation email to the user
    const cancelMsg = `Your booking for ${space ? space.name : 'a space'} on ${removed.date} from ${removed.startTime} to ${removed.endTime} has been cancelled.`;
    sendEmail(removed.email, 'Booking Cancelled', cancelMsg);
    res.send(
      '<html><head><title>Booking Cancelled</title></head><body>' +
      '<h1>Booking Cancelled</h1>' +
      '<p>Your booking has been cancelled successfully.</p>' +
      '</body></html>'
    );
  } else {
    res.status(404).send(
      '<html><head><title>Booking Not Found</title></head><body>' +
      '<h1>Booking Not Found</h1>' +
      '<p>The booking you are trying to cancel does not exist.</p>' +
      '</body></html>'
    );
  }
});

// Availability: returns spaces that are free for a given date/time range.
// Query parameters:
//   date: YYYY‑MM‑DD (required)
//   start: HH:MM 24h (required)
//   end: HH:MM 24h (required)
//   type: optional space type filter (desk, office, conference)
app.get('/api/availability', (req, res) => {
  const { date, start: startTime, end: endTime, type } = req.query;
  if (!date || !startTime || !endTime) {
    return res.status(400).json({ error: 'Missing date or time parameters' });
  }
  let available = spaces.filter(s => {
    if (type && s.type !== type) return false;
    return isSpaceAvailable(s.id, date, startTime, endTime);
  });
  res.json(available);
});

// Auto-book: automatically assign the next available space of a given type.
app.get('/api/bookings/auto', (req, res) => {
  const { type, date, start: startTime, end: endTime, name, email } = req.query;
  if (!type || !date || !startTime || !endTime || !name || !email) {
    return res.status(400).json({ error: 'Missing parameters for auto-booking' });
  }
  // Enforce company email domain for auto bookings (trim and normalise case)
  const emailNormalized = String(email).trim().toLowerCase();
  if (!emailNormalized.endsWith('@fbhi.net')) {
    return res.status(400).json({ error: 'Email must be a @fbhi.net address' });
  }
  const candidates = spaces
    .filter(s => s.type === type)
    .sort((a, b) => a.priorityOrder - b.priorityOrder);
  for (const space of candidates) {
    if (isSpaceAvailable(space.id, date, startTime, endTime)) {
      const id = uuidv4();
      bookings.push({ id, name, email: emailNormalized, spaceId: space.id, date, startTime, endTime, recurring: false });
      // Persist immediately so that cancellation link works even if the process restarts
      saveData();
      // Construct cancellation link
      let cancelLink = '';
      if (APP_BASE_URL) {
        cancelLink = `${APP_BASE_URL}/cancel/${id}`;
      }
      const confirmationMessage =
        `Your booking for ${space.name} on ${date} from ${startTime} to ${endTime} has been confirmed.` +
        (cancelLink ? `\n\nIf you need to cancel this booking, please click the following link: ${cancelLink}` : '');
      sendEmail(
        emailNormalized,
        'Booking Confirmation',
        confirmationMessage
      );
      return res.json({ id, spaceName: space.name });
    }
  }
  res.status(404).json({ error: 'No spaces available for the requested time' });
});

// Admin user management
app.get('/api/admins', adminAuth, (req, res) => {
  res.json(admins.map(a => ({ id: a.id, username: a.username })));
});

app.post('/api/admins', adminAuth, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username or password' });
  }
  if (admins.find(a => a.username === username)) {
    return res.status(400).json({ error: 'Admin already exists' });
  }
  const id = uuidv4();
  admins.push({ id, username, password });
  saveData();
  res.json({ id });
});

app.delete('/api/admins/:id', adminAuth, (req, res) => {
  const { id } = req.params;
  const index = admins.findIndex(a => a.id === id);
  if (index >= 0) {
    admins.splice(index, 1);
    saveData();
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Admin not found' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Booking app listening at http://localhost:${PORT}`);
});