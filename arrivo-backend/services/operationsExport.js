// Dataset definitions for the operations CSV exports.
//
// Each dataset says what to select, where it comes from, and who may take it.
// The route does the access checks, the audit log and the streaming; nothing
// in this file talks to the HTTP layer.
//
// What is deliberately NOT exported, anywhere:
//   password hashes, reset and verification tokens, push tokens, driver scan
//   tokens, ID document images, passport numbers, licence photos, driver
//   licence numbers, emergency contact names and numbers, wallet balances on
//   rider rows, and exact GPS coordinates.
// A CSV gets forwarded, attached to emails and left in Downloads folders, so
// it carries what an operations record needs and no more.
//
// Accounts that have been deleted show as "Deleted account" with no contact
// details, so an export never brings back data the person asked us to remove.

const WAT = "Africa/Lagos";

// A timestamp as Lagos time, readable in a spreadsheet: 2026-10-06 15:24:00
const wat = (column) =>
  `to_char(${column} AT TIME ZONE '${WAT}', 'YYYY-MM-DD HH24:MI:SS')`;

// Personal fields of a joined users row, blanked when the account is deleted.
const person = (alias, column, deletedLabel = null) =>
  deletedLabel
    ? `CASE WHEN ${alias}.deleted_at IS NOT NULL THEN '${deletedLabel}' ELSE ${alias}.${column} END`
    : `CASE WHEN ${alias}.deleted_at IS NOT NULL THEN NULL ELSE ${alias}.${column} END`;

const name = (alias) => person(alias, "name", "Deleted account");
const phone = (alias) => person(alias, "phone");
const email = (alias) => person(alias, "email");

const RIDE_JOINS = `
  FROM rides
  JOIN users riders ON riders.id = rides.rider_id
  LEFT JOIN drivers ON drivers.id = rides.driver_id
  LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
  LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id`;

