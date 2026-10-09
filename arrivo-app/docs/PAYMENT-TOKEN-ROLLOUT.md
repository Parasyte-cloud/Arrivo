# Token and purpose on POST /api/payments/initialize

Three phases. Only phase 1 is in this branch.

| Phase | Where | What | Status |
|---|---|---|---|
| 1 | rider app | Sends `Authorization: Bearer <token>`, `purpose`, and `refId` when a ride exists. Nothing is required of the server. | this branch |
| 2 | backend (payments project) | Accept with or without a token. Log requests without one, and log purpose/refId. Still no rejection. | not started, not this project |
| 3 | backend (payments project) | Require the token. Only after most users are on a phase 1 build, or per route with `req.appClient.known` (unversioned callers are old builds) or a raised `MIN_APP_VERSION_*`. | not started |

## Purposes sent today

| purpose | Screen | refId |
|---|---|---|
| ride | Checkout (card for a booking) | none yet, the ride is created after verify |
| topup | Wallet | none |
| family_topup | Family plan | none |
| overage | Tracking (pay ride overage) | ride id |
| tip | Tracking (tip the driver) | ride id |

## Why nothing breaks
The route destructures only `email` and `amountNaira`, ignores other keys, and does not use requireAuth, so an extra header and extra body keys change nothing. An old build keeps working exactly as before.

## Min-version mechanism
The header-based version gate (X-App-Name / X-App-Version, 426 `app_update_required`, env `MIN_APP_VERSION_*`, `APP_VERSION_GATE_MODE`) is in the app-config branches. Phase 3 should use that, not a guess.
