// Run directly: node utils/callFlow.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "callFlow.js"), "utf8").replace(/^export (const|function) /gm, "$1 ");
const m = new Function(src + "\nreturn { PHASE, initialState, canTap, reduce, failureFromError, failureView, reportFor, ringRemaining, SUPPORT_LINE };")();
const { PHASE, initialState, canTap, reduce, failureFromError, failureView, reportFor, ringRemaining } = m;

let passed = 0;
const test = (n, f) => { try { f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n${e.stack}`); process.exitCode = 1; } };
const run = (acts, s = initialState()) => acts.reduce((st, a) => reduce(st, typeof a === "string" ? { type: a } : a), s);
const SESSION = { id: "s1" };

test("happy path", () => {
  const s = run(["TAP", "STARTING", { type: "STARTED", session: SESSION }, "CONNECTED", "HANGUP"]);
  assert.strictEqual(s.phase, PHASE.ENDED);
});
test("double and triple tap: only the first counts", () => {
  let s = run(["TAP", "TAP", "TAP"]);
  assert.strictEqual(s.phase, PHASE.CHECKING);
  s = run(["STARTING", "TAP", { type: "STARTED", session: SESSION }, "TAP", "TAP"], s);
  assert.strictEqual(s.phase, PHASE.RINGING); assert.strictEqual(s.session.id, "s1");
});
test("cannot tap while connected", () => assert.strictEqual(canTap(run(["TAP", "STARTING", { type: "STARTED", session: SESSION }, "CONNECTED"])), false));
test("cancel while ringing returns to idle", () => {
  const s = run(["TAP", "STARTING", { type: "STARTED", session: SESSION }, "CANCEL"]);
  assert.strictEqual(s.phase, PHASE.IDLE); assert.strictEqual(s.session, null);
});
test("cancel while checking returns to idle, and a late STARTED does not bring the call back", () => {
  const s = run(["TAP", "CANCEL", { type: "STARTED", session: SESSION }]);
  assert.strictEqual(s.phase, PHASE.IDLE);
});
test("late CONNECTED after cancel is ignored", () => assert.strictEqual(run(["TAP", "STARTING", { type: "STARTED", session: SESSION }, "CANCEL", "CONNECTED"]).phase, PHASE.IDLE));
test("ring timeout lands on a failure with retry", () => {
  const s = run(["TAP", "STARTING", { type: "STARTED", session: SESSION }, "RING_TIMEOUT"]);
  assert.strictEqual(s.phase, PHASE.FAILED); assert.strictEqual(s.failure.code, "no_answer"); assert.strictEqual(s.failure.retry, true);
});
test("ring timeout after connected does nothing", () => assert.strictEqual(run(["TAP", "STARTING", { type: "STARTED", session: SESSION }, "CONNECTED", "RING_TIMEOUT"]).phase, PHASE.CONNECTED));
test("declined cannot be retried blindly but still offers chat and support", () => {
  const s = run(["TAP", "STARTING", { type: "STARTED", session: SESSION }, "DECLINED"]);
  assert.strictEqual(s.failure.retry, false);
  const v = failureView(s.failure, { counterpart: "your driver" });
  assert.deepStrictEqual(v.actions, ["chat", "support"]);
});
test("mid-call drop is a failure that can be retried", () => {
  const s = run(["TAP", "STARTING", { type: "STARTED", session: SESSION }, "CONNECTED", "DROPPED"]);
  assert.strictEqual(s.phase, PHASE.FAILED); assert.strictEqual(s.failure.code, "dropped");
});
test("tap again from a failure starts fresh", () => {
  let s = run(["TAP", "STARTING", { type: "FAILED", failure: { code: "network" } }]);
  assert.strictEqual(s.phase, PHASE.FAILED);
  s = reduce(s, { type: "TAP" });
  assert.strictEqual(s.phase, PHASE.CHECKING); assert.strictEqual(s.failure, null);
});
test("FAILED from idle is ignored", () => assert.strictEqual(run([{ type: "FAILED", failure: { code: "x" } }]).phase, PHASE.IDLE));
test("support: busy then done keeps the ticket; double press guarded by supportBusy", () => {
  let s = run(["TAP", { type: "FAILED", failure: { code: "call_failed" } }, "SUPPORT_BUSY"]);
  assert.ok(s.supportBusy);
  s = reduce(s, { type: "SUPPORT_DONE", ticketId: 42 });
  assert.strictEqual(s.supportBusy, false); assert.strictEqual(s.ticketId, 42);
  s = reduce(s, { type: "SUPPORT_FAILED" });
  assert.strictEqual(s.ticketId, 42);
});
test("dismiss resets only finished states", () => {
  const ringing = run(["TAP", "STARTING", { type: "STARTED", session: SESSION }]);
  assert.strictEqual(reduce(ringing, { type: "DISMISS" }).phase, PHASE.RINGING);
  assert.strictEqual(reduce(run(["TAP", { type: "FAILED", failure: { code: "x" } }]), { type: "DISMISS" }).phase, PHASE.IDLE);
});
test("unknown actions leave state alone", () => { const s = initialState(); assert.strictEqual(reduce(s, { type: "???" }), s); });

test("failureFromError: offline, rate limit, signed out, server error, closed ride", () => {
  assert.strictEqual(failureFromError(new TypeError("Network request failed")).code, "network");
  assert.strictEqual(failureFromError({ status: 429, message: "slow down" }).code, "rate_limited");
  const so = failureFromError({ status: 401 }); assert.strictEqual(so.code, "signed_out"); assert.strictEqual(so.retry, false);
  assert.strictEqual(failureFromError({ status: 502, code: "call_failed", sessionId: "s9" }).sessionId, "s9");
  assert.strictEqual(failureFromError({ status: 409, code: "trip_over" }).code, "trip_over");
  assert.strictEqual(failureFromError(null).code, "unknown");
});
test("every failure code gets copy and always offers support (except signed out)", () => {
  for (const code of ["no_answer", "declined", "dropped", "network", "rate_limited", "calling_unavailable", "call_failed", "incoming_call", "already_in_call", "no_driver", "not_active", "cancelled", "trip_over", "weird_new_code"]) {
    const v = failureView({ code, retry: true });
    assert.ok(v.title && v.body, code); assert.ok(v.actions.includes("support"), code);
    assert.strictEqual(v.reassurance, "We'll take care of you.");
  }
  assert.ok(!failureView({ code: "signed_out" }).actions.includes("support"));
});
test("closed rides do not offer chat or retry", () => {
  for (const code of ["cancelled", "trip_over", "no_driver"]) {
    const v = failureView({ code, retry: false });
    assert.ok(!v.actions.includes("chat") && !v.actions.includes("retry"), code);
  }
});
test("chat hidden when it is known to be unavailable", () => assert.ok(!failureView({ code: "network", retry: true }, { canChat: false }).actions.includes("chat")));

test("reportFor: joined, hang-up, caller cancels before answer, callee declines, reconnect failure", () => {
  const seen = { joined: false };
  assert.deepStrictEqual(reportFor("joining", "joined", { isCaller: true, seen }), { event: "connected" });
  assert.deepStrictEqual(reportFor("ringing", "left", { isCaller: true, seen }), { event: "cancelled" });
  assert.deepStrictEqual(reportFor("ringing", "left", { isCaller: false, seen }), { event: "declined" });
  assert.strictEqual(reportFor("idle", "idle", { isCaller: true, seen }), null);
  const joined = { joined: true };
  assert.deepStrictEqual(reportFor("joined", "left", { isCaller: false, seen: joined }), { event: "ended" });
  assert.strictEqual(reportFor("joined", "reconnecting-failed", { isCaller: true, seen: joined }).event, "failed");
  assert.strictEqual(reportFor("joined", "reconnecting", { isCaller: true, seen: joined }), null);
});
test("ringRemaining never goes negative", () => {
  assert.strictEqual(ringRemaining(0, 10000, 45), 35);
  assert.strictEqual(ringRemaining(0, 99999, 45), 0);
});
console.log(`\n${passed} passed`);
