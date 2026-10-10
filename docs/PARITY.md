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
