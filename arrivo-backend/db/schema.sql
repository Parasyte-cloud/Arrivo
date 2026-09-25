-- Arrivo database schema — PostgreSQL.
-- Migrated from the original SQLite version. Two syntax changes account for
-- almost the whole migration: SERIAL instead of AUTOINCREMENT, and now()
-- instead of datetime('now'). Everything else carried over unchanged.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  whatsapp_number TEXT,
  country_of_residence TEXT,
  passport_number TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rider',        -- 'rider' | 'driver' | 'owner' | 'admin' | 'support' (support = read-only admin dashboard access, see scripts/create-support.js)
  agreed_to_terms BOOLEAN NOT NULL DEFAULT false,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  email_verification_token TEXT,
  email_verification_expires TIMESTAMPTZ,
  preferred_language TEXT NOT NULL DEFAULT 'en',  -- 'en' | 'fr' | 'zh'
  reset_token TEXT,
  reset_token_expires TIMESTAMPTZ,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Adds the reset token columns if this table already existed before this
-- update (CREATE TABLE IF NOT EXISTS won't add columns to an existing table).
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country_of_residence TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS passport_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS agreed_to_terms BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;

-- Rider ID verification — previously a dead "Verified ID" label in the app
-- with no real flow behind it (no upload, no status, no review). A rider
-- submits a photo of their ID (id_document_url, same base64-data-URL
-- storage pattern as avatar_url — no cloud storage/file upload service
-- exists yet, see avatar_url above), which puts them in 'pending' for an
-- admin to review (see PATCH /api/admin/riders/:id/verify-id) and approve
-- or reject. Distinct from drivers.is_verified, which is a separate,
-- pre-existing flow gating whether a DRIVER can go online — this is the
-- rider-facing identity check shown on the Profile screen.
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_document_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verification_status TEXT NOT NULL DEFAULT 'unverified'; -- 'unverified' | 'pending' | 'verified' | 'rejected'
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verification_submitted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verification_reviewed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verification_rejection_reason TEXT;

CREATE TABLE IF NOT EXISTS vehicles (
  id SERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  make_model TEXT NOT NULL,
  plate_number TEXT NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'sedan', -- 'sedan' | 'suv' | 'truck' (Executive Vehicle) | 'pickup' (Pickup Truck, cargo)
  seats INTEGER DEFAULT 4,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Free-text availability set by the owner (e.g. "Mon-Fri 6am-9pm, weekends
-- blackout") — a simple note rather than a full scheduling table, since
-- there's no dispatcher/booking-by-availability logic built yet to consume
-- anything more structured.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS availability_note TEXT;

CREATE TABLE IF NOT EXISTS drivers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  license_number TEXT,
  lasdri_number TEXT,
  spoken_languages TEXT NOT NULL DEFAULT 'en',
  is_verified BOOLEAN NOT NULL DEFAULT false,
  is_online BOOLEAN NOT NULL DEFAULT false,
  rating REAL DEFAULT 5.0,
  current_lat DOUBLE PRECISION,
  current_lng DOUBLE PRECISION,
  location_updated_at TIMESTAMPTZ,
  scan_token TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS scan_token TEXT UNIQUE;

-- Added for the comprehensive driver application flow: insurance, vehicle
-- ownership (a driver may not own the car they drive — Arrivo's vehicle-owner
-- program means someone else could), verification photos, and a driver-side
-- emergency contact (the same safety feature riders already have).
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS insurance_number TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_ownership TEXT NOT NULL DEFAULT 'self'; -- 'self' | 'other'
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS owner_whatsapp TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS license_photo_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_photo_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS agreed_background_check BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS rides (
  id SERIAL PRIMARY KEY,
  rider_id INTEGER NOT NULL REFERENCES users(id),
  driver_id INTEGER REFERENCES drivers(id),
  pickup_address TEXT NOT NULL,
  stops TEXT,
  flight_number TEXT,
  vehicle_type TEXT,
  booking_type TEXT NOT NULL DEFAULT 'one_way',
  duration_days INTEGER NOT NULL DEFAULT 1,
  fare_naira INTEGER NOT NULL,
  payment_reference TEXT,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  ride_status TEXT NOT NULL DEFAULT 'requested',
  agreed_cancellation_policy BOOLEAN NOT NULL DEFAULT false,
  tracking_started_at TIMESTAMPTZ,
  admin_notes TEXT,
  panic_triggered_at TIMESTAMPTZ,
  panic_resolved_at TIMESTAMPTZ,
  panic_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE rides ADD COLUMN IF NOT EXISTS agreed_cancellation_policy BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS tracking_started_at TIMESTAMPTZ;

-- Added for Uber-style distance-based pricing and the security escort /
-- fleet accompaniment add-ons. distance_km/duration_min are only populated
-- for one-way bookings priced by real route distance — day/week/month
-- bookings stay flat-rate and leave these null.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS distance_km NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS duration_min NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS security_escort BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS fleet_size INTEGER NOT NULL DEFAULT 0;

-- Per-ride safety fields, matching the website's booking form: a contact
-- RideArrivo can reach if the rider can't be reached during the trip, and
-- consent for the in-vehicle dash cam (footage kept 30 days, then deleted).
ALTER TABLE rides ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS dash_cam_consent BOOLEAN NOT NULL DEFAULT false;

-- The rider's post-trip rating of their driver ("Rate & Relax" on the
-- website). Stored on the ride itself rather than a separate ratings
-- table, since it's one rating per completed trip. drivers.rating is
-- recomputed as the average of these whenever a new one comes in.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS rider_rating INTEGER;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS rider_rating_comment TEXT;

-- Expo push token for this user's device, so the backend can send trip
-- status notifications (driver accepted, trip started, trip completed).
-- One token per user — simple last-device-wins, no multi-device fan-out.
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT;

-- "Listening device" toggle — matches the same setting shown on
-- ridearrivo.com's account page. Off by default; a rider opts in.
-- Superseded by the ride-scoped listening_device_* columns below, which
-- match what the website actually does (a one-way safety activation, not
-- a reversible preference). Left in place unused rather than dropped.
ALTER TABLE users ADD COLUMN IF NOT EXISTS audio_recording_enabled BOOLEAN NOT NULL DEFAULT false;

-- "Listening device" — a one-way safety activation per ride, matching
-- ridearrivo.com's real design: either the rider or the driver on a ride
-- can activate it directly, and triggering the panic button activates it
-- automatically too ("one trigger, full response"). There is deliberately
-- no deactivate path from the client — same "no manual reset" rule as
-- panic_triggered_at above; only an admin-cleared flag would close it out,
-- and that doesn't exist yet either.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS listening_device_activated_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS listening_device_via_panic BOOLEAN NOT NULL DEFAULT false;

-- Real pickup/destination coordinates, resolved from Google Place Details
-- when the rider picks an address from autocomplete (see routes/places.js).
-- Used to compute real driving distance/duration for the fare (see
-- services/fare.js + services/googleMaps.js) instead of the old approach
-- of matching keywords in a typed address string against a flat price
-- table. Only pickup + final destination are stored — an intermediate
-- stop doesn't get its own distance leg in this version; the fare is
-- based on the pickup-to-final-destination route.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_lat NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_lng NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS destination_lat NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS destination_lng NUMERIC;

-- ── Wallet ──
-- A rider (or, later, a company on a delegate plan) can hold a balance and
-- pay for rides directly from it, as an alternative to per-trip card
-- payment. Every change to the balance is logged in wallet_transactions —
-- the balance column itself is a cached total, always re-derivable from
-- the transaction log, which is the actual source of truth.
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance_naira NUMERIC NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, -- 'topup' | 'ride_charge' | 'credit' | 'refund' | 'membership_charge' | 'tip' | 'overage'
  status TEXT NOT NULL DEFAULT 'completed', -- 'pending' | 'completed' | 'failed'
  amount_naira NUMERIC NOT NULL, -- positive for topup/credit, negative for charges
  balance_after_naira NUMERIC, -- null while status = 'pending'
  paystack_reference TEXT UNIQUE, -- set for topups; UNIQUE stops the same Paystack payment being credited twice
  ride_id INTEGER REFERENCES rides(id),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id, created_at DESC);

-- ── Memberships ──
-- Two tracks: an individual paying one annual subscription instead of
-- per-trip, and a company subscribing once with multiple delegate riders
-- underneath it. company_account_id is null for the individual plan and
-- for the company's own membership row; delegate riders point it at the
-- company user's id.
CREATE TABLE IF NOT EXISTS memberships (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_type TEXT NOT NULL, -- 'individual_annual' | 'corporate_delegate'
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'cancelled' | 'expired'
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  price_naira NUMERIC NOT NULL,
  company_account_id INTEGER REFERENCES users(id), -- set on a delegate rider, pointing at the company's user row
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_company ON memberships(company_account_id);


CREATE TABLE IF NOT EXISTS waitlist (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  source TEXT DEFAULT 'website',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rides_panic_active
  ON rides (panic_triggered_at)
  WHERE panic_triggered_at IS NOT NULL AND panic_resolved_at IS NULL;

-- "Reserve now, pay at pickup" — DEPRECATED. This used to let a rider
-- reserve a one-way ride and pay the fare later (debited from wallet at
-- the pickup QR scan) instead of at booking. Removed as a product
-- decision: every ride is now paid in full at booking, like a plane
-- ticket, never at the end of the trip. routes/rides.js POST / rejects any
-- new attempt to set pay_at_pickup. The column (and the routes/rides.js
-- scan-time-charge code that reads it) is kept only so any ride that was
-- already reserved-unpaid before this change shipped still settles
-- correctly — it should always be false for anything created afterward.
-- payment_method is still stored on every ride (independent of
-- pay_at_pickup) so it's visible which rail actually settled the fare.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS pay_at_pickup BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS payment_method TEXT;

-- Driver tipping — optional, prompted after a ride is marked 'completed'
-- (alongside the rider-rating prompt). Riders never tip in cash, so this
-- goes through the same rails as the fare itself (wallet debit or a fresh
-- card charge — see POST /api/rides/:id/tip). One tip per ride; tip_naira
-- stays 0 until (and unless) the rider adds one.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip_naira NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip_payment_method TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip_payment_reference TEXT;

-- Airport Drop-off — RideArrivo taking a departing rider FROM their
-- location TO the airport, the mirror image of the existing 'one_way'
-- arrival pickup. booking_type = 'dropoff' is priced with the exact same
-- per-location formula as 'one_way' (see services/fare.js), just kept as
-- its own value so ride history/driver instructions/reporting can tell the
-- two apart. scheduled_pickup_at is required for 'dropoff' bookings (there's
-- no flight-landing event to anchor timing the way an arrival pickup has —
-- the rider tells us directly when they need picking up) and optional for
-- everything else. linked_ride_id optionally pairs a drop-off with the
-- arrival pickup it was booked alongside in the same session (a
-- round-trip-style booking, "if they know their expected time and day of
-- return, book it at once") — display/reporting only, doesn't affect
-- pricing or dispatch.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS scheduled_pickup_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS linked_ride_id INTEGER REFERENCES rides(id);

-- ── Driver/vehicle continuity for return trips ──
-- At "Rate & Relax" after a completed arrival pickup, a rider can say
-- "keep the same driver and vehicle for my return trip." That preference is
-- stored on the RATED ride (keep_same_driver_for_return); when a 'dropoff'
-- ride later gets created with linked_ride_id pointing at this one, the
-- backend copies driver_id/vehicle info across as preferred_driver_id +
-- preferred_vehicle_snapshot (a plain text snapshot like "Toyota Camry —
-- ABC123XY", not a live FK to vehicles, since the driver's assigned vehicle
-- could change between now and then and the snapshot is just informational
-- context for the rider/driver, not something dispatch re-resolves).
-- preferred_driver_id references drivers(id) (not users(id)) to match
-- rides.driver_id's own convention.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS keep_same_driver_for_return BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS preferred_driver_id INTEGER REFERENCES drivers(id);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS preferred_vehicle_snapshot TEXT;
-- Set (and shown to the rider) if a preferred driver couldn't be retained —
-- e.g. the claim window elapsed with no response, or they went offline —
-- so "your driver changed" never arrives as a silent surprise.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_change_reason TEXT;

-- ── Flight cancellation/reschedule handling ──
-- original_flight_scheduled_at captures the flight's scheduled time AT
-- BOOKING TIME (best-effort, from GET /api/flights/status) purely so a
-- later background check can tell "rescheduled" (the time drifted a lot)
-- apart from "always been like this." flight_issue is null until the
-- scheduler (services/scheduler.js) detects a real cancellation/reschedule;
-- once set, PATCH /:id/status re-applies the existing $100-equivalent
-- standing-wallet-balance rule (see MIN_WALLET_BALANCE_USD in routes/rides.js)
-- as a gate on starting the trip, and — since the original upfront charge
-- gets refunded back to the wallet the moment the issue is detected — the
-- actual fare is charged from the wallet again at trip completion instead
-- of having already been settled at booking.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS original_flight_scheduled_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS flight_issue TEXT; -- null | 'cancelled' | 'rescheduled'
ALTER TABLE rides ADD COLUMN IF NOT EXISTS flight_issue_notified_at TIMESTAMPTZ;

-- ── Pickup/drop-off reminders ──
-- One boolean per threshold so the scheduler's periodic sweep (every few
-- minutes) never double-sends a reminder it already fired for a given ride.
-- Applies to both 'dropoff' rides (anchored on scheduled_pickup_at) and
-- 'one_way' rides (anchored on the flight's live estimated/scheduled
-- arrival time, refreshed by the same sweep).
ALTER TABLE rides ADD COLUMN IF NOT EXISTS reminder_5h_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS reminder_3h_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS reminder_1h_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS reminder_now_sent BOOLEAN NOT NULL DEFAULT false;

-- Passenger count (adults/children) and the vehicleCount that was actually
-- charged for (see services/fare.js computeVehicleCount) — a group bigger
-- than one vehicle's seats books multiple of the same vehicle type instead
-- of being blocked, and vehicle_count is what the fare above was multiplied
-- by. Defaults keep every existing/charter ride (which never collected a
-- passenger count) reading as "1 adult, 0 children, 1 vehicle" — accurate
-- for all of them.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS adults INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS children INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS vehicle_count INTEGER NOT NULL DEFAULT 1;

-- ── Chauffeur time-overage charge ──
-- Deliberately scoped to single-day Chauffeur ('full_day', duration_days = 1)
-- bookings ONLY. One-way/drop-off trips are flat-rate per zone regardless of
-- how long they actually take (that's an explicit product promise — "pay in
-- full now, never surprised later" — see CheckoutScreen's payment copy) and
-- multi-day/full_week/full_month charters have no per-day hour figure to
-- compare against, so neither gets this. included_hours_per_day is the
-- number of hours the rider selected on the Chauffeur Booking screen at
-- booking time (previously collected but never actually sent to the
-- backend — it only appeared in the on-screen booking summary label).
-- completed_at + tracking_started_at (already existed, set when the driver
-- taps Start Trip) give the real elapsed time; if it exceeds
-- included_hours_per_day by more than a small grace window, PATCH
-- /:id/status computes overage_naira automatically when the ride is marked
-- completed (see routes/rides.js). Riders never pay this in cash — same
-- wallet-debit-or-fresh-card-charge rails as tipping, see POST
-- /api/rides/:id/overage-charge. One overage charge per ride, same
-- "stays 0 until set" pattern as tip_naira.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS included_hours_per_day NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS overage_naira NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS overage_payment_method TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS overage_payment_reference TEXT;

-- ── Google / Apple sign-in ──
-- Nullable, unique per provider so the same Google/Apple account always
-- resolves back to the same RideArrivo user on future sign-ins. An account
-- created this way still gets a random bcrypt password_hash (same pattern
-- as the guest-checkout flow in POST /api/auth/guest) so password_hash can
-- stay NOT NULL — nobody ever needs to know or use that password. If
-- someone signs in with Google/Apple using the same email as an existing
-- password account, that account gets linked (the provider id column gets
-- set on it) rather than creating a second, duplicate account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id TEXT UNIQUE;

-- ── Shared live-tracking link ──
-- Lets a rider (or driver) generate a read-only tracking link for someone
-- who isn't a RideArrivo account at all — the per-ride emergency contact,
-- a family member, anyone. Previously "Share ride" only opened the OS share
-- sheet with a plain descriptive text message, no link — the person it was
-- sent to had no way to actually see the trip, since track.html otherwise
-- requires the rider's own login token. share_token is generated lazily
-- (see GET /api/rides/:id/share) the first time a share link is requested
-- for a given ride, not at booking time, so most rides never need one.
-- Deliberately never expires or gets revoked in this version — same
-- lifetime as the ride record itself, matching how the rider's own
-- track.html?ride=id link already works with no expiry either.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS share_token TEXT UNIQUE;

-- ── Locked USD quote at booking ──
-- Real USD charging (Paystack settling in USD, not just naira) needs
-- Paystack's merchant account itself to have USD/multi-currency enabled —
-- a business-side request to Paystack, not something this codebase can
-- turn on by itself. Until that's confirmed, every fare is still charged
-- in naira (see PAYSTACK_SECRET_KEY usage in routes/payments.js), same as
-- always. What CAN ship now: instead of a foreign rider only ever seeing a
-- live-recomputed "$ estimate" that can silently drift if the FX rate
-- moves between booking and looking at their receipt later, snapshot the
-- USD figure and the rate used for it at the exact moment the ride is
-- booked. quoted_usd_amount/quoted_ngn_per_usd are the real, permanent
-- record of "here's the USD price we actually showed this rider" — the
-- foundation to flip on real USD settlement later without changing how
-- any of this is displayed. Null for rides created before this shipped.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS quoted_usd_amount NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS quoted_ngn_per_usd NUMERIC;

-- ── Fleet Accompaniment — real convoy dispatch ──
-- fleet_size (added earlier, see the security_escort/fleet_size block
-- above) was only ever a priced integer on the ONE ride the rider booked
-- and paid for — no additional vehicle ever actually got created or
-- dispatched, no driver ever saw they were part of a fleet, and admin had
-- no visibility into it at all. It worked exactly like security_escort:
-- a priced checkbox, not real coordination.
--
-- fleet_group_id fixes that: when a ride is booked with fleetSize 2 or 3,
-- POST /api/rides now inserts that many ADDITIONAL ride rows — the
-- companion escort vehicles — each pointing fleet_group_id back at the
-- primary (rider-paid) ride's id. Companions have fare_naira = 0 (already
-- covered by the primary's flat fleet surcharge) and payment_status =
-- 'paid' immediately, but otherwise flow through the exact same
-- driver-acceptance queue, status transitions, and tracking as any normal
-- ride — a real driver has to actually accept and drive each one.
-- is_fleet_companion distinguishes a companion row from the primary at a
-- glance (the primary also has fleet_group_id set to ITS OWN id once
-- companions exist, so "SELECT * WHERE fleet_group_id = X" always returns
-- the whole convoy including the primary, without a separate self-join).
ALTER TABLE rides ADD COLUMN IF NOT EXISTS fleet_group_id INTEGER REFERENCES rides(id);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS is_fleet_companion BOOLEAN NOT NULL DEFAULT false;

-- ── Fleet Accompaniment — escort driver payout ──
-- Companion rides above always have fare_naira = 0 (the rider already paid
-- the whole convoy surcharge on the primary ride), which meant an escort
-- driver's own trip carried zero recorded earnings anywhere — real driving
-- work with no ledger entry. Business decision (Jul 2026): a flat
-- $100-equivalent payout per completed escort trip, computed once at
-- completion (see routes/rides.js PATCH /:id/status) and stored here so it
-- shows up in that driver's earnings the same way fare_naira/tip_naira do.
-- Null for rides that aren't fleet companions, or that completed before
-- this shipped.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS escort_payout_naira NUMERIC;

-- ── Cross-subsystem payment-reference ledger ──
-- Ride card payment, ride tips, ride overage charges, and wallet top-ups
-- each independently re-verify a client-supplied Paystack reference
-- against Paystack and the amount expected — but a real, once-successful
-- Paystack reference stays "successful" forever, so nothing stopped the
-- SAME reference being presented a second time to a DIFFERENT one of
-- those four flows (pay a ride, then top up the wallet with that same
-- already-spent reference, or vice versa) and getting credited again for
-- free. This table is the single source of truth closing that hole: every
-- one of those four flows claims its reference here, inside the same DB
-- transaction as the row it's about to mark paid, via
-- INSERT ... ON CONFLICT (reference) DO NOTHING (see
-- services/paymentReferences.js). The UNIQUE constraint makes the claim
-- itself atomic even under two simultaneous requests racing with the same
-- reference — a plain SELECT-then-UPDATE check can't guarantee that.
CREATE TABLE IF NOT EXISTS used_payment_references (
  id SERIAL PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  used_for TEXT NOT NULL, -- 'ride_payment' | 'ride_tip' | 'ride_overage' | 'wallet_topup'
  ride_id INTEGER REFERENCES rides(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Saved emergency contacts ──
-- Previously a rider retyped an emergency contact's name/phone from scratch
-- on every single booking (see rides.emergency_contact_name/phone, set at
-- booking time on RouteScreen). This is the Profile-level "Emergency
-- contacts" feature: a rider saves one or more contacts once, reusable
-- across every future booking (RouteScreen now pre-fills the per-ride field
-- from the first saved contact, still editable per-trip). Deliberately its
-- own table rather than columns on `users` since a rider can have more than
-- one.
CREATE TABLE IF NOT EXISTS emergency_contacts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  relationship TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emergency_contacts_user ON emergency_contacts(user_id, created_at);

-- ── Ride-sharing preferences ──
-- Standing defaults a rider sets once on their Profile — previously
-- "Ride-sharing preferences" was a label on Profile with nothing behind it
-- at all. These are plain columns on `users` (unlike emergency contacts,
-- there's exactly one set per rider, not a list). Note: these are stored
-- and shown back to the rider, but booking screens don't yet read them to
-- auto-apply a default vehicle type or pass the others to the driver —
-- that's a natural next step, kept separate so this can ship on its own.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_vehicle_type TEXT; -- 'sedan' | 'suv' | 'truck' | null (no preference)
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_ride BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temperature_preference TEXT; -- 'cool' | 'warm' | null (no preference)
ALTER TABLE users ADD COLUMN IF NOT EXISTS child_seat_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS traveling_with_pet BOOLEAN NOT NULL DEFAULT false;

-- Set when someone deletes their account. The row stays because nine tables
-- reference users(id) and the retention policy keeps transactional records
-- for seven years, so the person is stripped out instead of the row going.
-- Anything reading users for a live person has to exclude these.
-- Handed back by Apple when we exchange the authorization code at sign-in.
-- Deleting an account has to revoke the Apple authorization, and this is the
-- only thing that can be revoked with. Null for anyone who signed in with
-- Apple before we started collecting it, and for everybody else.
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_refresh_token TEXT;
-- Which Apple client the refresh token above was issued to. Rider and driver
-- are separate clients, and Apple requires revocation to use the same client
-- id as the original authorization, so one global setting cannot serve both.
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_client_id TEXT;
-- Set while a deletion is running and cleared if it is abandoned. Deleting
-- spans an external call to Apple and a database transaction, which cannot be
-- atomic together, so this marks the account as in progress: mutations are
-- refused meanwhile and an interrupted deletion can be retried rather than
-- leaving a live account whose Apple authorization is already revoked.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_started_at TIMESTAMPTZ;
-- Set the moment Apple confirms the authorization is revoked, which happens
-- before the scrub. If the scrub then fails and the person tries again, this
-- is what stops us revoking a second time: Apple rejects an already revoked
-- token, we would read that as a hard failure, and they could never finish
-- deleting.
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_revoked_at TIMESTAMPTZ;

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);

-- ── Support tickets ──
-- Support used to be an email link and a list of FAQs, so a rider had no way
-- to tell us what was actually wrong and we had nothing on file. This is what
-- the form on the Support screen writes to.
-- ride_id is the trip they're on if one is live, otherwise the last one they
-- booked. We store the id at submit time so support isn't stuck asking
-- "which trip?". Stays null for a rider who has never booked anything, which
-- is a normal case, not an error.
CREATE TABLE IF NOT EXISTS support_tickets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ride_id INTEGER REFERENCES rides(id),
  type TEXT NOT NULL, -- 'complaint' | 'inquiry' | 'support'
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'closed'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, created_at);


-- ── Support-assisted bookings ──
--
-- A trusted RideArrivo Workspace employee may create a booking for an
-- existing Arrivo rider without ever receiving or impersonating the
-- rider's password/JWT.
--
-- actor_employee_id is the Workspace employee UUID.
-- rider_id is the Arrivo users.id INTEGER.
--
-- actor_request_id is the signed Workspace actor JWT jti and provides
-- a second replay boundary in addition to the client idempotency key.

CREATE TABLE IF NOT EXISTS support_assisted_bookings (
  id SERIAL PRIMARY KEY,
  -- Bound only after verified customer payment creates the real ride.
  ride_id INTEGER UNIQUE
    REFERENCES rides(id) ON DELETE RESTRICT,
  rider_id INTEGER NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  actor_employee_id UUID NOT NULL,
  actor_role TEXT NOT NULL
    CHECK (actor_role IN ('support','admin')),
  actor_request_id UUID NOT NULL UNIQUE,
  idempotency_key UUID NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  source TEXT NOT NULL DEFAULT 'support_assisted'
    CHECK (source = 'support_assisted'),
  payment_method TEXT NOT NULL DEFAULT 'card'
    CHECK (payment_method = 'card'),
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      payment_status IN (
        'pending',
        'paid',
        'failed',
        'cancelled'
      )
    ),
  -- Set once a Paystack payment link has been generated for this booking
  -- (see POST /:id/payment-link). NULL until then. UNIQUE for the same
  -- reason payment_reference is unique everywhere else in this schema --
  -- the webhook looks a payment up by reference alone, so two rows must
  -- never be able to share one.
  payment_reference TEXT UNIQUE,
  -- Stored alongside payment_reference so the same link can be re-sent
  -- (customer lost the WhatsApp message, wants it emailed too) without
  -- ever calling Paystack /transaction/initialize a second time for the
  -- same booking. Paystack only returns authorization_url at initialize
  -- time -- there's no later "look up the URL for this reference" call --
  -- so if this weren't stored, a resend would have to mint a second,
  -- different reference, and a customer who still pays via the FIRST
  -- (now-orphaned) link would have a real, successful charge that this
  -- system could never bind back to a ride.
  payment_link_url TEXT,
  payment_link_sent_at TIMESTAMPTZ,
  payment_status_at_creation TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status_at_creation = 'pending'),
  booking_request JSONB NOT NULL
    CHECK (jsonb_typeof(booking_request) = 'object'),
  fare_naira INTEGER NOT NULL
    CHECK (fare_naira > 0),
  quoted_ngn_per_usd NUMERIC(14,4) NOT NULL
    CHECK (quoted_ngn_per_usd > 0),
  quoted_usd_amount NUMERIC(14,2) NOT NULL
    CHECK (quoted_usd_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS
  idx_support_assisted_bookings_rider
ON support_assisted_bookings(
  rider_id,
  created_at
);

CREATE INDEX IF NOT EXISTS
  idx_support_assisted_bookings_actor
ON support_assisted_bookings(
  actor_employee_id,
  created_at
);


-- ── On-the-Go requests ──
-- The quick path for someone who needs a car within 12 hours and hasn't got
-- time for the full Plan Route flow. Only the essentials, no vehicle choice,
-- no escort or fleet extras.
--
-- Deliberately its own table and NOT a row in `rides`. A ride has to be paid
-- for before it exists (see the payment checks in POST /api/rides), and this
-- form has no payment step by design, so it can't be a ride yet. It's a
-- request that ops picks up, confirms a driver for, and takes payment on. Once
-- that happens they link the ride they created back here via ride_id.
--
-- Keeping it separate is also what makes "priority queue" mean anything. These
-- don't sit in the normal driver claim queue at all, ops works this list
-- directly.
CREATE TABLE IF NOT EXISTS on_the_go_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pickup_address TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  flight_number TEXT,
  passenger_count INTEGER NOT NULL DEFAULT 1,
  contact_phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'confirmed' | 'cancelled'
  ride_id INTEGER REFERENCES rides(id),   -- set once ops turns this into a real booking
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Ops works the pending list oldest first, so that's the index that matters.
CREATE INDEX IF NOT EXISTS idx_on_the_go_status ON on_the_go_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_on_the_go_user ON on_the_go_requests(user_id, created_at);


-- ============================================================
-- ARRIVONOW_FOUNDATION_V1
-- Isolated on-demand ride dispatch foundation.
--
-- Existing RideArrivo bookings remain "scheduled".
-- Drivers remain excluded from ArrivoNow unless explicitly enabled.
-- No ArrivoNow request becomes a canonical rides row until matching.
-- ============================================================

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS service_mode TEXT NOT NULL DEFAULT 'scheduled';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'rides_service_mode_check'
       AND conrelid = 'rides'::regclass
  ) THEN
    ALTER TABLE rides
      ADD CONSTRAINT rides_service_mode_check
      CHECK (service_mode IN ('scheduled', 'instant'));
  END IF;
END
$$;

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS accepts_instant BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS instant_ride_requests (
  id SERIAL PRIMARY KEY,

  rider_id INTEGER NOT NULL REFERENCES users(id),

  pickup_address TEXT NOT NULL,
  pickup_lat NUMERIC(10, 7) NOT NULL,
  pickup_lng NUMERIC(10, 7) NOT NULL,

  destination_address TEXT NOT NULL,
  destination_lat NUMERIC(10, 7) NOT NULL,
  destination_lng NUMERIC(10, 7) NOT NULL,

  vehicle_type TEXT,

  estimated_fare_naira INTEGER,
  estimated_distance_km NUMERIC(10, 2),
  estimated_duration_min INTEGER,

  status TEXT NOT NULL DEFAULT 'searching',

  matched_driver_id INTEGER REFERENCES drivers(id),
  ride_id INTEGER REFERENCES rides(id),

  expires_at TIMESTAMPTZ NOT NULL
    DEFAULT (now() + INTERVAL '5 minutes'),

  matched_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT instant_ride_requests_status_check
    CHECK (
      status IN (
        'searching',
        'offering',
        'matched',
        'cancelled',
        'expired'
      )
    )
);

CREATE TABLE IF NOT EXISTS instant_ride_offers (
  id SERIAL PRIMARY KEY,

  request_id INTEGER NOT NULL
    REFERENCES instant_ride_requests(id)
    ON DELETE CASCADE,

  driver_id INTEGER NOT NULL REFERENCES drivers(id),

  status TEXT NOT NULL DEFAULT 'offered',

  distance_to_pickup_km NUMERIC(10, 2),
  eta_to_pickup_min INTEGER,

  offered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,

  responded_at TIMESTAMPTZ,

  CONSTRAINT instant_ride_offers_status_check
    CHECK (
      status IN (
        'offered',
        'accepted',
        'declined',
        'expired',
        'lost'
      )
    ),

  CONSTRAINT instant_ride_offers_request_driver_unique
    UNIQUE (request_id, driver_id)
);

CREATE INDEX IF NOT EXISTS
  idx_instant_ride_requests_rider_status
ON instant_ride_requests (
  rider_id,
  status,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  idx_instant_ride_requests_dispatch
ON instant_ride_requests (
  status,
  expires_at,
  created_at
);

CREATE INDEX IF NOT EXISTS
  idx_instant_ride_offers_driver_status
ON instant_ride_offers (
  driver_id,
  status,
  expires_at
);

CREATE INDEX IF NOT EXISTS
  idx_instant_ride_offers_request_status
ON instant_ride_offers (
  request_id,
  status,
  expires_at
);

CREATE INDEX IF NOT EXISTS
  idx_drivers_arrivonow_dispatch
ON drivers (
  accepts_instant,
  is_online,
  is_verified,
  location_updated_at
);

-- ============================================================
-- END ARRIVONOW_FOUNDATION_V1
-- ============================================================


-- ============================================================
-- ARRIVONOW_WALLET_LIFECYCLE_V1
--
-- ArrivoNow payment is secured before dispatch begins.
-- Wallet funds are refunded if an unmatched request is cancelled
-- or expires before a canonical RideArrivo ride is created.
-- ============================================================

ALTER TABLE instant_ride_requests
  ADD COLUMN IF NOT EXISTS payment_method TEXT;

ALTER TABLE instant_ride_requests
  ADD COLUMN IF NOT EXISTS payment_status TEXT
  NOT NULL DEFAULT 'unpaid';

ALTER TABLE instant_ride_requests
  ADD COLUMN IF NOT EXISTS payment_reference TEXT;

ALTER TABLE instant_ride_requests
  ADD COLUMN IF NOT EXISTS wallet_transaction_id INTEGER
  REFERENCES wallet_transactions(id);

ALTER TABLE instant_ride_requests
  ADD COLUMN IF NOT EXISTS refund_wallet_transaction_id INTEGER
  REFERENCES wallet_transactions(id);

ALTER TABLE instant_ride_requests
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname =
       'instant_ride_requests_payment_method_check'
       AND conrelid =
         'instant_ride_requests'::regclass
  ) THEN
    ALTER TABLE instant_ride_requests
      ADD CONSTRAINT
        instant_ride_requests_payment_method_check
      CHECK (
        payment_method IS NULL
        OR payment_method IN ('wallet', 'card')
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname =
       'instant_ride_requests_payment_status_check'
       AND conrelid =
         'instant_ride_requests'::regclass
  ) THEN
    ALTER TABLE instant_ride_requests
      ADD CONSTRAINT
        instant_ride_requests_payment_status_check
      CHECK (
        payment_status IN (
          'unpaid',
          'pending',
          'paid',
          'refunded'
        )
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_instant_requests_wallet_transaction
ON instant_ride_requests (wallet_transaction_id)
WHERE wallet_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_instant_requests_refund_transaction
ON instant_ride_requests (refund_wallet_transaction_id)
WHERE refund_wallet_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_instant_requests_one_unconverted_rider
ON instant_ride_requests (rider_id)
WHERE status IN ('searching', 'offering', 'matched')
  AND ride_id IS NULL;

-- ============================================================
-- END ARRIVONOW_WALLET_LIFECYCLE_V1
-- ============================================================


-- ============================================================
-- ARRIVONOW_TIERS_V1
--
-- Rider-facing vehicle tiers (Economy/Comfort/XL/Premium — see
-- services/instantTiers.js) and the real distance+time metered fare that
-- replaced reusing RideArrivo's flat airport-transfer pricing for
-- ArrivoNow quotes (see services/instantFare.js). tier is a
-- labelling/pricing concern; vehicle_type is still what actually gets
-- matched against a driver's vehicle in services/instantDispatch.js.
-- ============================================================

ALTER TABLE instant_ride_requests
  ADD COLUMN IF NOT EXISTS tier TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'instant_ride_requests_tier_check'
       AND conrelid = 'instant_ride_requests'::regclass
  ) THEN
    ALTER TABLE instant_ride_requests
      ADD CONSTRAINT instant_ride_requests_tier_check
      CHECK (tier IS NULL OR tier IN ('economy', 'comfort', 'xl', 'premium'));
  END IF;
END
$$;

-- Minimum seats a matched vehicle must have — how the XL tier is
-- distinguished from Comfort despite both using vehicle_type = 'suv'.
-- Defaults to 1 (no extra requirement) for every other tier.
ALTER TABLE instant_ride_requests
  ADD COLUMN IF NOT EXISTS min_seats INTEGER NOT NULL DEFAULT 1;

-- Itemised base/distance/time/zone breakdown for the rider's receipt — the
-- same "itemised digital receipt" pattern called out in the Uber teardown
-- brief (Payments, Ratings & Loyalty section).
ALTER TABLE instant_ride_requests
  ADD COLUMN IF NOT EXISTS fare_breakdown JSONB;

-- ============================================================
-- END ARRIVONOW_TIERS_V1
-- ============================================================

-- ============================================================
-- ARRIVO EXPRESS PHASE 1 (2026-09-17 engineering brief)
-- Ride Guarantee, Fair Fare, Family Plan
-- ============================================================

-- ── Remotely-configurable parameters ──
-- See services/systemConfig.js for the known keys, their shipped
-- defaults, and why this is a plain key/value table rather than bespoke
-- columns: several of these numbers (Fair Fare's threshold and rate,
-- Family Plan pricing) are explicitly "not yet finalised" per the brief,
-- and need to be editable from the admin dashboard without a deploy.
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id)
);

-- ── Arrivo Ride Guarantee ──
-- "Only company support staff may cancel an accepted trip -- not the
-- driver app directly." A driver can no longer free-cancel an accepted
-- ride from PATCH /:id/status (see routes/rides.js); instead POST
-- /:id/cancel-request requires one of a fixed set of valid reasons, and
-- every attempt -- accepted or rejected -- is logged here for support
-- visibility. A valid cancellation resets the ride to 'requested' with
-- driver_id cleared (see rides.reassignment_priority below) rather than a
-- terminal 'cancelled', so the rider is never left needing to re-search.
CREATE TABLE IF NOT EXISTS ride_cancellations (
  id SERIAL PRIMARY KEY,
  ride_id INTEGER NOT NULL REFERENCES rides(id),
  driver_id INTEGER REFERENCES drivers(id),
  reason TEXT NOT NULL, -- 'vehicle_breakdown' | 'safety_concern' | 'emergency' | 'incorrect_pickup_info'
  reassigned BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ride_cancellations_ride ON ride_cancellations(ride_id);

-- Bumped every time a ride is reset for reassignment after a valid driver
-- cancellation, so GET /api/rides/available can surface a previously-
-- cancelled ride ahead of brand-new requests -- it's already waited once.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS reassignment_priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS previously_cancelled_at TIMESTAMPTZ;

-- ── Arrivo Fair Fare ──
-- overage_naira/overage_payment_method/overage_payment_reference already
-- exist (chauffeur time-overage, see the ALTER above them). overage_reason
-- distinguishes which feature produced the charge so the rider-facing
-- copy and receipt can be accurate; overage_breakdown is the itemised
-- numbers behind it (mirrors instant_ride_requests.fare_breakdown), so
-- "why was I charged extra" always has a real, inspectable answer instead
-- of a bare total.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS overage_reason TEXT; -- 'chauffeur_hours' | 'traffic_delay'
ALTER TABLE rides ADD COLUMN IF NOT EXISTS overage_breakdown JSONB;

-- ── Arrivo Family Plan ──
-- "One account. Your whole family." plan_type gates max_members (lite=2,
-- plus=3, max=5 -- see routes/family.js PLAN_LIMITS). price_naira is
-- captured at creation time (not re-read live from system_config every
-- month) so a later price change doesn't retroactively alter what an
-- existing family agreed to pay -- same reasoning as memberships.price_naira.
CREATE TABLE IF NOT EXISTS family_plans (
  id SERIAL PRIMARY KEY,
  admin_user_id INTEGER NOT NULL REFERENCES users(id),
  plan_type TEXT NOT NULL, -- 'lite' | 'plus' | 'max'
  max_members INTEGER NOT NULL,
  price_naira NUMERIC NOT NULL,
  wallet_balance_naira NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'cancelled'
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  renews_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_plans_admin ON family_plans(admin_user_id);

-- A user can belong to at most one active family plan (as admin or
-- member) -- enforced in routes/family.js at write time; the partial
-- unique index below is the real backstop against a race creating two.
CREATE TABLE IF NOT EXISTS family_members (
  id SERIAL PRIMARY KEY,
  family_plan_id INTEGER NOT NULL REFERENCES family_plans(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  member_role TEXT NOT NULL DEFAULT 'member', -- 'admin' | 'member'
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'removed'
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_family_members_plan ON family_members(family_plan_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_family_members_one_active_plan
  ON family_members(user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS family_wallet_transactions (
  id SERIAL PRIMARY KEY,
  family_plan_id INTEGER NOT NULL REFERENCES family_plans(id),
  actor_user_id INTEGER NOT NULL REFERENCES users(id), -- who triggered it (admin funding, or a member spending on a ride)
  type TEXT NOT NULL, -- 'topup' | 'ride_charge'
  status TEXT NOT NULL DEFAULT 'completed',
  amount_naira NUMERIC NOT NULL, -- positive for topup, negative for a ride charge
  balance_after_naira NUMERIC,
  paystack_reference TEXT UNIQUE,
  ride_id INTEGER REFERENCES rides(id),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_wallet_tx_plan ON family_wallet_transactions(family_plan_id, created_at DESC);

-- A family-wallet-paid ride tracks which plan paid for it and, when the
-- admin booked on a member's behalf rather than the member booking for
-- themselves, who actually placed the order -- both purely informational
-- (admin visibility, notifications), never used for authorization after
-- the fact.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS booked_via_family_plan_id INTEGER REFERENCES family_plans(id);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS booked_by_user_id INTEGER REFERENCES users(id);

-- ============================================================
-- END ARRIVO EXPRESS PHASE 1
-- ============================================================

-- ============================================================
-- ARRIVO EXPRESS PHASE 2 (2026-09-17 engineering brief)
-- 30-day launch test: Early Bird, Morning Commuter, Midday Lucky Ride
-- ============================================================

-- promo_code identifies which (if any) launch promo a ride booked under:
-- 'early_bird' | 'morning_commuter' | 'lucky_ride_entry' | 'lucky_ride_winner'.
-- promo_discount_naira is ONLY ever nonzero for early_bird/morning_commuter
-- -- the naira amount fare_naira was reduced by at booking. Lucky Ride
-- never touches fare_naira (a winner is refunded via a wallet_transactions
-- credit instead, see services/scheduler.js), so it's always 0 for those
-- rides. This split matters for routes/drivers.js GET /earnings, which
-- sums fare_naira + promo_discount_naira so a driver's payout reconstructs
-- what the trip would have earned without the promo -- Arrivo absorbs
-- these discounts, not the driver (the brief's own "model economics
-- carefully" caution for Morning Commuter, the heaviest-demand window).
ALTER TABLE rides ADD COLUMN IF NOT EXISTS promo_code TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS promo_discount_naira NUMERIC NOT NULL DEFAULT 0;

-- One row per rider per calendar day (Africa/Lagos) who booked a
-- qualifying one-way ride inside the 12:00-1:00pm window under the
-- configured distance cap -- "one entry per customer," enforced by the
-- unique index below rather than in application code, so it holds even
-- under concurrent requests.
CREATE TABLE IF NOT EXISTS lucky_ride_entries (
  id SERIAL PRIMARY KEY,
  ride_id INTEGER NOT NULL REFERENCES rides(id),
  rider_id INTEGER NOT NULL REFERENCES users(id),
  entry_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lucky_ride_one_entry_per_rider_per_day ON lucky_ride_entries(rider_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_lucky_ride_entries_date ON lucky_ride_entries(entry_date);

-- One row per calendar day once services/scheduler.js's Lucky Ride draw
-- has run for that day -- winning_ride_id is NULL when the window closed
-- with zero entries. draw_date as the primary key is what makes the draw
-- idempotent: the sweep re-checks every 5 minutes but only ever draws once.
CREATE TABLE IF NOT EXISTS lucky_ride_draws (
  draw_date DATE PRIMARY KEY,
  winning_ride_id INTEGER REFERENCES rides(id),
  entries_count INTEGER NOT NULL DEFAULT 0,
  drawn_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- END ARRIVO EXPRESS PHASE 2
-- ============================================================

-- ============================================================
-- ARRIVO EXPRESS PHASE 3 (2026-09-17 engineering brief)
-- Arrivo Share (ride with people you know, one fare, one payer) and the
-- the Partner Venues program (reserved pickups from
-- partnered clubs/restaurants).
-- ============================================================

-- ── Arrivo Share ──
-- "People working together in areas not far from each other, who know
-- each other and don't mind sharing a ride" -- NOT anonymous stranger
-- pooling. The organizer books and pays for the ride exactly as before
-- (adults/vehicle_type/fare are all unchanged -- see services/fare.js's
-- existing MAX_PASSENGERS/computeVehicleCount, which already caps a
-- single vehicle at 3-5 people depending on type, exactly matching the
-- brief's "maximum of 5 depending on the vehicle type"). This table only
-- adds real identities to seats the organizer already paid for, so the
-- driver knows who to expect and each co-rider can track the trip
-- themselves. Every co-rider must already have a RideArrivo account
-- (same constraint as Family Plan members) -- looked up by phone/email,
-- never a free-text name, so tracking/safety/notifications all work.
CREATE TABLE IF NOT EXISTS ride_share_participants (
  id SERIAL PRIMARY KEY,
  ride_id INTEGER NOT NULL REFERENCES rides(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  added_by_user_id INTEGER NOT NULL REFERENCES users(id), -- the organizer (rides.rider_id) at the time of adding
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ride_share_participant_once ON ride_share_participants(ride_id, user_id);

-- Cheap flag for filtering/reporting/UI without a join -- set true the
-- moment the first co-rider is added, and reset to false if the organizer
-- removes everyone (routes/rides.js DELETE .../share-participants/:id) so
-- a ride that's back to solo doesn't keep showing Share badges/UI.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS is_arrivo_share BOOLEAN NOT NULL DEFAULT false;

-- ── Partner Venues program ──
-- Clubs/restaurants RideArrivo partners with: riders get a reserved
-- pickup (book it now, e.g. "we close 4am, pick me up") and the venue
-- gets guests who arrive/leave safely and reliably -- a real perk for the
-- rider is the incentive, not a discount, so it's stored as free text
-- shown at booking/tracking time ("skip the queue", "10% off your bill"),
-- not wired into the fare engine.
CREATE TABLE IF NOT EXISTS partner_venues (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other', -- 'club' | 'restaurant' | 'other'
  address TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  perk_description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A reserved ride is just an existing 'dropoff'-style scheduled booking
-- (see scheduled_pickup_at above -- "the rider tells us directly when
-- they need picking up", already exactly this use case) tagged with which
-- partner venue it's picking up from. Nothing else about ride creation,
-- pricing, or payment changes.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS partner_venue_id INTEGER REFERENCES partner_venues(id);

-- ── Audit follow-up indexes (2026-09-17) ──
-- Postgres never auto-indexes a foreign key column, and this table had no
-- indexes on driver_id/ride_status/partner_venue_id at all before Phase 3.
-- GET /api/rides/available's area-lock check
-- (driver_id = $1 AND ride_status IN (...) AND partner_venue_id IS NOT NULL)
-- is a new, frequent per-request lookup, so it needs one; the partial
-- index below also speeds every other place that joins on
-- rides.partner_venue_id (GET /:id, GET /mine, GET /driver/mine, the admin
-- Arrivo Share report).
CREATE INDEX IF NOT EXISTS idx_rides_driver_status ON rides(driver_id, ride_status);
CREATE INDEX IF NOT EXISTS idx_rides_partner_venue ON rides(partner_venue_id) WHERE partner_venue_id IS NOT NULL;

-- ============================================================
-- END ARRIVO EXPRESS PHASE 3
-- ============================================================
