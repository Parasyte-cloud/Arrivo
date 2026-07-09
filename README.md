# Arrivo — Full Bundle

Five projects, one backend:

```
arrivo-bundle/
├── arrivo-app/            # Rider app (Expo/React Native)
├── arrivo-driver-app/     # Driver app (Expo/React Native) — separate app, separate store listing
├── arrivo-admin/          # Ops dashboard (React + Vite, runs in a browser)
├── ridearrivo-website/    # Marketing site + web booking flow (plain HTML/CSS/JS)
└── arrivo-backend/        # Node/Express API + PostgreSQL — everything above talks to this
```

Start the backend first. Every other piece can then run independently.

---

## What's new in this update

### 1. Migrated from SQLite to PostgreSQL

The backend used to run on a local SQLite file, which is fine for a laptop but doesn't survive being deployed to most hosting platforms (their filesystems reset on every redeploy). Every route was rewritten — not just the schema — to use `pg` and real Postgres. Tested end-to-end against a real running Postgres instance covering the full lifecycle: signup, login, guest checkout, ride creation, driver verification, ride acceptance (including the two-drivers-race-for-one-ride case), and admin analytics.

### 2. Booking types: one-way / full day / full week / full month

Rides now carry a `booking_type` and `duration_days`, selectable in both the mobile app's Route screen and the website's booking flow, each with its own fare multiplier. Verified against the real database that a completed booking saves with the correct type, duration, and total fare — not just that the UI shows the right number.

### 3. Driver GPS location tracking

The driver app now reports its phone's GPS position to the backend every 20 seconds while online (`expo-location`, foreground only for now). `GET /api/rides/:id` returns the assigned driver's last known coordinates. This is real, tested data — what's still a placeholder is the map *visualization* itself in both mobile apps (swap `MapPlaceholder` for `react-native-maps` to plot it).

### 4. Rider panic button

A safety button on the rider app's Live Tracking screen. Tapping it posts immediately to the backend and shows up in the admin dashboard's new **Panic Alerts** page — which is now the *first thing* an admin sees on login, polls every 10 seconds, and shows a live badge count in the sidebar. Tested with a real mounted build of the admin dashboard, not just read over: rider/driver details, the rider's note, and a working Google Maps link from the driver's last reported position all render correctly with zero console errors.

**The one honest gap in this feature**: right now, a panic alert only surfaces in the admin dashboard. Nothing pages a human in real time yet (no SMS, push notification, or Slack alert). See `arrivo-backend`'s README for exactly what's needed before this is safe to rely on for a real incident — it's a small, well-scoped follow-up (Twilio SMS is the simplest path), not a big one.

---

## Getting started

### 1. Get a Postgres database (free, permanent)

[neon.tech](https://neon.tech) or [supabase.com](https://supabase.com) — either gives you a connection string like `postgresql://user:pass@host/db`.

### 2. Run the backend

```bash
cd arrivo-backend
npm install
cp .env.example .env
# fill in DATABASE_URL, AVIATIONSTACK_KEY, PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY, JWT_SECRET
npm start
```

### 3. Create your first admin account

```bash
node scripts/create-admin.js "Your Name" "you@arrivo.app" "a-strong-password"
```

### 4. Run everything else

```bash
cd ../arrivo-admin && npm install && cp .env.example .env && npm run dev
cd ../arrivo-app && npm install && npx expo start
cd ../arrivo-driver-app && npm install && npx expo start
cd ../ridearrivo-website && python3 -m http.server 8080
```

Each mobile app's `app.json` (`extra.apiBaseUrl`) and the website's `script.js`/`booking.js` (`API_BASE_URL`) need to point at wherever your backend actually runs — your computer's local IP for testing on a physical phone, or your deployed backend's real URL once it's live.

---

## Test the whole thing end to end

1. **Admin dashboard**: log in — you land on Panic Alerts.
2. **Rider app**: sign up, pick a booking type (try "Full week"), book a ride, pay.
3. **Driver app**: sign up, complete your profile, try going online — **blocked**, not verified yet.
4. **Admin dashboard → Drivers**: verify the new driver.
5. **Driver app**: go online now — works. Accept the ride, start it.
6. **Rider app's tracking screen**: tap the safety/panic button.
7. **Admin dashboard**: within 10 seconds, the alert appears on Panic Alerts with a live badge count. Resolve it.
8. **Admin dashboard → Rides**: confirm the ride shows the right booking type and fare.
9. **Admin dashboard → Analytics**: revenue reflects the paid ride.

---

## Deployment guide by project

| Project | Where | Why |
|---|---|---|
| `arrivo-backend` | **Render** (free tier) | Needs a persistent server process + Postgres connection pool — not a fit for serverless/static hosts. Full steps in its own README, including why Vercel specifically doesn't fit here. |
| `ridearrivo-website` | **Cloudflare Pages** (since `ridearrivo.com` is already there) or **Vercel** | Both work for a static site; Cloudflare is the natural choice since your domain's already there and DNS connects automatically. Steps for both are in its README. |
| `arrivo-admin` | **Vercel**, Cloudflare Pages, or Netlify | Standard Vite/React static build — any of these work. |
| `arrivo-app` / `arrivo-driver-app` | **EAS Build → App Store / Google Play** | Covered in each app's own README — these are the two that go through app store review, not a web host. |

---

## Where things stand now

**Built:** rider app, driver app, admin dashboard, marketing site + web booking, backend — with real Postgres, real payments, real auth, booking types, GPS location reporting, and a rider safety button.

**Still missing, roughly in priority order:**
1. **Real-time paging for panic alerts** — an SMS/push/Slack alert to an actual human, not just a dashboard someone has to have open.
2. **Push notifications generally** (Firebase Cloud Messaging) — for new ride requests on the driver side and ride status updates on the rider side.
3. **Live map rendering** — the GPS data is real now; plotting it with `react-native-maps` (mobile) and a live fleet map (admin dashboard) is the remaining visual work.
4. **Background location** on the driver app — currently foreground-only.
5. **Ratings, reviews, cancellation flows.**
6. **Distance-based driver matching** — "nearby requests" currently shows every open ride to every online driver, regardless of actual distance, now that real GPS coordinates exist to filter by.