const DATASETS = {
  riders: {
    label: "Riders",
    description: "Every rider account with contact details, sign-up date, ID check status and trip counts.",
    audience: "operations",
    key: "users.id",
    dateColumn: "users.created_at",
    select: `
      users.id AS rider_id,
      users.name AS name,
      users.email AS email,
      users.phone AS phone,
      users.preferred_language AS language,
      ${wat("users.created_at")} AS signed_up_wat,
      users.id_verification_status AS id_check_status,
      (SELECT COUNT(*) FROM rides r WHERE r.rider_id = users.id) AS trips_booked,
      (SELECT COUNT(*) FROM rides r WHERE r.rider_id = users.id AND r.ride_status = 'completed') AS trips_completed,
      (SELECT ${wat("MAX(r.created_at)")} FROM rides r WHERE r.rider_id = users.id) AS last_booking_wat`,
    from: "FROM users",
    where: "users.role = 'rider' AND users.deleted_at IS NULL",
  },

  drivers: {
    label: "Drivers",
    description: "Every driver with verification, online state, rating, vehicle and completed trips.",
    audience: "operations",
    key: "drivers.id",
    dateColumn: "drivers.created_at",
    select: `
      drivers.id AS driver_id,
      users.name AS name,
      users.email AS email,
      users.phone AS phone,
      drivers.is_verified AS verified,
      drivers.is_online AS online_now,
      drivers.accepts_instant AS arrivoexpress_opt_in,
      drivers.rating AS rating,
      drivers.lasdri_number AS lasdri_number,
      drivers.insurance_number AS insurance_number,
      drivers.spoken_languages AS languages,
      vehicles.make_model AS vehicle,
      vehicles.plate_number AS plate_number,
      vehicles.vehicle_type AS vehicle_type,
      ${wat("drivers.created_at")} AS joined_wat,
      ${wat("drivers.location_updated_at")} AS last_location_update_wat,
      (SELECT COUNT(*) FROM rides r WHERE r.driver_id = drivers.id AND r.ride_status = 'completed') AS trips_completed`,
    from: `FROM drivers
      JOIN users ON users.id = drivers.user_id
      LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id`,
    where: "users.deleted_at IS NULL",
  },

  vehicles: {
    label: "Vehicles",
    description: "Every listed vehicle with owner, assigned driver and capacity.",
    audience: "operations",
    key: "vehicles.id",
    dateColumn: "vehicles.created_at",
    select: `
      vehicles.id AS vehicle_id,
      vehicles.make_model AS make_model,
      vehicles.plate_number AS plate_number,
      vehicles.vehicle_type AS vehicle_type,
      vehicles.seats AS seats,
      ${name("owners")} AS owner_name,
      ${phone("owners")} AS owner_phone,
      ${name("driver_users")} AS assigned_driver,
      drivers.is_verified AS assigned_driver_verified,
      ${wat("vehicles.created_at")} AS listed_wat`,
    from: `FROM vehicles
      JOIN users owners ON owners.id = vehicles.owner_user_id
      LEFT JOIN drivers ON drivers.vehicle_id = vehicles.id
      LEFT JOIN users driver_users ON driver_users.id = drivers.user_id`,
    where: "TRUE",
  },

  rides: {
    label: "Trips (RideArrivo and ArrivoExpress)",
    description: "Every booked or completed trip: who, where, when, driver, vehicle, fare, payment and status.",
    audience: "operations",
    key: "rides.id",
    dateColumn: "rides.created_at",
    select: `
      rides.id AS trip_id,
      ${wat("rides.created_at")} AS booked_wat,
      ${wat("rides.scheduled_pickup_at")} AS scheduled_pickup_wat,
      ${wat("rides.tracking_started_at")} AS trip_started_wat,
      ${wat("rides.completed_at")} AS completed_wat,
      rides.service_mode AS service,
      rides.booking_type AS booking_type,
      rides.ride_status AS status,
      ${name("riders")} AS rider_name,
      ${phone("riders")} AS rider_phone,
      ${name("driver_users")} AS driver_name,
      ${phone("driver_users")} AS driver_phone,
      vehicles.make_model AS vehicle,
      vehicles.plate_number AS plate_number,
      rides.vehicle_type AS vehicle_type_booked,
      rides.pickup_address AS pickup,
      rides.stops AS stops_json,
      rides.flight_number AS flight_number,
      rides.distance_km AS distance_km,
      rides.duration_min AS duration_min,
      rides.duration_days AS days_booked,
      rides.security_escort AS security_escort,
      rides.fleet_size AS fleet_size,
      rides.fare_naira AS fare_naira,
      rides.tip_naira AS tip_naira,
      rides.overage_naira AS overage_naira,
      rides.promo_discount_naira AS promo_discount_naira,
      rides.payment_method AS payment_method,
      rides.payment_status AS payment_status,
      rides.payment_reference AS payment_reference,
      rides.rider_rating AS rider_rating`,
    from: RIDE_JOINS,
    where: "TRUE",
  },

  "arrivoexpress-requests": {
    label: "ArrivoExpress requests",
    description: "Every on-demand request with route, estimate, outcome, matched driver and how many drivers were offered it.",
    audience: "operations",
    key: "instant_ride_requests.id",
    dateColumn: "instant_ride_requests.created_at",
    select: `
      instant_ride_requests.id AS request_id,
      ${wat("instant_ride_requests.created_at")} AS requested_wat,
      instant_ride_requests.status AS outcome,
      ${name("riders")} AS rider_name,
      instant_ride_requests.pickup_address AS pickup,
      instant_ride_requests.destination_address AS destination,
      instant_ride_requests.vehicle_type AS vehicle_type,
      instant_ride_requests.estimated_fare_naira AS estimated_fare_naira,
      instant_ride_requests.estimated_distance_km AS estimated_distance_km,
      instant_ride_requests.estimated_duration_min AS estimated_duration_min,
      (SELECT COUNT(*) FROM instant_ride_offers o WHERE o.request_id = instant_ride_requests.id) AS drivers_offered,
      ${name("matched_users")} AS matched_driver,
      ${wat("instant_ride_requests.matched_at")} AS matched_wat,
      ${wat("instant_ride_requests.cancelled_at")} AS cancelled_wat,
      instant_ride_requests.ride_id AS trip_id`,
    from: `FROM instant_ride_requests
      JOIN users riders ON riders.id = instant_ride_requests.rider_id
      LEFT JOIN drivers matched ON matched.id = instant_ride_requests.matched_driver_id
      LEFT JOIN users matched_users ON matched_users.id = matched.user_id`,
    where: "TRUE",
  },

  "arrivoexpress-offers": {
    label: "ArrivoExpress driver offers",
    description: "Each offer sent to a driver and how they answered: accepted, declined or expired.",
    audience: "operations",
    key: "instant_ride_offers.id",
    dateColumn: "instant_ride_offers.offered_at",
    select: `
      instant_ride_offers.id AS offer_id,
      instant_ride_offers.request_id AS request_id,
      ${name("driver_users")} AS driver_name,
      instant_ride_offers.status AS answer,
      instant_ride_offers.distance_to_pickup_km AS distance_to_pickup_km,
      instant_ride_offers.eta_to_pickup_min AS eta_to_pickup_min,
      ${wat("instant_ride_offers.offered_at")} AS offered_wat,
      ${wat("instant_ride_offers.responded_at")} AS answered_wat`,
    from: `FROM instant_ride_offers
      JOIN drivers ON drivers.id = instant_ride_offers.driver_id
      JOIN users driver_users ON driver_users.id = drivers.user_id`,
    where: "TRUE",
  },

  cancellations: {
    label: "Driver cancellations",
    description: "Every time a driver cancelled an accepted trip, with the reason and whether it was reassigned.",
    audience: "operations",
    key: "ride_cancellations.id",
    dateColumn: "ride_cancellations.created_at",
    select: `
      ride_cancellations.id AS cancellation_id,
      ride_cancellations.ride_id AS trip_id,
      ${name("driver_users")} AS driver_name,
      ride_cancellations.reason AS reason,
      ride_cancellations.reassigned AS reassigned,
      ${wat("ride_cancellations.created_at")} AS cancelled_wat`,
    from: `FROM ride_cancellations
      LEFT JOIN drivers ON drivers.id = ride_cancellations.driver_id
      LEFT JOIN users driver_users ON driver_users.id = drivers.user_id`,
    where: "TRUE",
  },

  "safety-incidents": {
    label: "Safety incidents (panic alerts)",
    description: "Every panic alert with when it was raised, when it was resolved and the notes.",
    audience: "operations",
    key: "rides.id",
    dateColumn: "rides.panic_triggered_at",
    select: `
      rides.id AS trip_id,
      ${wat("rides.panic_triggered_at")} AS raised_wat,
      ${wat("rides.panic_resolved_at")} AS resolved_wat,
      rides.panic_notes AS notes,
      ${name("riders")} AS rider_name,
      ${phone("riders")} AS rider_phone,
      ${name("driver_users")} AS driver_name,
      vehicles.plate_number AS plate_number,
      rides.pickup_address AS pickup`,
    from: RIDE_JOINS,
    where: "rides.panic_triggered_at IS NOT NULL",
  },

  "flight-issues": {
    label: "Flight issues",
    description: "Airport trips where the flight was cancelled or rescheduled and what was done about it.",
    audience: "operations",
    key: "rides.id",
    dateColumn: "rides.created_at",
    select: `
      rides.id AS trip_id,
      rides.flight_number AS flight_number,
      rides.flight_issue AS issue,
      ${wat("rides.original_flight_scheduled_at")} AS original_flight_time_wat,
      ${wat("rides.flight_issue_notified_at")} AS rider_notified_wat,
      rides.ride_status AS trip_status,
      ${name("riders")} AS rider_name,
      ${phone("riders")} AS rider_phone,
      ${name("driver_users")} AS driver_name`,
    from: RIDE_JOINS,
    where: "rides.flight_issue IS NOT NULL",
  },

  // Money. Operations staff run the service but are not given the wallet
  // ledger by the admin console either, so it stays admin only here too.
  "wallet-transactions": {
    label: "Wallet transactions",
    description: "Top-ups, trip charges, tips and refunds across all riders.",
    audience: "admin",
    key: "wallet_transactions.id",
    dateColumn: "wallet_transactions.created_at",
    select: `
      wallet_transactions.id AS transaction_id,
      ${wat("wallet_transactions.created_at")} AS time_wat,
      ${name("users")} AS user_name,
      ${email("users")} AS user_email,
      wallet_transactions.type AS type,
      wallet_transactions.status AS status,
      wallet_transactions.amount_naira AS amount_naira,
      wallet_transactions.balance_after_naira AS balance_after_naira,
      wallet_transactions.ride_id AS trip_id,
      wallet_transactions.paystack_reference AS paystack_reference,
      wallet_transactions.description AS description`,
    from: `FROM wallet_transactions
      JOIN users ON users.id = wallet_transactions.user_id`,
    where: "TRUE",
  },

  memberships: {
    label: "Memberships",
    description: "Every membership with plan, status, dates and price.",
    audience: "admin",
    key: "memberships.id",
    dateColumn: "memberships.created_at",
    select: `
      memberships.id AS membership_id,
      ${name("users")} AS member_name,
      ${email("users")} AS member_email,
      memberships.plan_type AS plan,
      memberships.status AS status,
      ${wat("memberships.started_at")} AS started_wat,
      ${wat("memberships.expires_at")} AS expires_wat,
      memberships.price_naira AS price_naira,
      ${name("company_users")} AS company_account`,
    from: `FROM memberships
      JOIN users ON users.id = memberships.user_id
      LEFT JOIN users company_users ON company_users.id = memberships.company_account_id`,
    where: "TRUE",
  },
};

