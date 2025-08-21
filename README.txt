
# Booking App Update (Aug 15, 2025)

This bundle contains the files you asked for:
- `server.js` (Express API with auto‑booking, email logging, admin routes)
- `public/index.html` (new UI with auto‑booking in dropdown + custom time picker)
- `public/admin.html` (fixed login + CRUD)
- `package.json` (start script & dependencies)

## How to use (GitHub web)
1) In your repo, open the **public** folder → **Add file → Upload files**.
2) Drag in `public/index.html` and `public/admin.html` from this zip.
3) Commit directly to `main` with a clear message.

Then, at the repo root:
1) **Add file → Upload files**.
2) Drag in `server.js` and `package.json` (overwrite existing files).
3) Commit directly to `main`.

## Run locally on your Mac
```bash
git pull
npm install
npm start   # runs on http://localhost:5050
```

If port is busy: `lsof -i :5050` then `kill -9 <PID>`.

## Default admin credentials
- username: admin@example.com
- password: admin123

(You can add/remove admins in the Admin page.)

