# Arrivo — Mobile App (Starter Build)

A working, cross-platform (iOS + Android) starter app for Arrivo, built with **Expo / React Native**. It implements the core screens and flows discussed: airport pickup booking, multi-stop route planning, live trip tracking with ride-sharing for safety, chauffeur/activity booking, and a vehicle-owner earnings dashboard — plus supporting Activity, Wallet, and Profile tabs.

**What this is:** a real, runnable app you can open on your phone today via Expo Go, with clean navigation, a consistent dark/amber/teal design system, and functional UI (forms, state, navigation, share sheet, mock live countdown).

**What this is not (yet):** connected to a real backend, database, payments processor, or live GPS/maps provider. Those need real API keys and a server, which no one can safely hand you pre-built — see "What's mocked vs real" below.

---

## 1. What's included

```
arrivo-app/
├── App.js                  # Navigation setup (tabs + stack)
├── app.json                 # Expo config (app name, bundle IDs, permissions)
├── eas.json                  # Build/submit profiles for App Store & Play Store
├── babel.config.js
├── package.json
├── .env.example               # Documents required secrets — copy to .env
├── .gitignore
├── theme/
│   └── tokens.js             # Colors, spacing, type — single source of truth
├── components/
│   ├── UI.js                 # Card, Button, Field, Tag
│   └── MapPlaceholder.js     # Stylized route/map view (swap for react-native-maps)
├── screens/
│   ├── HomeScreen.js          # Rider home — airport pickup, ride, chauffeur, owner CTA
│   ├── RouteScreen.js         # Multi-stop route builder + vehicle selection
│   ├── TrackingScreen.js      # Live tracking, driver ID card, share ride, call driver
│   ├── ChauffeurScreen.js     # Book a chauffeur for an activity/event
│   ├── OwnerScreen.js         # Vehicle owner earnings & payout dashboard
│   ├── ActivityScreen.js      # Ride history
│   ├── WalletScreen.js        # Balance & payment method
│   └── ProfileScreen.js       # Account, safety settings, support
└── assets/                    # App icon, splash screen, favicon
```

## 2. What's mocked vs. what's real

| Feature | Status |
|---|---|
| Navigation, screens, forms, state | ✅ Real and working |
| Design system (colors, components) | ✅ Real |
| Share-ride (native share sheet) | ✅ Real — uses the device's actual share sheet |
| Map / route visualization | 🟡 Stylized placeholder — swap for `react-native-maps` + your Google Maps API key |
| Live driver GPS location | 🟡 Mocked countdown timer — needs a backend pushing real coordinates (e.g. via Firebase or WebSockets) |
| Login / accounts | 🟡 Not implemented — needs your auth backend (Firebase Auth, Auth0, or custom) |
| Payments | 🟡 Not implemented — needs Paystack/Flutterwave SDK + a backend to create/verify transactions |
| Driver verification / ID display | 🟡 Static demo data — needs your backend's driver records |
| Push notifications | 🟡 Not implemented — needs Firebase Cloud Messaging setup |

This is intentional: a real backend involves choices only you can make (hosting, database schema, business logic), and API keys that must never be shared or hardcoded by anyone else. The app is structured so each of these slots in cleanly — `.env.example` lists every key you'll need.

---

## 3. Run it locally

```bash
cd arrivo-app
npm install
npx expo start
```

Scan the QR code with **Expo Go** (iOS/Android) to run it on your phone, or press `i` / `a` in the terminal for a simulator/emulator.

---

## 4. GitHub push guide

If this is a brand-new repo:

```bash
cd arrivo-app
git init
git add .
git commit -m "Initial commit — Arrivo starter app"
```

Create an empty repository on GitHub (no README/license, to avoid conflicts), then:

```bash
git branch -M main
git remote add origin https://github.com/<your-username>/arrivo-app.git
git push -u origin main
```

For every change after that:

```bash
git add .
git commit -m "Describe what changed"
git push
```