// A fixed ceiling, so one click can never try to build a file the server
// cannot hold. Hit it and the caller is asked for a shorter date range.
const MAX_ROWS = Number(process.env.EXPORT_MAX_ROWS) || 100000;
const BATCH_SIZE = Number(process.env.EXPORT_BATCH_SIZE) || 2000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!DATE_ONLY.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    const error = new Error(`${label} must be a date in the form YYYY-MM-DD.`);
    error.status = 400;
    throw error;
  }
  return text;
}

function parseRange(query) {
  const from = parseDate(query.from, "From date");
  const to = parseDate(query.to, "To date");
  if (from && to && from > to) {
    const error = new Error("The From date cannot be after the To date.");
    error.status = 400;
    throw error;
  }
  return { from, to };
}

// WHERE clause plus parameters for one dataset and date range. Dates are
// read as Lagos calendar days: "to" includes the whole of that day.
function buildFilter(dataset, { from, to }, firstParam = 1) {
  const clauses = [dataset.where];
  const params = [];
  if (from) {
    params.push(from);
    clauses.push(`${dataset.dateColumn} >= ($${firstParam + params.length - 1}::date)::timestamp AT TIME ZONE '${WAT}'`);
  }
  if (to) {
    params.push(to);
    clauses.push(`${dataset.dateColumn} < (($${firstParam + params.length - 1}::date + 1)::timestamp AT TIME ZONE '${WAT}')`);
  }
  return { where: clauses.join(" AND "), params };
}

function countSql(dataset, range) {
  const filter = buildFilter(dataset, range);
  return {
    text: `SELECT COUNT(*)::int AS n ${dataset.from} WHERE ${filter.where}`,
    values: filter.params,
  };
}

// One page of rows after a given key. Paging by key instead of OFFSET keeps
// each query fast however deep into the table the export has got.
function pageSql(dataset, range, afterKey, size = BATCH_SIZE) {
  const filter = buildFilter(dataset, range, 2);
  return {
    text: `SELECT ${dataset.select}, ${dataset.key} AS _key
           ${dataset.from}
           WHERE ${dataset.key} > $1 AND ${filter.where}
           ORDER BY ${dataset.key} ASC
           LIMIT ${Number(size)}`,
    values: [afterKey, ...filter.params],
  };
}

function datasetsFor(role) {
  return Object.entries(DATASETS)
    .filter(([, d]) => d.audience === "operations" || role === "admin")
    .map(([key, d]) => ({ key, label: d.label, description: d.description, adminOnly: d.audience === "admin" }));
}

module.exports = {
  DATASETS,
  MAX_ROWS,
  BATCH_SIZE,
  parseRange,
  countSql,
  pageSql,
  datasetsFor,
};
