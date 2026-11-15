// Pure rules of the welfare check. No database. PArAsYtE
const assert = require("assert");
const { decide, answerState, metres, RULES } = require("./welfareCheck");

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok ", name); };
const MIN = 60000;
const A = { lat: 6.5244, lng: 3.3792 };
const near = { lat: 6.52445, lng: 3.37922 };       // about 6 m away
const far = { lat: 6.5344, lng: 3.3792 };          // about 1.1 km away
const T0 = 1_000_000_000_000;
const ctx = (now, extra = {}) => ({ now, tripStartedAt: T0 - 60 * MIN, destination: null, ...extra });
const still = (state, mins, point = near) => decide(state, { ...point, accuracy: 10 }, ctx(T0 + mins * MIN));

ok("distance helper is about right", () => { assert(Math.abs(metres(A, far) - 1112) < 15); });

ok("first ping only starts watching", () => {
  const r = decide(null, { ...A, accuracy: 10 }, ctx(T0));
  assert.equal(r.action, "none"); assert.equal(r.state.status, "ok");
});

function stillFor(mins) {
  let s = decide(null, { ...A, accuracy: 10 }, ctx(T0)).state;
  let r;
  for (let m = 0.5; m <= mins; m += 0.5) { r = still(s, m); s = r.state; }
  return r;
}
ok("asks after 5 minutes still", () => { assert.equal(stillFor(4.5).action, "none"); assert.equal(stillFor(5).action, "ask"); });

ok("moving resets the clock", () => {
  let s = decide(null, { ...A, accuracy: 10 }, ctx(T0)).state;
  s = still(s, 4.5).state;
  const moved = still(s, 5, far); assert.equal(moved.action, "none"); assert.equal(moved.reason, "moving");
  assert.equal(still(moved.state, 5.5, far).action, "none");
});

ok("a silent gap restarts instead of counting as stationary", () => {
  const s = decide(null, { ...A, accuracy: 10 }, ctx(T0)).state;
  const r = still(s, 9);   // 9 minutes with no ping in between
  assert.equal(r.action, "none"); assert.equal(r.reason, "silent_gap");
});

ok("poor GPS accuracy is ignored", () => {
  const s = decide(null, { ...A, accuracy: 10 }, ctx(T0)).state;
  const r = decide(s, { ...near, accuracy: 250 }, ctx(T0 + 6 * MIN));
  assert.equal(r.reason, "low_accuracy"); assert.equal(r.action, "none");
});

ok("pauses in the first 3 minutes of a trip", () => {
  let s = decide(null, { ...A, accuracy: 10 }, { now: T0, tripStartedAt: T0 - 10_000, destination: null }).state;
  s.anchorAt = T0 - 10 * MIN;
  const r = decide(s, { ...near, accuracy: 10 }, { now: T0 + 30_000, tripStartedAt: T0 - 10_000, destination: null });
  assert.equal(r.reason, "trip_just_started");
});

ok("pauses within 200 m of the destination", () => {
  let s = decide(null, { ...A, accuracy: 10 }, ctx(T0)).state;
  s = still(s, 4.5).state;
  const r = decide(s, { ...near, accuracy: 10 }, ctx(T0 + 5 * MIN, { destination: A }));
  assert.equal(r.reason, "near_destination"); assert.equal(r.action, "none");
});

ok("yes resets and doubles the next wait, capped at 4x", () => {
  let s = stillFor(5).state;
  let a = answerState(s, true, T0 + 5 * MIN); assert.equal(a.state.multiplier, 2); assert.equal(a.state.askedAt, null);
  a = answerState({ ...a.state, askedAt: 1 }, true, T0); assert.equal(a.state.multiplier, 4);
  a = answerState({ ...a.state, askedAt: 1 }, true, T0); assert.equal(a.state.multiplier, 4);
});

ok("doubled wait is respected", () => {
  let s = { anchor: A, anchorAt: T0, lastPingAt: T0, multiplier: 2, askedAt: null, status: "ok" };
  let r;
  for (let m = 0.5; m <= 9.5; m += 0.5) { r = still(s, m); s = r.state; assert.equal(r.action, "none"); }
  assert.equal(still(s, 10).action, "ask");
});

ok("no, or no answer in 2 minutes, raises", () => {
  const asked = stillFor(5).state;
  assert.equal(answerState(asked, false, T0).action, "raise");
  const late = decide(asked, { ...near, accuracy: 10 }, ctx(asked.askedAt + 2 * MIN));
  assert.equal(late.action, "raise"); assert.equal(late.reason, "no_answer");
  assert.equal(decide(late.state, { ...near, accuracy: 10 }, ctx(asked.askedAt + 3 * MIN)).action, "none");
});

ok("answering when nothing was asked changes nothing", () => {
  const s = decide(null, { ...A, accuracy: 10 }, ctx(T0)).state;
  assert.equal(answerState(s, true, T0).action, "none");
  assert.deepEqual(answerState(s, true, T0).state, s);
});

ok("bad coordinates are refused", () => {
  assert.equal(decide(null, { lat: 999, lng: 0 }, ctx(T0)).reason, "bad_position");
});
console.log(`${n} passed`);
