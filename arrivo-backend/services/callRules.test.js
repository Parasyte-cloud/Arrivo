const assert = require("assert");
const r = require("./callRules");

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}
const NOW = new Date("2026-10-11T12:00:00Z");
const ago = (min) => new Date(NOW.getTime() - min * 60000).toISOString();

console.log("availability:");
test("no ride", () => assert.strictEqual(r.availability(null).code, "ride_not_found"));
test("no driver yet", () => assert.strictEqual(r.availability({ ride_status: "requested", driver_user_id: null }).code, "no_driver"));
test("accepted is live", () => assert.strictEqual(r.availability({ ride_status: "accepted", driver_user_id: 2 }).canCall, true));
test("in progress is live", () => assert.strictEqual(r.availability({ ride_status: "in_progress", driver_user_id: 2 }).canCall, true));
test("completed 5 min ago still callable", () => {
  const a = r.availability({ ride_status: "completed", driver_user_id: 2, updated_at: ago(5) }, NOW);
  assert.ok(a.canCall); assert.strictEqual(a.code, "post_trip");
});
test("completed 31 min ago is closed", () => {
  const a = r.availability({ ride_status: "completed", driver_user_id: 2, updated_at: ago(31) }, NOW);
  assert.ok(!a.canCall); assert.strictEqual(a.code, "trip_over");
});
test("completed with no timestamp is closed", () => assert.ok(!r.availability({ ride_status: "completed", driver_user_id: 2 }, NOW).canCall));
test("cancelled is closed", () => assert.strictEqual(r.availability({ ride_status: "cancelled", driver_user_id: 2 }).code, "cancelled"));
test("unknown status is closed", () => assert.ok(!r.availability({ ride_status: "weird", driver_user_id: 2 }).canCall));

console.log("roleOnRide:");
test("rider, driver, stranger", () => {
  const ride = { rider_id: 1, driver_user_id: 2 };
  assert.strictEqual(r.roleOnRide(ride, 1), "rider");
  assert.strictEqual(r.roleOnRide(ride, "2"), "driver");
  assert.strictEqual(r.roleOnRide(ride, 3), null);
});
test("unassigned ride never matches a null user", () => assert.strictEqual(r.roleOnRide({ rider_id: 1, driver_user_id: null }, null), null));

console.log("transition:");
test("ringing to connected", () => assert.deepStrictEqual(r.transition("ringing", "connected", "callee"), { ok: true, next: "connected", changed: true }));
test("callee declines", () => assert.strictEqual(r.transition("ringing", "declined", "callee").next, "declined"));
test("caller cannot decline", () => assert.strictEqual(r.transition("ringing", "declined", "caller").code, "not_allowed"));
test("callee cannot cancel", () => assert.strictEqual(r.transition("ringing", "cancelled", "callee").code, "not_allowed"));
test("caller cancels", () => assert.strictEqual(r.transition("ringing", "cancelled", "caller").next, "cancelled"));
test("hang up while ringing counts as cancelled", () => assert.strictEqual(r.transition("ringing", "ended", "caller").next, "cancelled"));
test("missed while ringing", () => assert.strictEqual(r.transition("ringing", "missed", "caller").next, "missed"));
test("connected twice is a no-op", () => assert.deepStrictEqual(r.transition("connected", "connected", "caller"), { ok: true, next: "connected", changed: false }));
test("connected then ended", () => assert.strictEqual(r.transition("connected", "ended", "caller").next, "ended"));
test("connected then dropped", () => assert.strictEqual(r.transition("connected", "failed", "callee").next, "failed"));
test("connected cannot be declined or missed", () => {
  assert.strictEqual(r.transition("connected", "missed", "caller").code, "already_connected");
  assert.strictEqual(r.transition("connected", "declined", "callee").code, "already_connected");
});
test("repeated terminal report is accepted, changes nothing", () => {
  for (const s of ["ended", "missed", "declined", "cancelled", "failed"]) {
    const role = s === "declined" ? "callee" : s === "cancelled" ? "caller" : "caller";
    assert.deepStrictEqual(r.transition(s, s, role), { ok: true, next: s, changed: false });
  }
});
test("the other side's matching ended is accepted after ended or failed", () => {
  assert.ok(r.transition("ended", "ended", "callee").ok);
  assert.ok(r.transition("failed", "ended", "callee").ok);
  assert.strictEqual(r.transition("failed", "ended", "callee").changed, false);
});
test("a finished call cannot be revived", () => {
  for (const s of ["ended", "missed", "declined", "cancelled", "failed"]) {
    assert.strictEqual(r.transition(s, "connected", "caller").code, "already_finished");
  }
});
test("unknown events rejected", () => assert.strictEqual(r.transition("ringing", "explode", "caller").code, "unknown_event"));
test("unknown current state rejected", () => assert.strictEqual(r.transition("???", "connected", "caller").code, "bad_state"));

console.log("isStale:");
test("fresh ring not stale; old ring stale", () => {
  assert.ok(!r.isStale({ status: "ringing", created_at: ago(0.5) }, NOW));
  assert.ok(r.isStale({ status: "ringing", created_at: ago(2) }, NOW));
});
test("connected never stale", () => assert.ok(!r.isStale({ status: "connected", created_at: ago(300) }, NOW)));
test("null safe", () => assert.ok(!r.isStale(null)));

console.log("supportSuggested:");
test("failed always suggests", () => assert.ok(r.supportSuggested("failed", [], NOW)));
test("one miss does not", () => assert.ok(!r.supportSuggested("missed", [{ status: "missed", created_at: ago(1) }], NOW)));
test("two misses in a row do", () => assert.ok(r.supportSuggested("missed", [{ status: "missed", created_at: ago(1) }, { status: "missed", created_at: ago(3) }], NOW)));
test("a connected call resets the streak", () => assert.ok(!r.supportSuggested("missed", [{ status: "missed", created_at: ago(1) }, { status: "ended", created_at: ago(3) }, { status: "missed", created_at: ago(5) }], NOW)));
test("old misses are ignored", () => assert.ok(!r.supportSuggested("missed", [{ status: "missed", created_at: ago(1) }, { status: "missed", created_at: ago(40) }], NOW)));

console.log("normaliseMedia:");
test("only video is video", () => {
  assert.strictEqual(r.normaliseMedia("video"), "video");
  for (const v of ["audio", "", null, undefined, "VIDEO", {}, 5]) assert.strictEqual(r.normaliseMedia(v), "audio");
});

console.log(`\n${passed} passed`);
