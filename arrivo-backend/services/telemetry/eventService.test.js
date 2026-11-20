// The event bus relays events between Render instances through Postgres
// NOTIFY. These check the receiving side: events from another instance reach
// local subscribers, our own echo and junk payloads don't.

const assert = require("assert");
const { publish, subscribeAll, _test } = require("./eventService");
const { handleNotification, INSTANCE_ID, CHANNEL } = _test;

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
};

const seen = [];
const stop = subscribeAll((e) => seen.push(e));
const event = (type) => ({ type, payload: { rideId: 7 }, publishedAt: new Date().toISOString() });
const notify = (body, channel = CHANNEL) => handleNotification({ channel, payload: typeof body === "string" ? body : JSON.stringify(body) });

test("a local publish still reaches local subscribers straight away", () => {
  seen.length = 0;
  publish("ride.location.updated", { rideId: 7 });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].type, "ride.location.updated");
});

test("an event from another instance is delivered here", () => {
  seen.length = 0;
  notify({ from: "other-instance", event: event("alert.created") });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].type, "alert.created");
});

test("our own notification is ignored, so nobody gets an event twice", () => {
  seen.length = 0;
  notify({ from: INSTANCE_ID, event: event("alert.created") });
  assert.strictEqual(seen.length, 0);
});

test("unknown event types, bad JSON and other channels are dropped", () => {
  seen.length = 0;
  notify({ from: "other-instance", event: event("made.up.event") });
  notify("not json");
  notify({ from: "other-instance" });
  notify({ from: "other-instance", event: event("alert.created") }, "some_other_channel");
  assert.strictEqual(seen.length, 0);
});

stop();
console.log(`\n${passed} passed`);
