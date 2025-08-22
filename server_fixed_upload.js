const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
// Conditionally import pg.  When running locally without the pg package
// installed we catch the error and leave Pool undefined.  The database
// functionality is only used when DATABASE_URL is provided and pg is
// available.  This allows the application to run in environments without
// network access (e.g. during development/testing) and still use the
// JSON-based persistence.
let Pool;
try {
  ({ Pool } = require('pg'));
} catch (_) {
  Pool = null;
}

// -----------------------------------------------------------------------------
// Configuration constants
//
// Limit the maximum duration of any single (non‑recurring) booking.  This helps
// prevent accidental day‑long reservations that block the system for other
// users.  You can adjust this value as needed.  The value is expressed in
// hours.
const MAX_BOOKING_HOURS = 12;

// Data directory can be overridden via environment variables.  By default
// persistence uses the application directory.  When deploying on Render with
// a mounted disk, set DATA_DIR (and optionally BACKUP_DIR) to the mount
// location (e.g. /data) to ensure persistence across deploys.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
// Directory where backups of the data file will be written.  Each time data
// is saved, a timestamped copy of the JSON payload will be stored here.  The
// directory will be created on demand if it does not exist.  Only a small
// number of recent backups are retained to avoid unbounded growth.  You can
// adjust BACKUP_RETENTION to keep more or fewer backups.  Use BACKUP_DIR
// environment variable to override the default.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const BACKUP_RETENTION = 10;

// -----------------------------------------------------------------------------
// Database configuration
//
// When a DATABASE_URL environment variable is provided the application will
// persist all state into an external Postgres database.  This allows data to
// survive across deployments and can be shared between multiple running
// instances.  If no DATABASE_URL is defined the application will fall back to
// the original JSON based persistence on the local filesystem.

const DATABASE_URL = process.env.DATABASE_URL || null;

// A pg Pool instance used when DATABASE_URL is defined.  Created on demand in
// initDb().  When DATABASE_URL is not set this remains null and all database
// operations are skipped.
let db = null;

/**
 * Initialise the Postgres database.  When DATABASE_URL is defined this
 * function will create a connection pool and ensure all required tables exist.
 * The schema is deliberately simple and mirrors the in‑memory arrays used by
 * the application.  If no DATABASE_URL is provided this function resolves
 * immediately without performing any actions.
 */
async function initDb() {
  // Bail out if no DATABASE_URL or the pg module is not available.  This
  // preserves the original file‑based persistence when pg is missing or no
  // connection string is provided.
  if (!DATABASE_URL || !Pool) {
    return;
  }
  // Attempt to connect to the external database.  If the connection fails
  // (e.g. network unreachable or authentication error) fall back to the
  // JSON‑based persistence by setting `db` to null.  The `pg` module will
  // automatically resolve DNS and may prefer IPv6.  Provide an SSL option
  // with a relaxed certificate check for hosted providers like Supabase.
  try {
    db = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    // Probe the connection to verify the host is reachable.  A simple
    // SELECT eliminates silent failures when the pool is lazily initialised.
    await db.query('SELECT 1');
  } catch (err) {
    console.error('Failed to connect to database; falling back to file‑based storage:', err);
    db = null;
    return;
  }
  // Create tables if they do not already exist.  Use JSONB for the
  // recurring column to store arbitrary recurrence objects.  Note that the
  // bookings table includes optional checkInTime, checkOutTime and
  // cancelled fields added in later iterations of the app.
  const createStatements = [
    `CREATE TABLE IF NOT EXISTS spaces (
      id UUID PRIMARY KEY,
      name TEXT,
      type TEXT,
      "priorityOrder" INTEGER
    );`,
    `CREATE TABLE IF NOT EXISTS bookings (
      id UUID PRIMARY KEY,
      name TEXT,
      email TEXT,
      "spaceId" UUID,
      date TEXT,
      "startTime" TEXT,
      "endTime" TEXT,
      recurring JSONB,
      "checkInTime" TEXT,
      "checkOutTime" TEXT,
      cancelled BOOLEAN
    );`,
    `CREATE TABLE IF NOT EXISTS admins (
      id UUID PRIMARY KEY,
      username TEXT UNIQUE,
      "passwordHash" TEXT,
      salt TEXT,
      role TEXT
    );`,
    `CREATE TABLE IF NOT EXISTS "verifiedEmails" (
      email TEXT PRIMARY KEY
    );`,
    `CREATE TABLE IF NOT EXISTS "kioskTokens" (
      id UUID PRIMARY KEY,
      code TEXT
    );`
  ];
  for (const stmt of createStatements) {
    await db.query(stmt);
  }
}

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
// If not provided, sendEmail will fall back to console logging.  Support both
// legacy SMTP_SECURE (boolean string) and the more descriptive
// SMTP_ENCRYPTION (e.g. "STARTTLS", "TLS", "SSL").  When
// SMTP_ENCRYPTION=STARTTLS, use a non‑secure connection and let Nodemailer
// upgrade via STARTTLS.  For SSL/TLS we enable `secure`.

let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const enc = String(process.env.SMTP_ENCRYPTION || '').toLowerCase();
  let secure;
  if (enc === 'ssl' || enc === 'tls') {
    secure = true;
  } else if (enc === 'starttls') {
    secure = false;
  } else if (typeof process.env.SMTP_SECURE !== 'undefined') {
    secure = (process.env.SMTP_SECURE === 'true');
  } else {
    secure = false; // default to STARTTLS
  }
  const port = Number(process.env.SMTP_PORT || 587);
  const enableDebug = String(process.env.SMTP_DEBUG || '').toLowerCase() === 'true';

  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    logger: enableDebug,
    debug: enableDebug,
    tls: secure ? undefined : { ciphers: 'TLSv1.2' } // STARTTLS-friendly
  });

  if (typeof mailTransporter.verify === 'function') {
    mailTransporter.verify(function(err, success) {
      if (err) {
        console.error('SMTP transport verification failed:', err && (err.stack || err.message || err));
      } else {
        const encMode = enc || (secure ? 'tls' : 'starttls');
        console.log(`SMTP transport ready: ${process.env.SMTP_HOST}:${port} secure=${encMode}`);
      }
    });
  }
}


/**
 * Persist the current spaces, bookings and admins to disk. Tokens are not
 * persisted because they are only valid for the lifetime of the process.
 */
