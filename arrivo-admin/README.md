# Arrivo Ops Console (Admin Dashboard)

A web dashboard for running Arrivo day to day — the tool your ops team uses from a laptop, separate from the rider and driver mobile apps. Built with React + Vite, talking to the same `arrivo-backend`.

## What it does

- **Drivers** — every driver who's signed up, their vehicle, license/LASDRI numbers, verification status, and online status. Verify or revoke a driver with one click.
- **Rides** — every ride on the platform, filterable by status. Click a row to expand it and add a dispute/support note, or force-cancel a ride.
- **Analytics** — headline numbers: this month's and all-time revenue, rider/driver counts, verified/online driver counts, and a breakdown of rides by status.

## A real security fix that came with this

Before this build, any device that could reach your API could sign up with `role: "admin"` and get full access. That's now blocked — **public signup only allows `rider`, `driver`, or `owner`.** Admin accounts can only be created by someone with direct access to the server, via a script:

```bash
cd arrivo-backend
node scripts/create-admin.js "Your Name" "you@arrivo.app" "a-strong-password"
```

This is intentional friction — admin creation should never be a network-reachable action.

## Run it locally

Make sure `arrivo-backend` is running first (see the top-level bundle README).

```bash
cd arrivo-admin
npm install
cp .env.example .env
```

Edit `.env` if your backend isn't on `localhost:4000`:

```
VITE_API_BASE_URL=http://localhost:4000
```

Create your first admin account (from the backend folder, in a separate terminal):

```bash
cd ../arrivo-backend
node scripts/create-admin.js "Ops Admin" "admin@arrivo.app" "adminpass123"
```

Then start the dashboard:

```bash
cd ../arrivo-admin
npm run dev
```

Open the URL it prints (usually `http://localhost:5173`) and log in with the email/password you just created.

## Test it end to end

1. Log in with your admin account.
2. On the **rider app**, sign up and book + pay for a ride.
3. On the **driver app**, sign up, complete your profile, go online.
4. Back in **this dashboard**, go to **Drivers** — your new driver should show up with a "Pending" badge. Click **Verify**.
5. Go to **Rides** — the ride you booked should be there. Click it, add a note, save it.
6. Go to **Analytics** — the ride's fare should show up in revenue once its payment status is `paid`.

## What's real vs. what's a known gap

| Feature | Status |
|---|---|
| Driver verification, ride oversight, analytics | ✅ Real — every endpoint tested end-to-end, including the security fix, role enforcement (a non-admin gets a clean 403), and a full click-through of all three pages with zero console errors |
| **`is_verified` enforcement** | ✅ Fixed as part of this build — `PATCH /api/drivers/status` now rejects `{isOnline: true}` with a 403 if the driver isn't verified yet. Tested both ways: blocked while unverified, succeeds immediately after an admin verifies them here. |
| Session storage | 🟡 Token stored in `localStorage` — fine for internal tooling used by a small trusted team, but if this dashboard ever needs to meet a stricter security bar, move to an HttpOnly cookie-based session instead, since `localStorage` is readable by any JS that runs on the page (e.g. a compromised dependency). |
| Live fleet map | Not built — Rides currently shows a table, not a map. Once real GPS exists (noted as a gap in the driver app README), this is the natural next addition here. |

## Deploying this

This is a normal Vite/React app — `npm run build` produces a `dist/` folder you can host anywhere static (Vercel, Netlify, Render static sites, or even a simple S3 bucket + CloudFront). Point `VITE_API_BASE_URL` at your real deployed backend URL before building for production. Keep this dashboard's URL private/internal — it's not meant to be discoverable by the public, even though the login screen itself is a reasonable safeguard.
