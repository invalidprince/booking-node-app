'use strict';

/**
 * Minimal, production-friendly Express server for Render.
 * - Single import of uuid.v4 (fixes "Identifier 'uuidv4' has already been declared")
 * - Request ID + basic logging
 * - JSON body parsing
 * - CORS (configurable via CORS_ORIGIN)
 * - Health checks at / and /healthz
 * - Static file serving from ./public (optional)
 * - Example API route at /api/time
 * - Centralized error handling
 * - Graceful shutdown on SIGTERM/SIGINT
 *
 * Common Render settings:
 *   Build Command:    npm install
 *   Start Command:    node server.js
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { v4: uuidv4 } = require('uuid'); // import this ONCE

// ---- Configuration ----
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'production';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'public');

// ---- App setup ----
const app = express();
app.set('env', NODE_ENV);
app.set('trust proxy', true);

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Request ID + basic access log
app.use((req, res, next) => {
  const incoming = req.get('x-request-id');
  const requestId = incoming && typeof incoming === 'string' ? incoming : uuidv4();
  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durNs = Number(process.hrtime.bigint() - start);
    const ms = (durNs / 1e6).toFixed(1);
    // Keep logging simple & dependency-free
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        id: requestId,
        ip: req.ip,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        ms: Number(ms),
        len: res.getHeader('content-length') || 0,
      })
    );
  });
  next();
});

// CORS (basic)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Request-Id');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health checks
app.get('/', (_req, res) => {
  res.type('text/plain').send('OK');
});
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, env: NODE_ENV, time: new Date().toISOString() });
});

// Static files (optional)
app.use('/static', express.static(STATIC_DIR, { fallthrough: true, extensions: ['html', 'htm'] }));

// Example API route
app.get('/api/time', (req, res) => {
  res.json({
    now: new Date().toISOString(),
    requestId: res.locals.requestId,
  });
});

// 404 handler
app.use((req, res, _next) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl,
    requestId: res.locals.requestId,
  });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const payload = {
    error: status >= 500 ? 'Internal Server Error' : 'Bad Request',
    message: err.message || String(err),
    requestId: res.locals.requestId,
  };
  // Log the full error server-side
  console.error('[ERROR]', {
    requestId: res.locals.requestId,
    message: err.message,
    stack: err.stack,
  });
  res.status(status).json(payload);
});

// ---- Start server ----
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT} (env=${NODE_ENV})`);
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`${signal} received → closing server...`);
  server.close((err) => {
    if (err) {
      console.error('Error shutting down server:', err);
      process.exit(1);
    }
    console.log('HTTP server closed. Bye!');
    process.exit(0);
  });
  // Force shutdown after 10s
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
