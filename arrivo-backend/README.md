# Arrivo Backend

Node.js/Express API backing the Arrivo rider app, driver app, admin dashboard, and website. Now running on **PostgreSQL** (migrated from an earlier SQLite version) so it can be deployed somewhere real and hold data reliably between deploys.

## What's in this update

- **Migrated from SQLite to PostgreSQL.** Every route was rewritten (not just the schema) — SQLite's `db.prepare().get()/.all()/.run()` and Postgres's `pool.query()` have different shapes, so this touched every file in `routes/`. Tested end-to-end against a real running Postgres instance: signup, login, guest checkout, ride creation, driver verification, ride acceptance (including the two-drivers-race case), the panic button, and admin analytics all passed.
- **Booking types**: rides now carry a `booking_type` (`one_way` | `full_day` | `full_week` | `full_month`) and `duration_days`, so a single "book a ride" flow covers a one-off airport pickup, a full-day charter, a week-long booking, or a month-long one — all through the same `POST /api/rides` endpoint.
- **Driver live location tracking**: a new `PATCH /api/drivers/location` endpoint lets the driver's phone report its GPS position periodically. `GET /api/rides/:id` now returns the assigned driver's last known coordinates, so a rider's tracking screen (or the admin dashboard) can show real position instead of nothing.
- **Rider panic button**: `POST /api/rides/:id/panic` lets a rider flag that they don't feel safe, mid-ride. It's logged server-side immediately and surfaced in the admin dashboard's new Panic Alerts page (which polls every 10 seconds and is the *default* page an admin sees on login). `PATCH /api/admin/panics/:rideId/resolve` lets an admin close it out with resolution notes.

## Setup

### 1. Get a Postgres database

Two free options that don't expire:

- **[neon.tech](https://neon.tech)** — serverless Postgres, generous free tier, very fast to set up
- **[supabase.com](https://supabase.com)** — also gives you a free Postgres, plus a UI if you want to browse data by hand

Either way, you'll end up with a connection string that looks like:
```
postgresql://user:password@host.neon.tech/dbname?sslmode=require
```

### 2. Configure and run

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
```
DATABASE_URL=<your real connection string>
AVIATIONSTACK_KEY=<from aviationstack.com>
PAYSTACK_SECRET_KEY=sk_test_...
PAYSTACK_PUBLIC_KEY=pk_test_...
JWT_SECRET=<generate with the command in .env.example>
```

```bash
npm start
```

Tables are created automatically on first startup (every `CREATE TABLE` uses `IF NOT EXISTS`, so this is safe to run every time).

### 3. Create your first admin account

```bash
node scripts/create-admin.js "Your Name" "you@arrivo.app" "a-strong-password"
```

Deliberately a CLI-only script, not an API endpoint — admin accounts should never be creatable by anyone who can merely reach your API over the network.

## Testing locally against a real Postgres (optional, for development)

If you want to test against Postgres on your own machine instead of a hosted one:

```bash
# Ubuntu/Debian
sudo apt-get install postgresql
sudo service postgresql start
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres createdb arrivo_dev
```

Then set `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/arrivo_dev` in `.env`.

## New endpoints reference

| Endpoint | Purpose |
|---|---|
| `PATCH /api/drivers/location` | Driver's phone reports its current GPS coordinates (body: `{ lat, lng }`) |
| `GET /api/rides/:id` | Full ride details, including the assigned driver's last known location |
| `POST /api/rides/:id/panic` | Rider triggers a safety alert (body: `{ note? }`) |
| `GET /api/admin/panics` | All currently unresolved panic alerts |
| `PATCH /api/admin/panics/:rideId/resolve` | Admin marks a panic alert as handled (body: `{ notes? }`) |
| `POST /api/rides` | Now accepts `bookingType` and `durationDays` alongside the existing fields |

**Honest gap**: the panic alert is currently only visible in the admin dashboard (polled every 10 seconds) and logged to the server console. It does **not** yet send an SMS, push notification, or Slack alert to anyone in real time — see the `TODO` comment in `routes/rides.js`'s panic handler. Before relying on this for real rider safety, wire that alert to something that actually pages a human (Twilio SMS to an ops phone is the simplest option).

## Deploying to Render (free tier)

1. Push this repo to GitHub (see the main bundle README for the git commands).
2. [dashboard.render.com](https://dashboard.render.com) → **New** → **Web Service** → connect your GitHub repo.
3. Render auto-detects Node. Settings:
   - **Build command**: `npm install`
   - **Start command**: `npm start`
4. Under **Environment**, add every variable from your `.env` file (`DATABASE_URL`, `AVIATIONSTACK_KEY`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_CALLBACK_URL`, `JWT_SECRET`) — never commit `.env` itself.
5. Deploy. Render gives you a public URL like `https://arrivo-backend.onrender.com`.

**Free tier reality check**: the service sleeps after 15 minutes of inactivity — the first request after that takes 30–60 seconds to wake back up. Fine for testing and an early pilot; upgrade to a paid instance once you have real users who won't tolerate that wake-up delay.

### Why not Vercel for this part

Vercel is excellent for the **website** (`ridearrivo-website`) and would also work for the **admin dashboard** (`arrivo-admin`) — both are static/frontend builds. It is **not** a fit for this backend: Vercel's serverless functions are stateless and short-lived, which doesn't suit an Express app that needs a persistent Postgres connection pool and long-running processes. Render (or Railway/Fly.io if you later have budget for their paid tiers) is the right category of host for `arrivo-backend`.

## After deploying

Update the `API_BASE_URL` / `apiBaseUrl` in every frontend that talks to this backend:
- `arrivo-app/app.json` → `extra.apiBaseUrl`
- `arrivo-driver-app/app.json` → `extra.apiBaseUrl`
- `ridearrivo-website/script.js` and `ridearrivo-website/booking.js` → `API_BASE_URL`
- `arrivo-admin/.env` → `VITE_API_BASE_URL`
