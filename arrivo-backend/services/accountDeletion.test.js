// Tests for the account deletion rules. Run directly:
//   node services/accountDeletion.test.js
//
// Uses a stand-in for the pg pool so there is no database to set up. The full
// path was also exercised against a real Postgres, but the guards are the part
// worth pinning here: a wrong answer from either one either deletes somebody
// mid-trip or quietly keeps their money.

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

// Records what anonymiseAccount does so the transaction and the scrub can be
// checked without a database.
function recordingPool() {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (sql.includes("UPDATE users")) return { rows: [{ id: params[0], deleted_at: "2026-09-05T00:00:00Z" }] };
      return { rows: [] };
    },
    released: false,
    release() { this.released = true; },
  };
  return { calls, client, connect: async () => client };
}

(async () => {

console.log("Nothing blocks a clean account:");

await test("no active ride and no balance means it can go", async () => {
  assert.strictEqual(await findDeletionBlocker(fakePool(), 1), null);
});

console.log("");
console.log("A trip still running blocks it:");

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

console.log("");
console.log("Money on the account blocks it:");

await test("a positive balance blocks deletion", async () => {
  const blocker = await findDeletionBlocker(fakePool({ balance: 5000 }), 1);
  assert.strictEqual(blocker.reason, BLOCKED_WALLET_BALANCE);
  assert.ok(/wallet/i.test(blocker.message), blocker.message);
});

await test("a zero balance does not", async () => {
  assert.strictEqual(await findDeletionBlocker(fakePool({ balance: 0 }), 1), null);
});

await test("a balance arriving as a string still blocks", async () => {
  // NUMERIC comes back from pg as a string, so a plain truthiness check would
  // have let "0.00" through and a Number() slip would let "5000" through.
  const blocker = await findDeletionBlocker(fakePool({ balance: "5000.00" }), 1);
  assert.strictEqual(blocker.reason, BLOCKED_WALLET_BALANCE);
  assert.strictEqual(await findDeletionBlocker(fakePool({ balance: "0.00" }), 1), null);
});

await test("the ride check runs before the wallet check", async () => {
  // Both blocked: the rider should hear about the trip they are sitting in,
  // not their balance.
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
console.log("What the scrub actually does:");

await test("runs in a transaction and releases the client", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const sqls = pool.calls.map((c) => c.sql);
  assert.strictEqual(sqls[0], "BEGIN");
  assert.ok(sqls.includes("COMMIT"), "should commit");
  assert.ok(pool.client.released, "client should be released back to the pool");
});

await test("third party emergency contacts are deleted, not anonymised", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  assert.ok(
    pool.calls.some((c) => /^DELETE FROM emergency_contacts/.test(c.sql)),
    "emergency contacts should be deleted outright"
  );
});

await test("driver documents and last position are cleared", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const drivers = pool.calls.find((c) => c.sql.startsWith("UPDATE drivers"));
  assert.ok(drivers, "drivers row should be scrubbed");
  for (const field of ["license_number", "lasdri_number", "current_lat", "current_lng", "scan_token"]) {
    assert.ok(drivers.sql.includes(field), `${field} should be cleared`);
  }
});

await test("every piece of personal data on users is covered", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const users = pool.calls.find((c) => c.sql.startsWith("UPDATE users"));
  assert.ok(users, "users row should be scrubbed");
  for (const field of [
    "name", "email", "phone", "whatsapp_number", "country_of_residence", "passport_number",
    "date_of_birth", "avatar_url", "id_document_url", "password_hash", "google_id", "apple_id",
    "push_token", "reset_token", "deleted_at",
  ]) {
    assert.ok(users.sql.includes(field), `${field} should be scrubbed`);
  }
});

await test("google and apple ids are cleared so oauth cannot sign back in", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const users = pool.calls.find((c) => c.sql.startsWith("UPDATE users"));
  assert.ok(/google_id = NULL/.test(users.sql));
  assert.ok(/apple_id = NULL/.test(users.sql));
});

await test("id_verification_status is reset, not nulled, since it is NOT NULL", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const users = pool.calls.find((c) => c.sql.startsWith("UPDATE users"));
  assert.ok(/id_verification_status = 'unverified'/.test(users.sql), "nulling it violates NOT NULL");
});

await test("only scrubs an account that is not already deleted", async () => {
  const pool = recordingPool();
  await anonymiseAccount(pool, 7);
  const users = pool.calls.find((c) => c.sql.startsWith("UPDATE users"));
  assert.ok(/deleted_at IS NULL/.test(users.sql), "a second delete should not rewrite the row");
});

await test("rolls back and rethrows when the scrub fails", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("UPDATE users")) throw new Error("boom");
      return { rows: [] };
    },
    released: false,
    release() { this.released = true; },
  };
  const pool = { connect: async () => client };
  await assert.rejects(() => anonymiseAccount(pool, 7), /boom/);
  assert.ok(calls.includes("ROLLBACK"), "should roll back");
  assert.ok(client.released, "client should still be released");
});

console.log(`\n${passed} passed`);
})();
