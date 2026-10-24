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
| New table `service_requests`; routes under `/api/service-requests` (rider create/list/cancel, driver jobs, staff queue and confirm). Rules in `services/serviceRequests.js`. | `feat/six-tier-micro-apps` | Rider app: ArrivoAir, ArrivoBoat, ArrivoRemovals request and status screens. Driver app: assigned jobs on the dashboard. | Yes. New table and routes only. |
| New table `driver_subscription_days`, columns `drivers.last_inspection_on` and `drivers.last_inspection_by`; routes under `/api/driver-subscription`; `PATCH /api/admin/drivers/:id/inspection`. Rules in `services/driverSubscription.js`. | `feat/six-tier-micro-apps` | Driver app dashboard: subscription card, red inspection reminder, today's trips and earnings. | **No for old driver builds.** Unsubscribed drivers get no orders, no queue and cannot go online (HTTP 402, code `SUBSCRIPTION_REQUIRED`). Set `DRIVER_SUBSCRIPTION_ENFORCED=false` until drivers have the new build. |
| Column `users.home_address`; `PATCH /api/auth/me` accepts `homeAddress` and now rejects an empty or over-long `name`. | `feat/six-tier-micro-apps` | Rider app Profile: My details card. | Yes. Old builds never send `homeAddress`. |

## Constants that must match

| Rule | App | Backend |
| --- | --- | --- |
| Options, labels and limits for ArrivoAir, ArrivoBoat, ArrivoRemovals | `arrivo-app/tiers/requestTiers.js`, `arrivo-driver-app/tiers/jobs.js` | `arrivo-backend/services/serviceRequests.js` `TIERS` (parity test in `services/appParity.test.js`) |
| Standard booking blocked under 3 hours | `arrivo-app/utils/bookingWindow.js` `ON_THE_GO_ONLY_HOURS` | `arrivo-backend/services/bookingWindow.js` `ON_THE_GO_ONLY_HOURS` (parity test in `bookingWindow.test.js`) |

The Forms apps (Removals, Boat, Air) and the website `late-request.js` carry the
same 3 hour value in their own repos.

## Driver subscription

- Price is `DAILY_PRICE_NAIRA` (2,000) in `arrivo-backend/services/driverSubscription.js`. The server checks that Paystack confirms exactly that amount in NGN.
- A subscription is one Lagos calendar day and ends at 00:00 Lagos (23:00 UTC).
- Gated: ArrivoExpress dispatch and accept, `GET /api/rides/available`, `POST /api/rides/:id/accept`, and going online. Going offline is never blocked.
- Inspection is due 3 months after `last_inspection_on`; the reminder is red from 7 days before. It warns only and does not block orders.
- Paystack webhook does not activate a subscription. If the app is closed after paying, the saved reference is confirmed the next time the app opens.

## Deploy order

Backend first, then the app build. The app works against a backend without the
new columns only if it is not sent the new fields, so do not ship the app build
before the backend is deployed.