async function saveData() {
  const out = {
    spaces,
    bookings,
    admins,
    verifiedEmails,
    kioskTokens
  };
  // Persist to JSON file regardless of DB presence.  This provides a local
  // backup and maintains compatibility with environments that do not use
  // Postgres.  Failures here are logged but do not prevent execution.
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2));
    createBackup(out);
  } catch (err) {
    console.error('Failed to save data to JSON file:', err);
  }
  // Persist to database if configured.  Use a transaction to ensure that
  // deletes and inserts succeed together.  On failure the transaction is
  // rolled back leaving the previous data intact.  Because this function may
  // be invoked frequently we perform simple wholesale deletes followed by
  // inserts; this is acceptable given the small scale of the application.
  if (db) {
    try {
      await db.query('BEGIN');
      // Clear all tables
      await db.query('DELETE FROM spaces');
      await db.query('DELETE FROM bookings');
      await db.query('DELETE FROM admins');
      await db.query('DELETE FROM "verifiedEmails"');
      await db.query('DELETE FROM "kioskTokens"');
      // Insert spaces
      for (const s of spaces) {
        await db.query('INSERT INTO spaces (id, name, type, "priorityOrder") VALUES ($1, $2, $3, $4)', [s.id, s.name, s.type, s.priorityOrder]);
      }
      // Insert bookings
      for (const b of bookings) {
        await db.query(
          'INSERT INTO bookings (id, name, email, "spaceId", date, "startTime", "endTime", recurring, "checkInTime", "checkOutTime", cancelled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [
            b.id,
            b.name,
            b.email,
            b.spaceId,
            b.date,
            b.startTime,
            b.endTime,
            b.recurring && typeof b.recurring === 'object' ? b.recurring : null,
            b.checkInTime || null,
            b.checkOutTime || null,
            b.cancelled || false
          ]
        );
      }
      // Insert admins
      for (const a of admins) {
        await db.query(
          'INSERT INTO admins (id, username, "passwordHash", salt, role) VALUES ($1,$2,$3,$4,$5)',
          [a.id, a.username, a.passwordHash || a.password, a.salt || null, a.role]
        );
      }
      // Insert verified emails
      for (const email of verifiedEmails) {
        await db.query('INSERT INTO "verifiedEmails" (email) VALUES ($1)', [email]);
      }
      // Insert kiosk tokens
      for (const kt of kioskTokens) {
        await db.query('INSERT INTO "kioskTokens" (id, code) VALUES ($1, $2)', [kt.id, kt.code]);
      }
      await db.query('COMMIT');
    } catch (err) {
      console.error('Failed to save data to database:', err);
      try {
        await db.query('ROLLBACK');
      } catch (_) {}
    }
  }
}

/**
 * Write a timestamped backup of the current data payload.  The backup file
 * name includes the current date and time down to seconds.  Only the most
 * recent BACKUP_RETENTION backups are kept on disk; older backups are
 * automatically removed.
 *
 * @param {object} payload The data object to serialise and back up
 */
