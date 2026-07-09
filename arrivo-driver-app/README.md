# Arrivo Driver — Mobile App

The driver-side counterpart to the Arrivo rider app. Same backend, same design system, different app — this is deliberately a **separate app** (its own bundle ID, its own App Store/Play Store listing), the same way Uber Driver is separate from Uber.

## What it does

- **Signup/Login** — always registers as role `driver` against the same `arrivo-backend`
- **Driver profile setup** (required once, before going online) — license number, LASDRI number, vehicle details, spoken languages
- **Dashboard** — online/offline toggle; while online, polls for nearby unassigned ride requests every 8 seconds and lets the driver accept one; while on a trip, shows pickup/stops/rider info with Start Trip / Complete Trip / Cancel actions
- **Earnings** — this month's total, all-time total, completed trip count, and a list of completed trips
- **Profile** — driver + vehicle details, logout

## What's mocked vs. real

Same honesty as the rider app:

| Feature | Status |
|---|---|
| Auth, driver profile, ride accept/status flow | ✅ Real — hits the actual backend, tested end-to-end |
| **Live GPS reporting** | ✅ Added this update — while online, the app reads the phone's GPS every 20 seconds (via `expo-location`) and posts it to the backend, which the rider's tracking screen and admin dashboard can now read. Requires the driver to grant location permission (prompted automatically). |
| "Nearby requests" | 🟡 Shows *all* unassigned rides, not filtered by actual driver distance from the pickup — there's now real location data to filter by, but the matching logic itself isn't built yet. Every online driver currently sees every open request regardless of how far away they are. |
| New-request notification | 🟡 Polling every 8 seconds, not push. Fine for testing; before real drivers use this you'll want push notifications (Firebase Cloud Messaging) so a driver doesn't have to keep the app open and staring at the screen. |
| Live map during a trip | 🟡 Still a stylized placeholder — the *data* (real GPS coordinates) now exists on the backend, so wiring up `react-native-maps` to actually plot it is the remaining piece, not the location tracking itself. |
| Background location | 🟡 GPS only reports while the app is in the foreground. A driver who backgrounds the app while online won't keep reporting position — would need `expo-location`'s background permissions and a background task, which has extra App Store/Play Store review scrutiny worth knowing about upfront. |

## Run it locally

Make sure `arrivo-backend` is already running (see the top-level bundle README) — this app talks to the same backend as the rider app.

```bash
cd arrivo-driver-app
npm install
```

Point it at your backend — same as the rider app, edit `app.json`:

```json
"extra": {
  "apiBaseUrl": "http://192.168.1.XX:4000"
}
```

Then:

```bash
npx expo start
```

Scan with Expo Go on a **different phone (or the same one, logged in as a different account)** than whatever you're using for the rider app — you need two accounts to test a full pickup end to end (one rider, one driver).

## Test the full loop

1. On the **rider app**, book a ride and pay (see the rider app README for the test card).
2. On **this app**, sign up as a driver, complete your profile, flip the toggle to **online**.
3. Within 8 seconds, the ride you just booked should appear under "Nearby requests" — tap **Accept Ride**.
4. Tap **Start Trip**, then **Complete Trip**.
5. Check the **Earnings** tab — the trip's fare should now show up in "This month" and "All-time."
6. Check the rider app's **Activity** tab — the ride's status should now read `completed`.

## Deploying this app

Same process as the rider app (EAS build/submit — see the rider app's README for the full walkthrough), with one difference worth remembering: **this needs its own App Store and Google Play listing**, separate from the rider app, since it's bundled as `com.arrivo.driver` rather than `com.arrivo.app`. Budget for a second $99/year Apple Developer listing under the same account, and a second Play Console listing (no extra $25 fee — one Play Console account covers multiple apps).

## Honest gaps before this is driver-ready

- ~~Driver verification is not enforced~~ **Fixed**: `is_verified` is now enforced server-side. An unverified driver gets a clear 403 if they try to go online, until an admin approves them in the Arrivo Ops Console (`arrivo-admin`).
- ~~No GPS location tracking~~ **Added this update**: the app reports GPS every 20 seconds while online (foreground only — see the background location gap above).
- **No driver-side cancellation penalty or rating from riders yet** — both are reasonable next additions once this loop is running for real.
