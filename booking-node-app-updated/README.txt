# Booking App Update (Aug 15, 2025)

This bundle contains the files required to run the simple office booking application with recurring schedules and an availability page.

## Features

* **Recurring bookings (admin portal):** Admins can create monthly recurring blocks on a specific day of the month (e.g. 1st) or on the _nth_ weekday of the month (e.g. 3rd Friday). Recurring bookings reserve the associated space on each matching date until removed.
* **Availability page:** End users can view availability for any space on a given date. The page displays 30‑minute time slots between 08:00 and 18:00 with a simple yes/no indication for each slot.
* **Auto booking:** Users can still automatically pick the next available office or desk based on priority order.
* **Admin CRUD:** Admins can manage spaces, bookings and admin accounts. Bookings (single or recurring) can be cancelled via the admin portal.

## How to use (GitHub web)

1. In your repo, open the **`public`** folder → **Add file** → Upload files →
   • Drag in `public/index.html`, `public/admin.html` and `public/availability.html` from this zip.
2. Then, at the repo root:
   • **Add file → Upload files** → drag in `server.js` and `package.json`.
3. Commit directly to `main` with a clear message.

## Running locally

1. Install dependencies: `npm install`
2. Start the server: `npm start`
3. Open your browser to `http://localhost:5050/index.html` to book a space or `http://localhost:5050/admin.html` for the admin portal.
