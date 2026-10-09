# App and backend parity

Backend changes made only because an app feature strictly needs them. Each one
lives on its own branch so the payments and auth work can move separately. The
payments and auth files are not touched here.

Shipped app builds stay installed (there is no OTA and no minimum-version gate),
so every backend change in this list is additive: new fields are optional and
old builds keep working.

| Backend change | Branch | Used by | Safe for old app builds |
| --- | --- | --- | --- |
| `on_the_go_requests` gets `requested_pickup_at`, `details`, `source_service` (nullable). `POST /api/on-the-go` accepts optional `requestedPickupAt`, `details`, `service`, validated in `services/onTheGoRequest.js`. | `feat/late-request-backend` | Rider app: late booking notice passes the entered trip to On the Go | Yes. Old builds send none of the fields. |
| New public `GET /api/config/booking`: `minHours`, `standardMinHours`, `maxAdvanceDays`, `support` contacts, and the caller's `app.minVersion` and `storeUrl`. New middleware `appVersionGate` reads `X-App-Name`, `X-App-Version`, `X-App-Platform` and answers 426 `app_update_required` below `MIN_APP_VERSION_RIDER` or `MIN_APP_VERSION_DRIVER`. Sets `req.appClient`. Nothing is blocked unless a minimum is configured. | `feat/app-config-backend` (stacked on `feat/late-request-backend`) | Rider app (`feat/booking-config-app`) and driver app (`feat/version-gate-driver-app`) | Yes. Builds with no headers are never blocked. |

## Constants that must match

| Rule | App | Backend |
| --- | --- | --- |
| Standard booking blocked under 12 hours | `arrivo-app/utils/bookingWindow.js` `ON_THE_GO_ONLY_HOURS` | `arrivo-backend/services/bookingWindow.js` `ON_THE_GO_ONLY_HOURS` (parity test in `bookingWindow.test.js`) |

The Forms apps (Removals, Boat, Air) and the website `late-request.js` carry the
same 12 hour value in their own repos.

## Deploy order

Backend first, then the app build. The app works against a backend without the
new columns only if it is not sent the new fields, so do not ship the app build
before the backend is deployed.

## App version gate: what it can and cannot do

Builds already on phones send no version headers, and there is no over-the-air
update, so they can never be told to update by this gate. They show up as
`req.appClient.known === false`. Once most users are on a build that sends the
headers, a route can refuse unversioned clients. That is the path to enforcing
the token on payment initialize. This work does not touch payments or auth
files; the payments project decides when and where to use `req.appClient`.

Roll out in this order: ship the apps that send the headers, set
`APP_VERSION_GATE_MODE=log` and a `MIN_APP_VERSION_*` to see who would be
blocked, then switch to enforce.
