// Pure rules for trip safety. No database.
const assert = require("assert");
process.env.JWT_SECRET = "unit-secret";
const pin = require("./pickupPin");
const share = require("./shareLinks");
const selfie = require("./driverSelfie");
const c = require("./complaints");

let passed = 0;
const test = (n, f) => { try { f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n      ${e.stack}`); process.exitCode = 1; } };
const mins = (n) => n * 60000;

test("PIN is 4 digits, stable, and differs by ride, nonce and secret", () => {
  const a = pin.derivePin(10, 0, "k");
  assert.match(a, /^\d{4}$/);
  assert.strictEqual(a, pin.derivePin(10, 0, "k"));
  const others = new Set([pin.derivePin(11, 0, "k"), pin.derivePin(10, 1, "k"), pin.derivePin(10, 0, "other")]);
  assert.ok(others.size >= 2); // 1 in 10,000 chance each could collide
  assert.throws(() => pin.derivePin(1, 0, ""));
});

test("PIN match is exact and trims spaces", () => {
  assert.ok(pin.pinMatches("0042", "0042"));
  assert.ok(pin.pinMatches("0042", " 0042 "));
  assert.ok(!pin.pinMatches("0042", "42"));
  assert.ok(!pin.pinMatches("0042", ""));
  assert.ok(!pin.pinMatches("0042", undefined));
});

const now = new Date("2026-10-01T12:00:00Z");
test("link state: active, expired, revoked, ended with grace", () => {
  const live = { expires_at: new Date(+now + mins(60)), revoked_at: null };
  assert.ok(share.linkState(live, { ride_status: "in_progress" }, now, 15).ok);
  assert.strictEqual(share.linkState({ ...live, expires_at: new Date(+now - 1) }, { ride_status: "accepted" }, now, 15).reason, "expired");
  assert.strictEqual(share.linkState({ ...live, revoked_at: now }, { ride_status: "accepted" }, now, 15).reason, "revoked");
  assert.ok(share.linkState(live, { ride_status: "completed", completed_at: new Date(+now - mins(10)) }, now, 15).ok);
  assert.strictEqual(share.linkState(live, { ride_status: "completed", completed_at: new Date(+now - mins(16)) }, now, 15).reason, "ended");
});

test("expiry counts from the pickup time for booked-ahead rides", () => {
  assert.strictEqual(+share.expiryFor({}, now, 12), +now + 12 * 3600000);
  const later = new Date(+now + 48 * 3600000);
  assert.strictEqual(+share.expiryFor({ scheduled_pickup_at: later }, now, 12), +later + 12 * 3600000);
  assert.strictEqual(+share.expiryFor({ scheduled_pickup_at: new Date(+now - 1000) }, now, 12), +now + 12 * 3600000);
});

test("public view hides everything but status once the trip is not live", () => {
  const row = { id: 1, ride_status: "completed", pickup_address: "A", created_at: now, current_lat: 6.5, driver_name: "D", plate_number: "X" };
  const v = share.publicView(row);
  assert.strictEqual(v.live, false);
  assert.strictEqual(v.ended, true);
  assert.deepStrictEqual(Object.keys(v.ride).sort(), ["created_at", "id", "pickup_address", "ride_status"]);
  const live = share.publicView({ ...row, ride_status: "in_progress" });
  assert.strictEqual(live.live, true);
  assert.ok(live.ride.current_lat);
  assert.ok(!("driver_phone" in live.ride));
});

test("hashing a token is stable and not the token", () => {
  assert.strictEqual(share.hashToken("abc"), share.hashToken("abc"));
  assert.notStrictEqual(share.hashToken("abc"), "abc");
});

test("selfie challenge: stable in a window, changes after, previous window accepted", () => {
  const a = selfie.challengeFor(5, now, "k");
  assert.strictEqual(a, selfie.challengeFor(5, new Date(+now + mins(1)), "k"));
  assert.notStrictEqual(selfie.challengeFor(5, now, "k"), selfie.challengeFor(6, now, "k"));
  assert.ok(selfie.challengeAccepted(5, a, new Date(+now + mins(16)), "k"));
  assert.ok(!selfie.challengeAccepted(5, a, new Date(+now + mins(40)), "k"));
  assert.ok(!selfie.challengeAccepted(5, "", now, "k"));
});

test("score decision: approve at 85, reject under 50, else a human", () => {
  assert.strictEqual(selfie.decideFromScore(85), "approved");
  assert.strictEqual(selfie.decideFromScore(84.9), "pending");
  assert.strictEqual(selfie.decideFromScore(50), "pending");
  assert.strictEqual(selfie.decideFromScore(49.9), "rejected");
  assert.strictEqual(selfie.decideFromScore(null), "pending");
  assert.strictEqual(selfie.decideFromScore("abc"), "pending");
});

test("selfie gate: none, pending ok, rejected blocks, stale blocks, recheck blocks, off allows", () => {
  const fresh = (status, ageH = 1) => ({ status, created_at: new Date(+now - ageH * 3600000) });
  const ev = (o) => selfie.evaluate({ now, required: true, driver: {}, ...o });
  assert.strictEqual(ev({ latest: null }).reason, "none");
  assert.ok(ev({ latest: fresh("pending") }).allowed);
  assert.ok(ev({ latest: fresh("approved") }).allowed);
  assert.strictEqual(ev({ latest: fresh("rejected") }).reason, "rejected");
  assert.strictEqual(ev({ latest: fresh("approved", 30) }).reason, "expired");
  assert.strictEqual(ev({ latest: fresh("approved"), driver: { selfie_recheck_required: true } }).reason, "recheck_required");
  assert.ok(ev({ latest: null, required: false }).allowed);
});

test("complaint categories and priority per role", () => {
  assert.ok(c.categoriesFor("rider").includes("vehicle_mismatch"));
  assert.ok(!c.categoriesFor("rider").includes("damage"));
  assert.ok(c.categoriesFor("driver").includes("damage"));
  assert.strictEqual(c.priorityFor("rider", "unsafe_driving"), "urgent");
  assert.strictEqual(c.priorityFor("rider", "rude"), "normal");
  assert.strictEqual(c.priorityFor("driver", "intoxicated"), "urgent");
  assert.strictEqual(c.priorityFor("driver", "no_show"), "normal");
  assert.strictEqual(c.priorityFor("rider", "damage"), "normal"); // not an urgent rider category
});

test("response target is 1 hour urgent, 24 hours normal", () => {
  assert.strictEqual(+c.respondByFor("urgent", now), +now + 3600000);
  assert.strictEqual(+c.respondByFor("normal", now), +now + 24 * 3600000);
});

test("role on ride: strangers get nothing", () => {
  const ride = { rider_id: 1, driver_user_id: 2 };
  assert.strictEqual(c.roleOnRide(ride, 1), "rider");
  assert.strictEqual(c.roleOnRide(ride, 2), "driver");
  assert.strictEqual(c.roleOnRide(ride, 3), null);
  assert.strictEqual(c.roleOnRide({ rider_id: 1, driver_user_id: null }, 3), null);
});

test("filing window: needs a driver, open until 72h after the end", () => {
  const base = { driver_user_id: 2 };
  assert.ok(!c.windowOpen({ ride_status: "requested", driver_user_id: null }, now));
  assert.ok(!c.windowOpen({ ride_status: "requested", ...base }, now));
  assert.ok(c.windowOpen({ ride_status: "accepted", ...base }, now));
  assert.ok(c.windowOpen({ ride_status: "in_progress", ...base }, now));
  assert.ok(c.windowOpen({ ride_status: "completed", completed_at: new Date(+now - 71 * 3600000), ...base }, now));
  assert.ok(!c.windowOpen({ ride_status: "completed", completed_at: new Date(+now - 73 * 3600000), ...base }, now));
});

console.log(`\n${passed} passed`);
