# Arrivo Admin

Internal ops dashboard for running Arrivo day to day. React + Vite, talks to `arrivo-backend`. Not public — no signup, admin accounts only.

## Run it

```bash
npm install
npm run dev        # local dev server
npm run build       # production build -> dist/
npm run preview     # serve the production build locally
```

Point it at your backend by setting the API base URL (check `src/api.js`).

## What's here

- `src/pages/` — one page per section: Panic Alerts (default landing page), Drivers, Rides, Riders, Analytics, Live Map
- `src/components/` — shared UI (StatCard, StatusPill, Sidebar, PhoneLink)
- `src/AuthContext.jsx` — login/session handling against the backend's admin auth

## Logging in

There's no self-signup. Create an admin account on the backend first:

```bash
cd ../arrivo-backend
node scripts/create-admin.js "Name" "email@example.com" "password"
```

## Deploy

Vercel. `vercel.json` sets security headers (CSP, frame-ancestors, etc.) and the SPA rewrite — don't remove those when touching that file.
