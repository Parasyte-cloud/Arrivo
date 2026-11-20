"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { emitRegistration, cleanMarketing, sha256 } = require("./conversions");

const ENV = { META_PIXEL_ID: "123", META_CAPI_TOKEN: "mt", TIKTOK_PIXEL_CODE: "TTX", TIKTOK_EVENTS_TOKEN: "tt" };
const user = { id: "u-1", role: "rider", email: " Ada@Example.com ", whatsapp_number: "+234 803 111 2222", name: "Ada Obi" };
const mk = { consent: true, eventId: "a".repeat(24), fbp: "fb.1.1700000000000.123456", ttp: "tt-abc_1", url: "https://express.ridearrivo.com/?utm=secret#x" };
const ok = (j) => ({ ok: true, status: 200, json: async () => j });

function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return reply(url); };
  return { calls, fetchImpl };
}
const reply = (url) => (url.includes("tiktok") ? ok({ code: 0 }) : ok({ events_received: 1 }));

test("sends hashed Meta and TikTok events with the shared event id", async () => {
  const r = recorder(reply);
  const out = await emitRegistration({ user, marketing: mk, ip: "1.2.3.4", userAgent: "UA" }, { env: ENV, fetchImpl: r.fetchImpl, now: 1700000000000 });
  assert.deepEqual(out.map((x) => [x.provider, x.ok]), [["meta", true], ["tiktok", true]]);
  const meta = r.calls[0].body.data[0], tt = r.calls[1].body.data[0];
  assert.equal(meta.event_name, "CompleteRegistration");
  assert.equal(meta.event_id, mk.eventId);
  assert.equal(tt.event_id, mk.eventId);
  assert.equal(meta.user_data.em[0], sha256("ada@example.com"));
  assert.equal(meta.user_data.ph[0], sha256("2348031112222"));
  assert.equal(tt.user.phone, sha256("+2348031112222"));
  assert.equal(tt.user.email, sha256("ada@example.com"));
  assert.equal(meta.user_data.external_id[0], sha256("u-1"));
  assert.equal(meta.event_time, 1700000000);
  assert.equal(meta.user_data.fbp, mk.fbp);
  assert.equal(tt.user.ttp, "tt-abc_1");
});

test("page url keeps origin and path only", async () => {
  const r = recorder(reply);
  await emitRegistration({ user, marketing: mk }, { env: ENV, fetchImpl: r.fetchImpl });
  assert.equal(r.calls[0].body.data[0].event_source_url, "https://express.ridearrivo.com/");
  assert.ok(!JSON.stringify(r.calls[0].body).includes("secret"));
});

test("no plain personal data leaves the server", async () => {
  const r = recorder(reply);
  await emitRegistration({ user, marketing: mk, ip: "1.2.3.4", userAgent: "UA" }, { env: ENV, fetchImpl: r.fetchImpl });
  for (const c of r.calls) {
    const s = JSON.stringify(c.body).toLowerCase();
    assert.ok(!s.includes("ada@example.com") && !s.includes("2348031112222") && !s.includes("ada obi"));
  }
});

test("no consent, bad id, GPC, non rider or no credentials means nothing is sent", async () => {
  for (const args of [
    { user, marketing: null },
    { user, marketing: { ...mk, consent: false } },
    { user, marketing: { ...mk, eventId: "nothex" } },
    { user, marketing: mk, gpc: true },
    { user: { ...user, role: "driver" }, marketing: mk },
  ]) {
    const r = recorder(reply);
    assert.deepEqual(await emitRegistration(args, { env: ENV, fetchImpl: r.fetchImpl }), []);
    assert.equal(r.calls.length, 0);
  }
  const r = recorder(reply);
  assert.deepEqual(await emitRegistration({ user, marketing: mk }, { env: {}, fetchImpl: r.fetchImpl }), []);
  assert.deepEqual(await emitRegistration({ user, marketing: mk }, { env: { ...ENV, CONVERSIONS_ENABLED: "false" }, fetchImpl: r.fetchImpl }), []);
  assert.equal(r.calls.length, 0);
});

test("test event codes are passed through when set", async () => {
  const r = recorder(reply);
  await emitRegistration({ user, marketing: mk }, { env: { ...ENV, META_TEST_EVENT_CODE: "TEST1", TIKTOK_TEST_EVENT_CODE: "TEST2" }, fetchImpl: r.fetchImpl });
  assert.equal(r.calls[0].body.test_event_code, "TEST1");
  assert.equal(r.calls[1].body.test_event_code, "TEST2");
});

test("a failing provider never throws and one failure does not stop the other", async () => {
  const errors = []; const orig = console.error; console.error = (m) => errors.push(String(m));
  try {
    const r = recorder((url) => { if (url.includes("graph.facebook")) throw new Error("boom token=mt"); return ok({ code: 40001 }); });
    const out = await emitRegistration({ user, marketing: mk }, { env: ENV, fetchImpl: r.fetchImpl });
    assert.deepEqual(out.map((x) => x.ok), [false, false]);
    assert.ok(errors.length >= 2);
    assert.ok(!errors.join(" ").includes("mt") || !errors.join(" ").includes("token=mt"), "no secret in logs");
  } finally { console.error = orig; }
});

test("cleanMarketing rejects odd values", () => {
  assert.equal(cleanMarketing({ consent: "true", eventId: "a".repeat(24) }), null);
  const c = cleanMarketing({ consent: true, eventId: "b".repeat(24), fbp: "<script>", url: "http://evil.com/x", ttp: "a b" });
  assert.deepEqual(c, { eventId: "b".repeat(24) });
});
