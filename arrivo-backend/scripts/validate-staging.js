// Staging validation script — run this yourself against a REAL staging
// database. This assistant cannot run it for you; it has no access to
// your Neon/Postgres environment. Reads DATABASE_URL from the
// environment, same as the rest of this backend already does — never
// hardcode credentials into this file or commit them anywhere.
//
// Usage:
//   DATABASE_URL="postgres://..." node scripts/validate-staging.js
//
// Exits with code 1 if any check reports FAIL, so it's safe to use in a
// CI/deploy gate later if you want that.

const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let failCount = 0;
let warnCount = 0;

function report(status, label, detail = "") {
  const icon = status === "PASS" ? "✓" : status === "WARN" ? "⚠" : "✗";
  console.log(`${icon} [${status}] ${label}${detail ? " — " + detail : ""}`);
  if (status === "FAIL") failCount++;
  if (status === "WARN") warnCount++;
}

async function tableExists(name) {
  const r = await pool.query(`SELECT to_regclass($1) as exists`, [`public.${name}`]);
  return !!r.rows[0].exists;
}

async function columnExists(table, column) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return r.rows.length > 0;
}

async function main() {
  console.log("=== Schema checks ===\n");

  for (const table of ["ride_telemetry", "route_deviation_state", "route_deviation_events", "safety_alerts", "vehicle_current_state", "vehicle_trackers"]) {
    report((await tableExists(table)) ? "PASS" : "FAIL", `table "${table}" exists`);
  }

  // The critical negative check — confirms we did NOT create a
  // competing table on top of the real one.
  const vehiclesOwnerCol = await columnExists("vehicles", "owner_user_id");
  report(vehiclesOwnerCol ? "PASS" : "FAIL", 'vehicles.owner_user_id still present (original schema preserved)');

  for (const col of ["make_model", "plate_number", "vehicle_type", "seats"]) {
    report((await columnExists("vehicles", col)) ? "PASS" : "FAIL", `vehicles.${col} still present`);
  }
  for (const col of ["status", "active"]) {
    report((await columnExists("vehicles", col)) ? "PASS" : "WARN", `vehicles.${col} added by migration_002`, "run migration_002_vehicles.sql if missing");
  }

  report((await columnExists("rides", "route_geometry")) ? "PASS" : "FAIL", "rides.route_geometry present (migration_001)");
  report((await columnExists("drivers", "vehicle_id")) ? "PASS" : "FAIL", "drivers.vehicle_id present (original relationship, must be preserved)");

  console.log("\n=== Data integrity checks ===\n");

  const vehicleCount = (await pool.query("SELECT COUNT(*) as n FROM vehicles")).rows[0].n;
  report(Number(vehicleCount) > 0 ? "PASS" : "WARN", `${vehicleCount} existing vehicle row(s) found`, vehicleCount == 0 ? "empty table — fine if genuinely no vehicles yet, concerning if this used to be nonzero" : "");

  const driverCount = (await pool.query("SELECT COUNT(*) as n FROM drivers")).rows[0].n;
  report(Number(driverCount) > 0 ? "PASS" : "WARN", `${driverCount} existing driver row(s) found`);

  const orphanedVehicleRefs = await pool.query(
    `SELECT COUNT(*) as n FROM drivers WHERE vehicle_id IS NOT NULL AND vehicle_id NOT IN (SELECT id FROM vehicles)`
  );
  report(Number(orphanedVehicleRefs.rows[0].n) === 0 ? "PASS" : "FAIL", "no orphaned drivers.vehicle_id references", `${orphanedVehicleRefs.rows[0].n} orphaned`);

  console.log("\n=== Functional smoke tests (writes a throwaway row, then deletes it) ===\n");

  try {
    const rideRow = await pool.query("SELECT id FROM rides LIMIT 1");
    if (rideRow.rows[0]) {
      const rideId = rideRow.rows[0].id;
      await pool.query(
        `INSERT INTO ride_telemetry (ride_id, source, lat, lng, recorded_at) VALUES ($1, 'validation_script', 6.5, 3.4, now())`,
        [rideId]
      );
      const inserted = await pool.query(
        `SELECT id FROM ride_telemetry WHERE ride_id = $1 AND source = 'validation_script' ORDER BY id DESC LIMIT 1`,
        [rideId]
      );
      await pool.query(`DELETE FROM ride_telemetry WHERE id = $1`, [inserted.rows[0].id]);
      report("PASS", "ride_telemetry insert/delete round-trip succeeded");
    } else {
      report("WARN", "no existing ride to test telemetry insert against — skipped", "create a test ride first for a full smoke test");
    }
  } catch (e) {
    report("FAIL", "ride_telemetry insert/delete round-trip", e.message);
  }

  console.log(`\n=== Summary: ${failCount} FAIL, ${warnCount} WARN ===`);
  await pool.end();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Validation script crashed:", e.message);
  process.exit(1);
});