function createBackup(payload) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `data-${stamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(payload, null, 2));
    // Enforce retention: remove older backups beyond the retention limit
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('data-') && f.endsWith('.json'))
      .sort();
    // Keep only the newest BACKUP_RETENTION files
    while (files.length > BACKUP_RETENTION) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)); } catch (_) {}
    }
  } catch (err) {
    console.error('Failed to create backup:', err);
  }
}

// Middleware
app.use(cors());
app.use(bodyParser.json());
// Restrict access to kiosk page: if no active kiosk session cookie is present,
// redirect to the setup page where the device can claim a token. Kiosk
// sessions are identified by the `kioskToken` cookie. See
// `/api/kiosk/claim` and `/public/kiosk-setup.html` for more details.
app.get('/kiosk.html', (req, res, next) => {
  if (!isKioskSession(req)) {
    return res.redirect('/kiosk-setup.html');
  }
  next();
});

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

// Admin accounts used to access the admin portal.  The first admin is
// designated as the owner and uses a hashed password.  Additional admins
// created via the API will also store hashed credentials.  Note: legacy
// installations that store plain passwords will continue to work but new
// passwords are always hashed.
const initialAdminPassword = 'admin123';
const _initCred = hashPassword(initialAdminPassword);
const admins = [
  {
    id: uuidv4(),
    username: 'admin@example.com',
    passwordHash: _initCred.hash,
    salt: _initCred.salt,
    role: 'owner'
  }
];

// Logged‑in admin tokens map token -> adminId
const tokens = {};

// Verified end‑user email addresses. Only these addresses are allowed to make
// bookings. This list is persisted across restarts. The corresponding
// verificationTokens map token strings to email addresses pending
// verification. verificationTokens are not persisted and are cleared on
// restart.
const verifiedEmails = [];
const verificationTokens = {};
const kioskTokens = [];
const kioskSessions = {};

// Kiosk token management declarations moved to the top of the file. See the
// Kiosk access configuration section for definitions of kioskTokens and
// kioskSessions.

// Note: data is loaded asynchronously in the server bootstrapping routine

// ----- Helper functions ------------------------------------------------------

// ---------------------------------------------------------------------------
// Security helpers
//
// Define the available admin roles.  Owners have full privileges, admins can
// perform most actions except managing other admins, analysts can view
// analytics but not modify data, and frontdesk users have limited booking
// capabilities (e.g. check-in).  You can adjust this list as needed.
const ROLES = ['owner', 'admin', 'analyst', 'frontdesk'];

/**
 * Hash a plain text password using PBKDF2 with a random salt.  Returns an
 * object containing the salt and derived key in hexadecimal format.  Using
 * PBKDF2 avoids the need to install external dependencies like bcrypt.
 *
 * @param {string} password The plain text password
 * @returns {{ salt: string, hash: string }}
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

/**
 * Verify a plain text password against a stored admin record.  If the admin
 * has both a passwordHash and salt, PBKDF2 is used for comparison.  If
 * passwordHash is missing, falls back to comparing plain password fields
 * (legacy support).  Returns true if the password matches.
 *
 * @param {string} password The plain text password
 * @param {object} admin Admin record with either passwordHash/salt or password
 * @returns {boolean}
 */
function verifyPassword(password, admin) {
  if (!admin) return false;
  if (admin.passwordHash && admin.salt) {
    const hash = crypto.pbkdf2Sync(password, admin.salt, 100000, 64, 'sha512').toString('hex');
    return hash === admin.passwordHash;
  }
  // Legacy plain text fallback
  return admin.password === password;
}

/**
 * Send an email via nodemailer if configured, otherwise log the message to
 * the console.  Supports optional attachments, which are passed directly
 * through to nodemailer.  When attachments are present but no SMTP
 * transporter is configured, a note is logged indicating that an attachment
 * would have been sent.
 *
 * @param {string} to Recipient email address
 * @param {string} subject Email subject line
 * @param {string} text Plain‑text body of the email
 * @param {Array<object>} [attachments] Optional array of attachment objects
 */
/**
 * Send an email using the configured SMTP transporter.  This helper is
 * implemented as an async function so callers may optionally await the
 * completion of the send.  When attachments are provided they will be
 * passed directly to nodemailer.  If no mail transporter is configured
 * the email is logged to the console instead.  Any errors during
 * transmission are surfaced via a rejected promise.  To preserve
 * backwards compatibility with the previous implementation this function
 * attempts a fallback send without attachments when the initial send
 * fails.
 *
 * @param {string} to Recipient email address
 * @param {string} subject Email subject line
 * @param {string} text Plain‑text body of the email
 * @param {Array<object>} [attachments] Optional array of attachment objects
 * @returns {Promise<void>}
 */
async function sendEmail(to, subject, text, attachments = []) {
  const headerFrom = process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER;
  const envelopeFrom = process.env.SMTP_USER || process.env.SMTP_FROM || process.env.MAIL_FROM;
  if (mailTransporter && headerFrom) {
    const mailOptions = {
      from: headerFrom,
      to,
      subject,
      text,
      attachments: attachments && attachments.length ? attachments : undefined,
      envelope: { from: envelopeFrom, to }
    };
    try { await mailTransporter.sendMail(mailOptions); }
    catch (err) { console.error('Email send error:', err); }
  } else {
    console.log('Email Sent');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(text);
    if (attachments && attachments.length) {
      attachments.forEach(att => {
        const size = att.content ? att.content.length : 0;
        console.log(`[Attachment: ${att.filename || 'file'} (${size} bytes)]`);
      });
      console.log('Note: Attachments would have been sent if SMTP were configured.');
    }
    console.log('Email Sent');
  }
}

/**
 * Send a booking confirmation email.  This helper centralises the logic for
 * constructing and sending a booking confirmation.  It accepts all the
 * necessary booking details and a cancel link, builds a simple plain‑text
 * message and delegates to sendEmail().  Any errors during send are
 * reported to the console with a descriptive context.
 *
 * @param {string} name     Name of the user who made the booking
 * @param {string} email    Normalised recipient email address
 * @param {string} space    Human friendly name of the booked space
 * @param {string} date     Booking date (YYYY‑MM‑DD)
 * @param {string} start    Start time (HH:MM)
 * @param {string} end      End time (HH:MM)
 * @param {string} cancelLink A full URL that allows the user to cancel the booking
 * @param {string} [context] Optional context label for error messages
 */
async function sendBookingConfirmationEmail(name, email, space, date, start, end, cancelLink, context = '') {
  const emailText =
    `Hello ${name},\n\n` +
    `Your booking has been confirmed!\n\n` +
    `Space: ${space}\n` +
    `Date: ${date}\n` +
    `Start Time: ${start}\n` +
    `End Time: ${end}\n\n` +
    `If you need to cancel your booking, please click the link below:\n` +
    `${cancelLink}\n\n` +
    `Thank you.`;
  try {
    await sendEmail(email, 'Booking Confirmation', emailText);
  } catch (err) {
    const label = context ? ` (${context})` : '';
    console.error('Error sending booking confirmation' + label, err);
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
 * Convert a 24‑hour time string (HH:MM) to a 12‑hour format with AM/PM.
 *
 * If the input is invalid or not a string in HH:MM format, it is returned unchanged.
 * Examples:
 *   to12Hour('13:30') -> '1:30 PM'
 *   to12Hour('00:15') -> '12:15 AM'
 *
 * @param {string} time Time in 24‑hour format
 * @returns {string} Time in 12‑hour format
 */
function to12Hour(time) {
  if (typeof time !== 'string' || !time.includes(':')) return time;
  const [hStr, m] = time.split(':');
  let h = parseInt(hStr, 10);
  if (isNaN(h)) return time;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
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

/**
 * For recurring bookings, check that the requested time slot is available for
 * each occurrence within the next 12 months.  If any future occurrence
 * conflicts with an existing booking (regular or recurring), the booking
 * cannot be created.  For weekly recurrences the check runs until the end
 * of the 52nd week from the first date.  Monthly patterns are checked
 * through the same horizon.
 *
 * @param {string} spaceId ID of the space
 * @param {string} firstDate ISO date string of the first occurrence (YYYY‑MM‑DD)
 * @param {string} startTime 24h time string HH:MM
 * @param {string} endTime 24h time string HH:MM
 * @param {object} recurring Recurrence object
 * @returns {boolean} True if all occurrences are free
 */
function checkRecurringAvailability(spaceId, firstDate, startTime, endTime, recurring) {
  // Only check for recurring patterns
  if (!recurring || typeof recurring !== 'object') return true;
  const startDateObj = new Date(firstDate);
  if (isNaN(startDateObj.getTime())) return true;
  // We'll iterate day by day for up to one year ahead
  const horizonDate = new Date(startDateObj);
  horizonDate.setFullYear(horizonDate.getFullYear() + 1);
  const current = new Date(startDateObj);
  // Skip the first occurrence; it is already validated by caller
  current.setDate(current.getDate() + 1);
  while (current <= horizonDate) {
    const dateStr = current.toISOString().slice(0, 10);
    // only consider dates on or after the first date
    if (isRecurringOnDate(dateStr, recurring)) {
      if (!isSpaceAvailable(spaceId, dateStr, startTime, endTime)) {
        return false;
      }
    }
    current.setDate(current.getDate() + 1);
  }
  return true;
}

/**
 * Generate a basic iCalendar event for a booking.  This function creates
 * a minimal VCalendar with a single VEvent describing the booking start and
 * end times.  The event UID is derived from the booking id to ensure
 * uniqueness.  Optionally a cancellation can be generated by passing
 * cancelled=true and method="CANCEL"; in this case the VEvent includes
 * STATUS:CANCELLED.  Times are encoded in local time without a timezone
 * suffix (floating time).  Clients will interpret the times in their own
 * timezone.
 *
 * @param {object} booking The booking object
 * @param {string} spaceName Name of the space booked
 * @param {string} method iCalendar method (REQUEST or CANCEL)
 * @param {boolean} cancelled Whether the event should include a cancelled status
 * @returns {string} iCalendar formatted string
*/

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  const adminId = tokens[token];
  if (!adminId) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.adminId = adminId;
  const admin = admins.find(a => a.id === adminId);
  req.admin = admin;
  // Assign a normalized role.  Some older deployments used a "super" or
  // "superadmin" role name which was not recognised by the access control
  // checks throughout the server (e.g. analytics and kiosk endpoints
  // explicitly check for 'owner', 'admin' or 'analyst').  When an admin has
  // one of these legacy roles we treat them as an owner.  Otherwise fall
  // back to the stored role or 'admin' by default.
  let role = admin && admin.role ? admin.role : 'admin';
  if (role && typeof role === 'string') {
    const r = role.toLowerCase();
    if (r === 'super' || r === 'superadmin') role = 'owner';
    else role = role; // leave unchanged
  }
  req.adminRole = role;
  next();
}

// ----- API routes -----------------------------------------------------------
// Admin login endpoint
app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing username or password' });
    }
    const uname = String(username).toLowerCase();
    const admin = admins.find(a => a.username && a.username.toLowerCase() === uname);
    if (!admin || !verifyPassword(password, admin)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = uuidv4();
    tokens[token] = admin.id;
    return res.json({ token, role: admin.role || 'admin' });
  } catch (e) {
    console.error('Login error', e);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// Spaces endpoints
app.get('/api/spaces', (req, res) => {
  res.json(spaces);
});

app.post('/api/spaces', adminAuth, (req, res) => {
  // Only owners and admins can add spaces
  if (!['owner', 'admin'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
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
  // Only owners and admins can delete spaces
  if (!['owner', 'admin'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
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
  // Only owners and admins can list all bookings
  if (!['owner','superadmin','admin'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
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
      recurring: !!b.recurring,
      recurrence: b.recurring || null,
      checkedIn: !!b.checkedIn
    };
  });

  // Optional filters & pagination
  const hasQueryControls = (
    typeof req.query.upcoming !== 'undefined' ||
    typeof req.query.from !== 'undefined' ||
    typeof req.query.sort !== 'undefined' ||
    typeof req.query.limit !== 'undefined' ||
    typeof req.query.offset !== 'undefined' ||
    typeof req.query.page !== 'undefined' ||
    typeof req.query.pageSize !== 'undefined'
  );

  if (!hasQueryControls) {
    // Back-compat: return the full array exactly as before
    return res.json(result);
  }

  // Parse query params
  const q = req.query;
  const sortDir = (q.sort || 'asc').toString().toLowerCase() === 'desc' ? 'desc' : 'asc';
  let items = result.slice();

  // Apply "upcoming" filter (from now onwards)
  if (typeof q.upcoming !== 'undefined') {
    const now = new Date();
    const todayStr = now.toISOString().slice(0,10);
    const hh = String(now.getHours()).padStart(2,'0');
    const mm = String(now.getMinutes()).padStart(2,'0');
    const cur = `${hh}:${mm}`;
    items = items.filter(b => {
      if (b.date > todayStr) return true;
      if (b.date === todayStr && (b.endTime || '00:00') >= cur) return true;
      // If a booking is recurring but started in the past, it's ambiguous whether to include;
      // keep it out by default to avoid flooding the list with base patterns.
      return false;
    });
  }

  // Apply "from" filter if provided, expects YYYY-MM-DD
  if (q.from) {
    const fromStr = q.from.toString();
    items = items.filter(b => b.date >= fromStr);
  }

  // Sort by date then startTime
  items.sort((a,b) => {
    const k1 = a.date.localeCompare(b.date);
    if (k1 !== 0) return sortDir === 'asc' ? k1 : -k1;
    const k2 = (a.startTime||'00:00').localeCompare(b.startTime||'00:00');
    return sortDir === 'asc' ? k2 : -k2;
  });

  // Pagination
  const pageSize = q.pageSize ? Math.max(1, parseInt(q.pageSize,10)) : (q.limit ? Math.max(1, parseInt(q.limit,10)) : 100);
  const page = q.page ? Math.max(1, parseInt(q.page,10)) : null;
  let offset = 0;
  if (page) {
    offset = (page - 1) * pageSize;
  } else if (q.offset) {
    offset = Math.max(0, parseInt(q.offset,10));
  }
  const total = items.length;
  const sliced = items.slice(offset, offset + pageSize);

  return res.json({ items: sliced, total, offset, page: page || null, pageSize });
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

  // Prevent bookings in the past relative to America/New_York timezone.  Compute
  // the selected start datetime and compare against the current Eastern time.
  // This ensures server‑side enforcement even if the client omits the check.
  try {
    const selectedStart = new Date(`${date}T${startTime}:00`);
    const easternNowStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const easternNow = new Date(easternNowStr);
    if (selectedStart < easternNow) {
      return res.status(400).json({ error: 'Cannot book a date/time in the past' });
    }
  } catch (err) {
    // ignore date parsing errors
  }
  // Enforce maximum booking duration for single and recurring bookings
  const [sh, sm] = startTime.split(':').map(x => parseInt(x, 10));
  const [eh, em] = endTime.split(':').map(x => parseInt(x, 10));
  if (!isNaN(sh) && !isNaN(sm) && !isNaN(eh) && !isNaN(em)) {
    let startMinutes = sh * 60 + sm;
    let endMinutes = eh * 60 + em;
    if (endMinutes < startMinutes) {
      // Treat overnight bookings as invalid for simplicity
      return res.status(400).json({ error: 'End time must be after start time' });
    }
    const diffMin = endMinutes - startMinutes;
    if (diffMin > MAX_BOOKING_HOURS * 60) {
      return res.status(400).json({ error: `Bookings cannot exceed ${MAX_BOOKING_HOURS} hours` });
    }
  }
  // Check availability for the first occurrence of a recurring booking or single booking
  const rec = recurring && typeof recurring === 'object' ? recurring : false;
  // If recurring, the provided date is the first occurrence. We still need
  // to ensure that date/time is free.
  if (!isSpaceAvailable(spaceId, date, startTime, endTime)) {
    return res.status(400).json({ error: 'Space is not available for the requested time' });
  }
  // For recurring bookings check that future occurrences within one year do not
  // conflict with existing bookings.  If a conflict is detected the booking
  // cannot be created.
  if (rec && !checkRecurringAvailability(spaceId, date, startTime, endTime, rec)) {
    return res.status(400).json({ error: 'Recurring booking conflicts with an existing booking in a future period' });
  }
  const id = uuidv4();
  const booking = {
    id,
    name,
    email: emailNormalized,
    spaceId,
    date,
    startTime,
    endTime,
    recurring: rec,
    checkedIn: false
  };
  bookings.push(booking);
  // Persist changes
  saveData();
  // Send booking confirmation email asynchronously.  Construct a cancel URL
  // using either APP_BASE_URL (when set) or the current request's host.  The
  // confirmation includes basic booking details and a cancel link.
  (async () => {
    const spaceName = spaces.find(s => s.id === spaceId)?.name || spaceId;
    const baseUrl = APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const cancelLink = `${baseUrl}/cancel/${id}`;
    await sendBookingConfirmationEmail(name, emailNormalized, spaceName, date, startTime, endTime, cancelLink);
  })();
  res.json({ id });
});

// Cancel a booking by ID (admin only)
app.delete('/api/bookings/:id', adminAuth, (req, res) => {
  // Only owners and admins can delete bookings
  if (!['owner','superadmin','admin'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { id } = req.params;
  const index = bookings.findIndex(b => b.id === id);
  if (index >= 0) {
    const [removed] = bookings.splice(index, 1);
    const space = spaces.find(s => s.id === removed.spaceId);
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

  // Prevent bookings in the past relative to America/New_York timezone.  Compute
  // the selected start datetime and compare against the current Eastern time.
  try {
    const selectedStart = new Date(`${date}T${startTime}:00`);
    const easternNowStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const easternNow = new Date(easternNowStr);
    if (selectedStart < easternNow) {
      return res.status(400).json({ error: 'Cannot book a date/time in the past' });
    }
  } catch (err) {
    // ignore parse errors
  }
  const candidates = spaces
    .filter(s => s.type === type)
    .sort((a, b) => a.priorityOrder - b.priorityOrder);
  for (const space of candidates) {
    if (isSpaceAvailable(space.id, date, startTime, endTime)) {
      const id = uuidv4();
      const booking = {
        id,
        name,
        email: emailNormalized,
        spaceId: space.id,
        date,
        startTime,
        endTime,
        recurring: false,
        checkedIn: false
      };
      bookings.push(booking);
      // Persist immediately so that cancellation link works even if the process restarts
      saveData();
      // Send booking confirmation email asynchronously
      (async () => {
        const spaceName = space.name;
        const baseUrl = APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
        const cancelLink = `${baseUrl}/cancel/${id}`;
        await sendBookingConfirmationEmail(name, emailNormalized, spaceName, date, startTime, endTime, cancelLink, 'auto');
      })();
      return res.json({ id, spaceName: space.name });
    }
  }
  res.status(404).json({ error: 'No spaces available for the requested time' });
});

// Admin user management
app.get('/api/admins', adminAuth, (req, res) => {
  // Only owners and admins can list admin users
  if (!['owner','superadmin','admin'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(admins.map(a => ({ id: a.id, username: a.username, role: a.role || 'admin' })));
});

app.post('/api/admins', adminAuth, (req, res) => {
  // Only owners can add new admins
  if (!['owner','superadmin'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username or password' });
  }
  const roleNormalized = (role && typeof role === 'string') ? role.toLowerCase() : 'admin';
  if (!ROLES.includes(roleNormalized) || roleNormalized === 'owner') {
    // Prevent creation of new owners via API
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (admins.find(a => a.username === username)) {
    return res.status(400).json({ error: 'Admin already exists' });
  }
  const creds = hashPassword(password);
  const id = uuidv4();
  admins.push({ id, username, passwordHash: creds.hash, salt: creds.salt, role: roleNormalized });
  saveData();
  res.json({ id });
});

app.delete('/api/admins/:id', adminAuth, (req, res) => {
  // Only owners can delete admins
  if (!['owner','superadmin'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { id } = req.params;
  const index = admins.findIndex(a => a.id === id);
  if (index >= 0) {
    // Prevent removal of the last owner
    const adminToRemove = admins[index];
    if (adminToRemove.role === 'owner') {
      // Count number of owners
      const ownerCount = admins.reduce((acc, a) => acc + (a.role === 'owner' ? 1 : 0), 0);
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the only owner' });
      }
    }
    admins.splice(index, 1);
    saveData();
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Admin not found' });
  }
});

// Allow admins to request a password reset. The client sends the username
// (email) in the request body; the server generates a new random
// password, hashes it using the existing salt/hash mechanism, updates
// the admin's stored credentials, persists the change, and emails the
// new password to the admin. The response does not include the
// password.
app.post('/api/admins/lost-password', async (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username) {
      return res.status(400).json({ ok: false, error: 'Missing username' });
    }
    const admin = admins.find(a => a.username === username);
    if (!admin) {
      return res.status(404).json({ ok: false, error: 'Admin not found' });
    }
    // Generate a new random password (8 hex characters)
    const newPassword = crypto.randomBytes(4).toString('hex');
    const { salt, hash } = hashPassword(newPassword);
    admin.salt = salt;
    admin.passwordHash = hash;
    saveData();
    try {
      await sendEmail(username, 'Password Reset', `Your new password is: ${newPassword}`);
    } catch (err) {
      console.error('Failed to send password reset email', err);
      // Even if email fails, we still return ok to avoid revealing
      // whether an email was sent or not.
    }
    return res.json({ ok: true, message: 'A new password has been sent to your email.' });
  } catch (err) {
    console.error('lost-password error', err);
    return res.status(500).json({ ok: false, error: 'internal-error' });
  }
});

// ----- Kiosk and analytics routes -----

// Return bookings for the current day (including recurring bookings that occur on the current day).
// Only accessible from authenticated kiosk sessions.
app.get('/api/bookings/today', (req, res) => {
  if (!isKioskSession(req)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const result = bookings.filter(b => b.date === today || isRecurringOnDate(today, b.recurring)).map(b => {
    const space = spaces.find(s => s.id === b.spaceId);
    return {
      id: b.id,
      name: b.name,
      email: b.email,
      spaceName: space ? space.name : '',
      date: b.date,
      startTime: b.startTime,
      endTime: b.endTime,
      checkedIn: !!b.checkedIn
    };
  });
  res.json(result);
});

// Check in a booking by ID. Marks the booking as checkedIn and persists.
// Only accessible from authenticated kiosk sessions.
app.post('/api/bookings/:id/checkin', (req, res) => {
  if (!isKioskSession(req)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { id } = req.params;
  const booking = bookings.find(b => b.id === id);
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  booking.checkedIn = true;
  saveData();
  res.json({ ok: true });
});

// Analytics endpoint. Returns aggregated booking data for office spaces.
// Supports filtering by time range via query parameters.  Use `period`
// query parameter to select a predefined range: `month`, `quarter`, `year`,
// or `ytd`.  Alternatively specify custom start and end dates using
// `start` and `end` in YYYY‑MM‑DD format.  The response groups results by
// user email and includes counts of bookings by day of the week as well as
// total hours spent checked in vs not checked in.
app.get('/api/analytics', adminAuth, (req, res) => {
  // Only owners, admins and analysts can access analytics
  if (!['owner','admin','analyst'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Determine date range from query parameters
  const { period, start, end } = req.query;
  let startDate;
  let endDate;
  const now = new Date();
  if (start && end) {
    // Custom range
    const s = new Date(start);
    const e = new Date(end);
    if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && s <= e) {
      startDate = s;
      // Add 23h59m to end date to include entire day
      endDate = new Date(e.getFullYear(), e.getMonth(), e.getDate(), 23, 59, 59);
    }
  }
  if (!startDate || !endDate) {
    // Predefined ranges relative to today
    const year = now.getFullYear();
    switch ((period || '').toLowerCase()) {
      case 'quarter': {
        const quarter = Math.floor(now.getMonth() / 3);
        const qStartMonth = quarter * 3;
        startDate = new Date(year, qStartMonth, 1);
        endDate = new Date(year, qStartMonth + 3, 0, 23, 59, 59);
        break;
      }
      case 'year': {
        startDate = new Date(year, 0, 1);
        endDate = new Date(year, 11, 31, 23, 59, 59);
        break;
      }
      case 'ytd': {
        startDate = new Date(year, 0, 1);
        endDate = now;
        break;
      }
      case 'month':
      default: {
        // Default to current month
        startDate = new Date(year, now.getMonth(), 1);
        endDate = new Date(year, now.getMonth() + 1, 0, 23, 59, 59);
        break;
      }
    }
  }
  // Filter bookings to include only those whose space is an office
  const officeBookings = bookings.filter(b => {
    const space = spaces.find(s => s.id === b.spaceId);
    return space && space.type === 'office';
  });
  // Prepare analytics map keyed by user email
  const analyticsMap = {};
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  officeBookings.forEach(b => {
    const email = b.email;
    if (!analyticsMap[email]) {
      analyticsMap[email] = {
        email,
        dayOfWeekCounts: { Sunday: 0, Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0, Saturday: 0 },
        bookingsCount: 0,
        totalMinutesCheckIn: 0,
        totalMinutesNoCheckIn: 0,
        checkIns: 0,
        noCheckIns: 0
      };
    }
    const entry = analyticsMap[email];
    // Helper to process a single occurrence
    function processOccurrence(dateStr) {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return;
      // Check if within range (inclusive)
      if (d < startDate || d > endDate) return;
      const dow = d.getDay();
      const dayName = dayNames[dow];
      entry.dayOfWeekCounts[dayName] = (entry.dayOfWeekCounts[dayName] || 0) + 1;
      entry.bookingsCount++;
      // Compute duration
      const [sh, sm] = b.startTime.split(':').map(x => parseInt(x, 10));
      const [eh, em] = b.endTime.split(':').map(x => parseInt(x, 10));
      if (!isNaN(sh) && !isNaN(sm) && !isNaN(eh) && !isNaN(em)) {
        let startMinutes = sh * 60 + sm;
        let endMinutes = eh * 60 + em;
        let diff = endMinutes - startMinutes;
        if (diff < 0) diff = 0;
        if (b.checkedIn) {
          entry.totalMinutesCheckIn += diff;
        } else {
          entry.totalMinutesNoCheckIn += diff;
        }
      }
      if (b.checkedIn) entry.checkIns++;
      else entry.noCheckIns++;
    }
    // For recurring bookings, iterate through occurrences within range
    if (b.recurring && typeof b.recurring === 'object') {
      // Start at either booking.date or startDate, whichever is later
      const startIter = new Date(b.date > startDate.toISOString().slice(0,10) ? b.date : startDate.toISOString().slice(0,10));
      const endIter = new Date(endDate);
      // Normalise to midnight
      startIter.setHours(0,0,0,0);
      endIter.setHours(0,0,0,0);
      const currentDate = new Date(startIter);
      while (currentDate <= endIter) {
        const dateStr = currentDate.toISOString().slice(0, 10);
        // Only consider dates on or after the first booking date
        if (dateStr >= b.date && isRecurringOnDate(dateStr, b.recurring)) {
          processOccurrence(dateStr);
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }
    } else {
      // Single booking: process if within range
      processOccurrence(b.date);
    }
  });
  // Convert map to an array and format totals as hours
  const result = Object.values(analyticsMap).map(e => {
    return {
      email: e.email,
      dayOfWeekCounts: e.dayOfWeekCounts,
      bookingsCount: e.bookingsCount,
      totalCheckInHours: (e.totalMinutesCheckIn / 60).toFixed(2),
      totalNoShowHours: (e.totalMinutesNoCheckIn / 60).toFixed(2),
      checkIns: e.checkIns,
      noCheckIns: e.noCheckIns
    };
  });
  res.json(result);
});

// -----------------------------------------------------------------------------
// Analytics summary endpoint.  Returns aggregated metrics across all office
// bookings for the selected period.  Includes monthly booking counts,
// monthly check‑in hours, monthly no‑show hours and overall utilisation
// percentage (booked hours vs total available hours for all offices).
app.get('/api/analytics-summary', adminAuth, (req, res) => {
  // Only owners, admins and analysts can access summary
  if (!['owner','admin','analyst'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { period, start, end } = req.query;
  // Determine date range using same logic as analytics endpoint
  let startDate;
  let endDate;
  const now = new Date();
  if (start && end) {
    const s = new Date(start);
    const e = new Date(end);
    if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && s <= e) {
      startDate = s;
      endDate = new Date(e.getFullYear(), e.getMonth(), e.getDate(), 23, 59, 59);
    }
  }
  if (!startDate || !endDate) {
    const year = now.getFullYear();
    switch ((period || '').toLowerCase()) {
      case 'quarter': {
        const quarter = Math.floor(now.getMonth() / 3);
        const qStartMonth = quarter * 3;
        startDate = new Date(year, qStartMonth, 1);
        endDate = new Date(year, qStartMonth + 3, 0, 23, 59, 59);
        break;
      }
      case 'year': {
        startDate = new Date(year, 0, 1);
        endDate = new Date(year, 11, 31, 23, 59, 59);
        break;
      }
      case 'ytd': {
        startDate = new Date(year, 0, 1);
        endDate = now;
        break;
      }
      case 'month':
      default: {
        startDate = new Date(year, now.getMonth(), 1);
        endDate = new Date(year, now.getMonth() + 1, 0, 23, 59, 59);
        break;
      }
    }
  }
  // Utility to format month key as YYYY-MM
  function monthKey(dateObj) {
    const y = dateObj.getFullYear();
    const m = (dateObj.getMonth() + 1).toString().padStart(2, '0');
    return `${y}-${m}`;
  }
  // Initialise accumulators
  const monthlyBookings = {};
  const monthlyCheckInMinutes = {};
  const monthlyNoShowMinutes = {};
  let totalBookedMinutes = 0;
  // Filter office bookings
  const officeBookings = bookings.filter(b => {
    const space = spaces.find(s => s.id === b.spaceId);
    return space && space.type === 'office';
  });
  // Iterate bookings and occurrences
  officeBookings.forEach(b => {
    function processOccurrence(dateStr) {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return;
      if (d < startDate || d > endDate) return;
      const key = monthKey(d);
      // Compute minutes for the occurrence
      const [sh, sm] = b.startTime.split(':').map(n => parseInt(n,10));
      const [eh, em] = b.endTime.split(':').map(n => parseInt(n,10));
      if (isNaN(sh) || isNaN(sm) || isNaN(eh) || isNaN(em)) return;
      let diff = (eh * 60 + em) - (sh * 60 + sm);
      if (diff < 0) diff = 0;
      // Accumulate bookings count
      monthlyBookings[key] = (monthlyBookings[key] || 0) + 1;
      if (b.checkedIn) {
        monthlyCheckInMinutes[key] = (monthlyCheckInMinutes[key] || 0) + diff;
      } else {
        monthlyNoShowMinutes[key] = (monthlyNoShowMinutes[key] || 0) + diff;
      }
      totalBookedMinutes += diff;
    }
    if (b.recurring && typeof b.recurring === 'object') {
      const startIter = new Date(b.date > startDate.toISOString().slice(0,10) ? b.date : startDate.toISOString().slice(0,10));
      const endIter = new Date(endDate);
      startIter.setHours(0,0,0,0);
      endIter.setHours(0,0,0,0);
      const currentDate = new Date(startIter);
      while (currentDate <= endIter) {
        const dateStr = currentDate.toISOString().slice(0,10);
        if (dateStr >= b.date && isRecurringOnDate(dateStr, b.recurring)) {
          processOccurrence(dateStr);
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }
    } else {
      processOccurrence(b.date);
    }
  });
  // Convert minutes to hours with 2 decimals
  const monthlyCheckInHours = {};
  Object.keys(monthlyCheckInMinutes).forEach(k => {
    monthlyCheckInHours[k] = (monthlyCheckInMinutes[k] / 60).toFixed(2);
  });
  const monthlyNoShowHours = {};
  Object.keys(monthlyNoShowMinutes).forEach(k => {
    monthlyNoShowHours[k] = (monthlyNoShowMinutes[k] / 60).toFixed(2);
  });
  // Compute utilisation percentage
  // Available minutes = number of office spaces * number of days * 24 * 60
  const officeCount = spaces.reduce((acc, s) => acc + (s.type === 'office' ? 1 : 0), 0);
  const startDay = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const endDay = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  const millisPerDay = 24 * 60 * 60 * 1000;
  const dayCount = Math.floor((endDay - startDay) / millisPerDay) + 1;
  const totalAvailableMinutes = officeCount * dayCount * 24 * 60;
  const utilisation = totalAvailableMinutes > 0 ? ((totalBookedMinutes / totalAvailableMinutes) * 100).toFixed(2) : '0.00';
  res.json({ monthlyBookings, monthlyCheckInHours, monthlyNoShowHours, utilisation });
});

// -----------------------------------------------------------------------------
// Analytics export endpoint.  Generates a CSV file of the per‑user analytics
// data for the specified period.  Columns include email, booking counts by
// day of week (Sun–Sat), total bookings count, check‑in hours, no‑show
// hours, check‑in count and no‑check‑in count.  Returned as a text/csv
// attachment.
app.get('/api/analytics-export', adminAuth, (req, res) => {
  // Only owners, admins and analysts can export analytics
  if (!['owner','admin','analyst'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { period, start, end } = req.query;
  // Compute date range similar to analytics endpoint
  let startDate;
  let endDate;
  const now = new Date();
  if (start && end) {
    const s = new Date(start);
    const e = new Date(end);
    if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && s <= e) {
      startDate = s;
      // Include entire end day
      endDate = new Date(e.getFullYear(), e.getMonth(), e.getDate(), 23, 59, 59);
    }
  }
  if (!startDate || !endDate) {
    const year = now.getFullYear();
    switch ((period || '').toLowerCase()) {
      case 'quarter': {
        const quarter = Math.floor(now.getMonth() / 3);
        const qStartMonth = quarter * 3;
        startDate = new Date(year, qStartMonth, 1);
        endDate = new Date(year, qStartMonth + 3, 0, 23, 59, 59);
        break;
      }
      case 'year': {
        startDate = new Date(year, 0, 1);
        endDate = new Date(year, 11, 31, 23, 59, 59);
        break;
      }
      case 'ytd': {
        startDate = new Date(year, 0, 1);
        endDate = now;
        break;
      }
      case 'month':
      default: {
        startDate = new Date(year, now.getMonth(), 1);
        endDate = new Date(year, now.getMonth() + 1, 0, 23, 59, 59);
        break;
      }
    }
  }
  // Build CSV of all bookings (past and future) within the selected period.
  // Each row represents a single booking occurrence (including future
  // occurrences of recurring bookings) and includes the date, user, space,
  // start and end times, and check‑in status.  This replaces the
  // aggregated per‑user analytics previously returned.
  const headers = ['Date','Name','Email','Space','Start','End','CheckedIn'];
  const rows = [headers.join(',')];
  // Helper to escape CSV fields
  function escapeCsv(value) {
    const s = String(value);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }
  // Iterate through all bookings (all spaces) and generate rows
  bookings.forEach(b => {
    const space = spaces.find(s => s.id === b.spaceId);
    const spaceName = space ? space.name : b.spaceId;
    function processOccurrence(dateStr) {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return;
      if (d < startDate || d > endDate) return;
      const row = [
        dateStr,
        b.name,
        b.email,
        spaceName,
        b.startTime,
        b.endTime,
        b.checkedIn ? 'Yes' : 'No'
      ];
      rows.push(row.map(escapeCsv).join(','));
    }
    if (b.recurring && typeof b.recurring === 'object') {
      // Generate occurrences for recurring bookings within the range
      const startIter = new Date(b.date > startDate.toISOString().slice(0,10) ? b.date : startDate.toISOString().slice(0,10));
      const endIter = new Date(endDate);
      startIter.setHours(0,0,0,0);
      endIter.setHours(0,0,0,0);
      const currentDate = new Date(startIter);
      while (currentDate <= endIter) {
        const dateStr = currentDate.toISOString().slice(0,10);
        if (dateStr >= b.date && isRecurringOnDate(dateStr, b.recurring)) {
          processOccurrence(dateStr);
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }
    } else {
      // Single booking
      processOccurrence(b.date);
    }
  });
  const csv = rows.join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="bookings.csv"');
  res.send(csv);
});

// ----- Kiosk token management API -----

// List all kiosk registration tokens (admin only). Returns the array of
// tokens including id and code. Admin UI uses this to display active
// devices and codes. Because codes effectively authenticate kiosk
// devices, they should be treated as secrets and only visible to admins.
app.get('/api/kiosk/tokens', adminAuth, (req, res) => {
  // Permit superadmins to manage kiosk tokens as well.  Previously superadmins
  // were excluded which prevented them from viewing tokens in the settings UI.
  if (!['owner', 'admin', 'superadmin'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(kioskTokens);
});

// Generate a new kiosk registration token (admin only). The server
// returns a newly generated id and code. The id is stored in cookies on
// the kiosk device, while the code is shared with the device during
// setup. The token remains valid until explicitly revoked by an admin.
app.post('/api/kiosk/tokens', adminAuth, (req, res) => {
  // Allow superadmins to generate kiosk tokens in addition to owners and admins.
  if (!['owner', 'admin', 'superadmin'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const id = uuidv4();
  const code = generateKioskCode();
  kioskTokens.push({ id, code });
  saveData();
  res.json({ id, code });
});

// Revoke an existing kiosk token by its id (admin only). If the token is
// revoked any devices using it will lose access on their next request. This
// does not remove the cookie from the client; instead the server simply
// stops recognising the token.
app.delete('/api/kiosk/tokens/:id', adminAuth, (req, res) => {
  // Allow superadmins to revoke kiosk tokens.  Without this, superadmins
  // could not perform deletions in the admin settings page.
  if (!['owner', 'admin', 'superadmin'].includes(req.adminRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { id } = req.params;
  const index = kioskTokens.findIndex(t => t.id === id);
  if (index < 0) {
    return res.status(404).json({ error: 'Token not found' });
  }
  kioskTokens.splice(index, 1);
  saveData();
  res.json({ ok: true });
});

// Claim a kiosk token. A kiosk device will call this endpoint with
// { code: 'ABC123' }. If the code exists in kioskTokens, the server
// sets a httpOnly cookie named `kioskToken` containing the id of the token.
// Subsequent requests will be allowed to access kiosk functionality. If the
// code is not found an error is returned. This endpoint is not protected
// so that kiosk devices without an existing session can call it.
app.post('/api/kiosk/claim', (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Invalid token code' });
  }
  const entry = kioskTokens.find(t => t.code.toUpperCase() === code.toUpperCase());
  if (!entry) {
    return res.status(404).json({ error: 'Token not found' });
  }
  kioskSessions[entry.id] = true;
  // Set cookie valid for one year. Using a long expiry so the session
  // survives kiosk restarts. sameSite strict prevents cross-site
  // transmission of the cookie.
  res.cookie('kioskToken', entry.id, { httpOnly: true, sameSite: 'strict', maxAge: 365 * 24 * 60 * 60 * 1000, path: '/' });
  res.json({ ok: true });
});

// ----- Email verification routes -----

/**
 * Request email verification. Accepts a JSON body with an `email` field.
 * If the email belongs to the company domain and has not already been verified,
 * a verification token is generated and emailed to the address. The response
 * always returns OK (to avoid leaking which emails are already verified).
 */
app.post('/api/request-verification', (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  const emailNormalized = String(email).trim().toLowerCase();
  if (!emailNormalized.endsWith('@fbhi.net')) {
    return res.status(400).json({ error: 'Email must be a @fbhi.net address' });
  }
  // If already verified, return success without sending another email
  if (verifiedEmails.includes(emailNormalized)) {
    return res.json({ ok: true, message: 'Email already verified' });
  }
  // Generate a unique token and store mapping to email
  const token = uuidv4();
  verificationTokens[token] = emailNormalized;
  // Build a verification link.  Prefer the configured APP_BASE_URL when provided.
  // Otherwise construct an absolute URL using the current request's protocol and host.
  let verifyLink;
  if (APP_BASE_URL) {
    verifyLink = `${APP_BASE_URL}/verify-email/${token}`;
  } else {
    verifyLink = `${req.protocol}://${req.get('host')}/verify-email/${token}`;
  }
  const message =
    `Please verify your email address by clicking the following link:\n\n${verifyLink}\n\n` +
    `Once verified, you will be able to book spaces on the booking site.`;
  // Fire and forget verification email; log any failures
  sendEmail(emailNormalized, 'Email Verification', message).catch(err => {
    console.error('Failed to send verification email:', err);
  });
  res.json({ ok: true });
});

