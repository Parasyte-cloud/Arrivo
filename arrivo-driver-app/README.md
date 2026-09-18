# Arrivo Driver — Driver App

The driver-facing mobile app. Separate app from the rider app on purpose (own bundle ID, own store listing) — same backend, same design system. Expo / React Native.

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

Same pattern as the rider app: `app.json` under `expo.extra` (`apiBaseUrl`, `googleMapsApiKey`, `googleOAuth`, `eas.projectId`). Firebase config is `GoogleService-Info.plist` (iOS).

## Structure

- `screens/` — Dashboard (online/offline toggle, ride requests, active trip), Earnings, Profile, signup/login
- `components/`, `context/`, `services/`, `theme/` — same roles as the rider app
- `tasks/` — background task for GPS reporting while online (`expo-location` + `expo-task-manager`), posts to the backend every ~20s so riders/admin can see live driver position