**Before your first push, double check:**
- `.env` is NOT committed (it's in `.gitignore` — only `.env.example` should be tracked)
- No API keys are hardcoded in any `.js` file
- `google-play-service-account.json` and any `.jks`/`.p8`/`.p12` signing files are excluded (already in `.gitignore`)

**Recommended branch model** as you add engineers:
- `main` — always deployable
- `develop` — integration branch
- `feature/<name>` — one branch per feature, merged via Pull Request
- Require at least one review before merging into `main`

---

## 5. Deploying to the App Store & Google Play

This app uses **EAS (Expo Application Services)** to build and submit — no need for a local Mac/Xcode install for Android, and a much simpler iOS path than raw native tooling.

### One-time setup

```bash
npm install -g eas-cli
eas login
eas build:configure
```

This links the project to your Expo account and fills in the `projectId` in `app.json`.

### Accounts you'll need before submitting
- **Apple Developer Program** — $99/year, required for App Store
- **Google Play Console** — $25 one-time, required for Play Store
- Both require your **CAC-registered business entity** details (from your earlier roadmap) as the account owner for a company-owned app listing

### Build the app

```bash
# iOS build (creates an .ipa, handled in Apple's cloud — no Mac needed)
eas build --platform ios --profile production

# Android build (creates an .aab for Play Store)
eas build --platform android --profile production
```

EAS will prompt to generate/manage signing credentials (iOS provisioning profile + certificate, Android keystore) automatically and store them securely — you don't have to handle certificate files by hand.

### Submit to the stores

Fill in your real IDs in `eas.json` under `submit.production` first (Apple ID, App Store Connect app ID, Apple Team ID, and a Google Play service account JSON key), then:

```bash
eas submit --platform ios
eas submit --platform android
```

### Store listing checklist
- App name, screenshots (use the app-screens mockups as a starting point, replace with real device screenshots), description, keywords
- Privacy policy URL (required — you'll need this drafted given NDPR compliance)
- Content rating questionnaire
- Data safety / App Privacy disclosure (what data you collect: location, contact info, payment info)
- Support URL/email

### After approval
- iOS review typically takes 1–3 days; flag clearly in your review notes that this is a licensed ride-hailing/pickup service (reviewers scrutinize these — have your Lagos operator permit documentation ready if asked)
- Google Play review is usually faster but also checks for permissions justification (location, especially background location if you add it later)

---

## 6. DevSecOps best practices for this project

**Secrets management**
- Never commit `.env`, API keys, signing certs, or service account JSON files — all pre-configured in `.gitignore`
- Store production secrets in EAS Secrets (`eas secret:create`) or GitHub Actions encrypted secrets, not in the repo
- Rotate any key immediately if it's ever accidentally committed (assume it's compromised the moment it's pushed)

**Dependency hygiene**
- Run `npm audit` regularly; fix or explicitly accept-and-document any high/critical findings
- Keep Expo SDK and React Native updated — old versions accumulate unpatched CVEs
- Use `npm ci` (not `npm install`) in CI/CD so builds are reproducible from `package-lock.json`

**CI/CD pipeline** (e.g. GitHub Actions)
- On every PR: run linting, type checks (if you add TypeScript later), and any unit tests
- On merge to `main`: trigger an EAS build automatically for internal testing (`preview` profile)
- Only trigger `production` builds/submissions manually or on tagged releases, with a human approval step

**Code review & branch protection**
- Require PR review before merging to `main`
- Enable required status checks (tests/lint must pass) before merge is allowed
- No direct pushes to `main`

**Data protection (NDPR-specific, given your Nigerian user base)**
- Encrypt sensitive data (rider/driver PII, payment tokens) at rest and in transit (HTTPS everywhere, no exceptions)
- Minimize what you collect — don't store more location history or personal data than the feature actually needs
- Have a documented data retention and deletion policy, and a way for users to request their data be deleted

**Monitoring & incident response**
- Add crash reporting (Sentry — already stubbed in `.env.example`) before your first real user
- Log security-relevant events (failed logins, payment failures) somewhere you'll actually review
- Have a basic incident response plan: who gets paged if the app or backend goes down, and how you communicate to users

**Mobile-specific**
- Enable certificate pinning or at least strict HTTPS once you have a real backend, to reduce man-in-the-middle risk on rider/driver location data
- Don't log sensitive data (tokens, full card numbers, precise location) to device console logs in production builds
- Use Expo's `app.json` `ios.infoPlist` permission strings (already included) so location access requests are clear to users and app reviewers

---

## 7. Suggested next steps

1. `npm install` and run it locally to see all the screens working.
2. Push to GitHub using the guide above.
3. Start building the real backend (Node.js/Django + PostgreSQL, per your earlier tech stack) and wire up one screen at a time, starting with driver/vehicle data on the Owner dashboard.
4. Swap `MapPlaceholder` for `react-native-maps` once you have a Google Maps API key.
5. Add authentication before adding payments — you'll need real user identity first.
