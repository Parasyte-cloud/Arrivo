// Tests for the account deletion rules. Run directly:
//   node services/accountDeletion.test.js
//
// Uses a stand-in for the pg pool so there is no database to set up. The full
// path was also exercised against a real Postgres, but the guards and the scrub
// coverage are the parts worth pinning here: a gap in either one either leaves
// somebody's documents behind or deletes them mid-trip.

const assert = require("assert");
const {
  ACTIVE_RIDE_STATUSES,
  BLOCKED_ACTIVE_RIDE,
  BLOCKED_WALLET_BALANCE,
  findDeletionBlocker,
  anonymiseAccount,
  tombstoneEmail,
} = require("./accountDeletion");

let passed = 0;
function test(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.message}`);
      process.exitCode = 1;
    }
  })();
}

// Answers only the two queries findDeletionBlocker makes.
function fakePool({ activeRide = false, balance = 0 } = {}) {
  return {
    async query(sql) {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s.startsWith("SELECT rides.id")) return { rows: activeRide ? [{ id: 1 }] : [] };
      if (s.startsWith("SELECT wallet_balance_naira")) return { rows: [{ wallet_balance_naira: balance }] };
      throw new Error(`unexpected query: ${s}`);
    },
  };
}

// Records every statement anonymiseAccount runs, so the transaction shape and
// the scrub coverage can be checked without a database.
function recordingPool({ activeRide = false, balance = 0, alreadyDeleted = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: s, params });
      if (s.startsWith("SELECT wallet_balance_naira")) {
        return {
          rows: [{ wallet_balance_naira: balance, deleted_at: alreadyDeleted ? "2026-01-01" : null }],
        };
      }
      if (s.startsWith("SELECT rides.id")) return { rows: activeRide ? [{ id: 1 }] : [] };
      if (s.startsWith("UPDATE users")) {
        return { rows: [{ id: params[0], deleted_at: "2026-09-06T00:00:00Z" }] };
      }
      return { rows: [] };
    },
    released: false,
    release() {
      this.released = true;
    },
  };
  return { calls, client, connect: async () => client };
}

const stmt = (pool, prefix) => pool.calls.find((c) => c.sql.startsWith(prefix));

(async () => {

console.log("The read-only pre-check:");

await test("no active ride and no balance means it can go", async () => {
  assert.strictEqual(await findDeletionBlocker(fakePool(), 1), null);
});

await test("an active ride blocks deletion", async () => {
  const blocker = await findDeletionBlocker(fakePool({ activeRide: true }), 1);
  assert.strictEqual(blocker.reason, BLOCKED_ACTIVE_RIDE);
  assert.ok(/trip/i.test(blocker.message), blocker.message);
});

await test("the three live statuses are the ones checked", () => {
  assert.deepStrictEqual(ACTIVE_RIDE_STATUSES, ["requested", "accepted", "in_progress"]);
  // completed and cancelled must not be in here or a finished account could
  // never be deleted at all.
  assert.ok(!ACTIVE_RIDE_STATUSES.includes("completed"));
  assert.ok(!ACTIVE_RIDE_STATUSES.includes("cancelled"));
});

await test("a positive balance blocks deletion", async () => {
  const blocker = await findDeletionBlocker(fakePool({ balance: 5000 }), 1);
  assert.strictEqual(blocker.reason, BLOCKED_WALLET_BALANCE);
  assert.ok(/wallet/i.test(blocker.message), blocker.message);
});

await test("a balance arriving as a string still blocks", async () => {
  // NUMERIC comes back from pg as a string, so a plain truthiness check would
  // have let "0.00" through and a Number() slip would let "5000" through.
  const blocker = await findDeletionBlocker(fakePool({ balance: "5000.00" }), 1);
  assert.strictEqual(blocker.reason, BLOCKED_WALLET_BALANCE);
  assert.strictEqual(await findDeletionBlocker(fakePool({ balance: "0.00" }), 1), null);
});

await test("the ride check runs before the wallet check", async () => {
  const blocker = await findDeletionBlocker(fakePool({ activeRide: true, balance: 5000 }), 1);
  assert.strictEqual(blocker.reason, BLOCKED_ACTIVE_RIDE);
});

console.log("");
console.log("The tombstone email:");

await test("frees the real address and cannot be a real domain", () => {
  assert.strictEqual(tombstoneEmail(42), "deleted+42@deleted.invalid");
  assert.ok(tombstoneEmail(42).endsWith(".invalid"));
});

await test("is unique per user so the UNIQUE constraint holds", () => {
  assert.notStrictEqual(tombstoneEmail(1), tombstoneEmail(2));
});

console.log("");
console.log("The guards run where the write happens:");

await test("the transaction is SERIALIZABLE and locks the user row", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  assert.strictEqual(pool.calls[0].sql, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  const lock = stmt(pool, "SELECT wallet_balance_naira");
  assert.ok(/FOR UPDATE/.test(lock.sql), "the user row must be locked, not just read");
});

await test("a ride starting mid-delete aborts before anything is written", async () => {
  const pool = recordingPool({ activeRide: true });
  await assert.rejects(() => anonymiseAccount(pool, 7), (e) => e.reason === BLOCKED_ACTIVE_RIDE);
  assert.ok(pool.calls.some((c) => c.sql === "ROLLBACK"), "should roll back");
  assert.ok(!stmt(pool, "UPDATE users"), "nothing should be scrubbed");
});

await test("a top-up landing mid-delete aborts before anything is written", async () => {
  const pool = recordingPool({ balance: 2500 });
  await assert.rejects(() => anonymiseAccount(pool, 7), (e) => e.reason === BLOCKED_WALLET_BALANCE);
  assert.ok(pool.calls.some((c) => c.sql === "ROLLBACK"));
  assert.ok(!stmt(pool, "UPDATE users"));
});

await test("an account already deleted returns null without writing", async () => {
  const pool = recordingPool({ alreadyDeleted: true });
  assert.strictEqual(await anonymiseAccount(pool, 7), null);
  assert.ok(!stmt(pool, "UPDATE users"));
});

await test("commits and releases the client on success", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  assert.ok(pool.calls.some((c) => c.sql === "COMMIT"), "should commit");
  assert.ok(pool.client.released, "client should be released back to the pool");
});

await test("rolls back, rethrows and still releases when the scrub fails", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, " ").trim();
      calls.push(s);
      if (s.startsWith("SELECT wallet_balance_naira")) {
        return { rows: [{ wallet_balance_naira: 0, deleted_at: null }] };
      }
      if (s.startsWith("SELECT rides.id")) return { rows: [] };
      if (s.startsWith("UPDATE users")) throw new Error("boom");
      return { rows: [] };
    },
    released: false,
    release() { this.released = true; },
  };
  await assert.rejects(() => anonymiseAccount({ connect: async () => client }, 7), /boom/);
  assert.ok(calls.includes("ROLLBACK"), "should roll back");
  assert.ok(client.released, "client should still be released");
});

console.log("");
console.log("Everything a driver handed over:");

await test("all driver documents, photos and contacts are scrubbed", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const drivers = stmt(pool, "UPDATE drivers");
  assert.ok(drivers, "drivers row should be scrubbed");
  for (const field of [
    "license_number", "lasdri_number", "insurance_number",
    "owner_name", "owner_whatsapp",
    "profile_photo_url", "license_photo_url", "vehicle_photo_url",
    "emergency_contact_name", "emergency_contact_phone",
    "current_lat", "current_lng", "scan_token",
  ]) {
    assert.ok(new RegExp(`${field} = NULL`).test(drivers.sql), `${field} should be cleared`);
  }
});

console.log("");
console.log("Personal data living outside the users table:");

await test("third party emergency contacts are deleted, not anonymised", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  assert.ok(stmt(pool, "DELETE FROM emergency_contacts"), "should be deleted outright");
});

await test("free text and third party contacts come off the rider's rides", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const rides = stmt(pool, "UPDATE rides");
  assert.ok(rides, "rides should be scrubbed");
  for (const field of [
    "emergency_contact_name", "emergency_contact_phone", "rider_rating_comment",
    "pickup_lat", "pickup_lng", "destination_lat", "destination_lng",
  ]) {
    assert.ok(new RegExp(`${field} = NULL`).test(rides.sql), `${field} should be cleared`);
  }
});

await test("addresses and fares survive, because a dispute needs them", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const rides = stmt(pool, "UPDATE rides");
  // Deliberately kept. See the retention note at the top of the service.
  for (const kept of ["pickup_address", "stops", "fare_naira"]) {
    assert.ok(!rides.sql.includes(kept), `${kept} should be kept, not scrubbed`);
  }
});

await test("support ticket text goes but the dispute trail stays", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const tickets = stmt(pool, "UPDATE support_tickets");
  assert.ok(tickets, "support tickets should be scrubbed");
  assert.ok(/subject =/.test(tickets.sql) && /description =/.test(tickets.sql));
  assert.ok(!/status =/.test(tickets.sql), "status is the trail and should stay");
});

await test("a pending On the Go request is cancelled and emptied", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const otg = stmt(pool, "UPDATE on_the_go_requests");
  assert.ok(otg, "on the go requests should be handled");
  assert.ok(/cancelled/.test(otg.sql), "a pending request should be cancelled");
  for (const field of ["pickup_address", "destination_address", "contact_phone", "flight_number"]) {
    assert.ok(otg.sql.includes(field), `${field} should be cleared`);
  }
});

console.log("");
console.log("The users row itself:");

await test("every piece of personal data on users is covered", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const users = stmt(pool, "UPDATE users");
  assert.ok(users, "users row should be scrubbed");
  for (const field of [
    "name", "email", "phone", "whatsapp_number", "country_of_residence", "passport_number",
    "date_of_birth", "avatar_url", "id_document_url", "password_hash", "google_id", "apple_id",
    "apple_refresh_token", "push_token", "reset_token", "deleted_at",
  ]) {
    assert.ok(users.sql.includes(field), `${field} should be scrubbed`);
  }
});

await test("oauth links are cleared so neither provider can sign back in", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const users = stmt(pool, "UPDATE users");
  assert.ok(/google_id = NULL/.test(users.sql));
  assert.ok(/apple_id = NULL/.test(users.sql));
  assert.ok(/apple_refresh_token = NULL/.test(users.sql));
});

await test("id_verification_status is reset, not nulled, since it is NOT NULL", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const users = stmt(pool, "UPDATE users");
  assert.ok(/id_verification_status = 'unverified'/.test(users.sql), "nulling it violates NOT NULL");
});

await test("only scrubs an account that is not already deleted", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const users = stmt(pool, "UPDATE users");
  assert.ok(/deleted_at IS NULL/.test(users.sql), "a second delete should not rewrite the row");
});

console.log(`\n${passed} passed`);
})();
