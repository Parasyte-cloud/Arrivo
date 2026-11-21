const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const np = require("./notifyPlatform");

const SECRET = "s".repeat(40);
function env(vars, fn) {
  const keys = ["NOTIFY_INGEST_URL", "NOTIFY_INGEST_SECRET", "NOTIFY_PLATFORM_CUSTOMER_EMAIL", "NOTIFY_PLATFORM_BOOKING_EMAIL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => delete process.env[k]);
  Object.assign(process.env, vars);
  return Promise.resolve(fn()).finally(() => keys.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));
}
const user = { id: "u1", email: "Ada@Example.com", name: "Ada Obi", created_at: "2026-10-25T10:00:00Z", email_verified: false };

test("does nothing when not configured", () => env({}, async () => {
  assert.deepEqual(await np.emitSignup(user), { sent: false, reason: "not_configured" });
}));

test("rejects a short secret or non-https url", () => env({ NOTIFY_INGEST_URL: "http://x.test/f", NOTIFY_INGEST_SECRET: SECRET }, async () => {
  assert.equal((await np.emitSignup(user)).reason, "not_configured");
}));

test("legacy flags are off by default and independent", async () => {
  await env({}, () => { assert.equal(np.platformOwnsCustomerEmail(), false); assert.equal(np.platformOwnsBookingEmail(), false); });
  await env({ NOTIFY_PLATFORM_CUSTOMER_EMAIL: "TRUE" }, () => { assert.equal(np.platformOwnsCustomerEmail(), true); assert.equal(np.platformOwnsBookingEmail(), false); });
});

test("signs the body the way the ingest function verifies it, with a stable event key", () => env({ NOTIFY_INGEST_URL: "https://x.test/f", NOTIFY_INGEST_SECRET: SECRET }, async () => {
  const realFetch = global.fetch; let seen;
  global.fetch = async (url, opts) => { seen = { url, opts }; return { status: 202 }; };
  try {
    assert.deepEqual(await np.emitSignup(user, { emailVerified: false }), { sent: true });
  } finally { global.fetch = realFetch; }
  const ts = seen.opts.headers["x-arrivo-timestamp"];
  const expected = crypto.createHmac("sha256", SECRET).update(`${ts}.${seen.opts.body}`).digest("hex");
  assert.equal(seen.opts.headers["x-arrivo-signature"], expected);
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.event_key, "user.signup.completed:u1");
  assert.equal(body.email, "ada@example.com");
  assert.equal(body.payload.marketing_consent, false);
}));

test("retries server errors but not client errors", () => env({ NOTIFY_INGEST_URL: "https://x.test/f", NOTIFY_INGEST_SECRET: SECRET }, async () => {
  const realFetch = global.fetch; const realErr = console.error; console.error = () => {};
  let calls = 0;
  try {
    global.fetch = async () => { calls++; return { status: 400 }; };
    assert.equal((await np.emitSignup(user)).sent, false);
    assert.equal(calls, 1);
    calls = 0;
    global.fetch = async () => { calls++; return calls < 2 ? { status: 503 } : { status: 202 }; };
    assert.equal((await np.emitSignup(user)).sent, true);
    assert.equal(calls, 2);
  } finally { global.fetch = realFetch; console.error = realErr; }
}));

test("a network failure never throws and never logs the email address", () => env({ NOTIFY_INGEST_URL: "https://x.test/f", NOTIFY_INGEST_SECRET: SECRET }, async () => {
  const realFetch = global.fetch; const realErr = console.error; const logs = [];
  console.error = (m) => logs.push(String(m));
  global.fetch = async () => { throw new Error("down"); };
  try { assert.equal((await np.emitSignup(user)).sent, false); } finally { global.fetch = realFetch; console.error = realErr; }
  assert.ok(logs.length === 1 && !/example\.com/i.test(logs[0]));
}));
