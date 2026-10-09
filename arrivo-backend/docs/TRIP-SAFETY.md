# Trip safety

Four features, each behind its own rules. Two have an on/off switch (both OFF by default); the other two are always on.

| Feature | Switch | Default |
|---|---|---|
| Pickup PIN | `safety_pickup_pin_required` | off |
| Driver selfie check | `safety_selfie_required` | off |
| Expiring share links | none, always on | on |
| Two-way complaints | none, always on | on |

Switches are in the admin app under Safety, and each asks for confirmation.

## Pickup PIN

The rider sees a 4 digit PIN; the driver types it to start the trip. Only ArrivoExpress rides are checked.

- The PIN is derived (HMAC of ride id and a nonce with `PICKUP_PIN_SECRET`, falling back to `JWT_SECRET`). It is not stored.
- 5 wrong tries lock the ride for 10 minutes.
- Admin can override with a written reason of 10+ characters. Every override is audited.
- Gate: `PATCH /api/rides/:id/status` to `in_progress` returns 403 `PICKUP_PIN_REQUIRED`.
- **Do not switch on until the rider app and driver app versions that show and ask for the PIN are released**, or drivers on old versions cannot start trips.

## Share links

- Links are random tokens, stored only as a SHA-256 hash.
- They expire `SHARE_LINK_MAX_HOURS` after creation (after pickup time for booked-ahead rides), and `SHARE_LINK_GRACE_MINUTES` after the trip ends.
- The rider can stop sharing at any time; every link dies immediately. Max 5 active links per ride (the oldest is retired).
- Live location shows only while the ride is accepted or in progress. After that a link shows status only. The driver's phone is never shown.
- The old permanent `rides.share_token` still works but obeys the same end-of-trip rule.
- `GET /api/rides/:id/share` (old apps) now mints a fresh expiring link on each call. New apps use `POST /api/safety/rides/:id/share`.

## Driver selfie check

The driver takes a selfie while showing a code (changes every 15 minutes) so an old photo cannot be reused.

- **Honest limit:** review is manual. An admin compares the selfie with the profile photo. There is no automatic face matching until a vendor (Smile ID, Prembly or similar) is added; `decideFromScore()` in `services/driverSelfie.js` is where a vendor score plugs in (85+ approve, under 50 reject, between goes to a person).
- A pending selfie counts as allowed for `SELFIE_VALID_HOURS`. A rejected one blocks until a new one is sent. Admin can force a re-check, which also takes the driver offline.
- Gate: `PATCH /api/drivers/status` going online returns 403 `SELFIE_REQUIRED`.
- Needs a new driver app build (camera). Switch on only after it is released.

## Complaints

A rider can report their driver, and a driver can report their rider, about one ride.

- Who is accused comes from the ride, never from the request. The accused sees nothing.
- Open from when a driver is assigned until 72 hours after the trip ends. Up to 10 a day per person. 10 to 1000 characters, optional photo.
- Urgent reasons get a 1 hour response target and an email to `SAFETY_ALERT_EMAIL`; others get 24 hours.
- 2 or more different riders filing urgent reports on one driver within 14 days pauses that driver's Express automatically. A person reviews it. Riders are never auto-restricted.
- Admin actions: none, warn, pause driver, resume driver, require selfie, restrict rider, unrestrict rider. The filer gets a push when the report is closed.
- A paused driver cannot turn Express back on (`EXPRESS_PAUSED`); a restricted rider cannot book Express (`EXPRESS_RESTRICTED`).

## Endpoints

Rider and driver: `/api/safety/...` (see the header of `routes/safety.js`). Admin: `/api/admin/safety/...` (see `routes/adminSafety.js`). Audit trail: table `safety_events`.

## Environment

`PICKUP_PIN_SECRET`, `SHARE_LINK_MAX_HOURS`, `SHARE_LINK_GRACE_MINUTES`, `SELFIE_VALID_HOURS`, `SAFETY_ALERT_EMAIL` (see `.env.example`).