/**
 * Verify an email using a token. When a valid token is accessed, the
 * corresponding email is added to the verifiedEmails list and persisted.
 * A simple HTML page is returned that stores the verification status in
 * localStorage and redirects back to the booking page.
 */
app.get('/verify-email/:token', (req, res) => {
  const { token } = req.params;
  const email = verificationTokens[token];
  if (!email) {
    return res.status(404).send(
      '<html><head><title>Invalid Token</title></head><body>' +
      '<h1>Invalid or expired verification token</h1>' +
      '<p>Please request a new verification link.</p>' +
      '</body></html>'
    );
  }
  // Add email to verified list if not present
  if (!verifiedEmails.includes(email)) {
    verifiedEmails.push(email);
    saveData();
  }
  // Remove the token so it cannot be reused
  delete verificationTokens[token];
  // Build HTML response with script to set localStorage and redirect
  const html =
    '<!DOCTYPE html><html><head><title>Email Verified</title></head><body>' +
    '<h1>Email Verified</h1>' +
    '<p>Your email address has been verified. You may now book a space.</p>' +
    `<script>
      try {
        localStorage.setItem('emailVerified', 'true');
        localStorage.setItem('verifiedEmail', '${email}');
      } catch (e) {}
      window.location.href = '/';
    </script>` +
    '</body></html>';
  res.send(html);
});

