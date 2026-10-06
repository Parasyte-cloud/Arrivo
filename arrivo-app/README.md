# Arrivo — Rider App

The rider-facing mobile app. Expo / React Native, talks to `arrivo-backend`.

## Run it

```bash
npm install
npx expo start        # or: npm start
```

Scan the QR code with Expo Go, or `npm run android` / `npm run ios` for a simulator.

## Build & submit (EAS)

```bash
npm run build:android   # or build:ios
npm run submit:android  # or submit:ios
```

Profiles live in `eas.json`.

## Config

All of it lives in `app.json` under `expo.extra`: `apiBaseUrl` (points at the Render-hosted backend), `googleMapsApiKey`, `googleOAuth` client IDs, and `eas.projectId`. Firebase config is `GoogleService-Info.plist` (iOS) — Android's `google-services.json` isn't in this repo, add it locally if you need push notifications on Android.

## Structure

- `screens/` — one folder/file per screen, grouped roughly by flow (booking, tracking, wallet, activity, profile)
- `components/` — shared UI
- `context/` — auth/session state
- `services/` — API client, calls into `arrivo-backend`
- `i18n/` — translations
- `theme/` — colors, typography, shared design tokens