// Start server after initialising the database and loading data.  Because
// database operations are asynchronous we perform them in an immediately
// invoked async function.  If any of the setup steps fail the error is
// logged and the server will still start with the in‑memory defaults.
(async () => {
  try {
    await initDb();
    await loadData();
  } catch (err) {
    console.error('Initialisation error:', err);
  }
  
// === TEMPORARY BOOTSTRAP ADMIN ROUTE (DELETE AFTER USE) ===
// NOTE: uuidv4 is already imported at top of file.
app.post('/api/bootstrap-admin', async (req, res) => {
  try {
    const { token, username, password, role = 'admin' } = req.body || {};

    // Require a bootstrap token so this isn't a public backdoor
    if (!process.env.BOOTSTRAP_TOKEN || token !== process.env.BOOTSTRAP_TOKEN) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'username and password required' });
    }

    // Validate role if provided
    const adminRole = (typeof role === 'string' ? role : 'admin');
    if (typeof ROLES !== 'undefined' && Array.isArray(ROLES) && !ROLES.includes(adminRole)) {
      return res.status(400).json({ ok: false, error: 'invalid role' });
    }

    // Use the SAME hashing code the app uses
    const { hash, salt } = hashPassword(password);

    const id = uuidv4();

    let dbRow = null;

    if (db) {
      const text = `
        INSERT INTO admins (id, username, "passwordHash", salt, role)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (username) DO UPDATE
          SET "passwordHash" = EXCLUDED."passwordHash",
              salt = EXCLUDED.salt,
              role = EXCLUDED.role
        RETURNING id, username, role;`;
      const values = [id, username, hash, salt, adminRole];
      const result = await db.query(text, values);
      dbRow = result && result.rows && result.rows[0] ? result.rows[0] : null;
    }

    // Update in‑memory cache
    if (Array.isArray(admins)) {
      const i = admins.findIndex(a => a.username === username);
      const adminRow = { id: (dbRow?.id || id), username, passwordHash: hash, salt, role: adminRole };
      if (i >= 0) admins[i] = adminRow; else admins.push(adminRow);
      // Persist JSON snapshot as well
      try { saveData(); } catch (_) {}
    }

    const responseAdmin = dbRow ? dbRow : { id: id, username, role: adminRole };
    return res.json({ ok: true, admin: responseAdmin });
  } catch (err) {
    console.error('bootstrap-admin error', err);
    return res.status(500).json({ ok: false, error: 'internal-error' });
  }
});
// === END TEMPORARY ROUTE ===



// ---- Test email endpoint ----
app.get('/api/test-email', async (req, res) => {
  const expected = process.env.TEST_EMAIL_KEY;
  if (expected && req.query.key !== expected) return res.status(403).json({ ok: false, error: 'forbidden' });
  const to = req.query.to || process.env.MAIL_FROM || process.env.SMTP_USER;
  try {
    await sendEmail(to, 'Test Email (Booking App)', 'This is a test email from the Booking App.');
    return res.json({ ok: true, to });
  } catch (e) {
    console.error('Test email failed:', e && (e.stack || e.message || e));
    return res.status(500).json({ ok: false, error: 'send-failed', detail: String(e && (e.message || e)) });
  }
});
app.listen(PORT, () => {
    console.log(`Booking app listening at http://localhost:${PORT}`);
  });
})();
