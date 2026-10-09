// Tests for the On the Go staff alert text and the status update check. Run directly:
//   node services/onTheGoAlert.test.js

const assert = require("assert");
const { buildAlertText, formatLagos, sendOnTheGoAlert } = require("./onTheGoAlert");
const { parseStatusUpdate, STATUSES } = require("./onTheGoStatus");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

const base = {
  id: 42,
  user_id: 7,
  pickup_address: "Lekki Phase 1",
  destination_address: "Murtala Muhammed Airport",
  flight_number: null,
  passenger_count: 2,
  contact_phone: "+2348012345678",
  requested_pickup_at: null,
  details: null,
  source_service: null,
};

(async () => {
  console.log("On the Go alert and status:");

  await test("alert without the new fields (older app build) still reads cleanly", () => {
    const t = buildAlertText(base, null);
    assert.ok(t.includes("ON THE GO request #42"));
    assert.ok(t.includes("as soon as possible"));
    assert.ok(t.includes("Ring: +2348012345678"));
    assert.ok(!t.includes("undefined") && !t.includes("null"));
  });

  await test("alert shows the requested time in Lagos time", () => {
    const t = buildAlertText({ ...base, requested_pickup_at: "2026-10-10T13:45:00.000Z" }, null);
    assert.ok(/Sat 10 Oct,? 14:45 \(Lagos time\)/.test(t), t);
  });

  await test("alert includes service, flight, details and rider", () => {
    const t = buildAlertText(
      { ...base, source_service: "Chauffeur", flight_number: "BA75", details: "Two large bags" },
      { name: "Ada", email: "ada@example.com" }
    );
    assert.ok(t.includes("(from Chauffeur)"));
    assert.ok(t.includes("Flight: BA75"));
    assert.ok(t.includes("Details: Two large bags"));
    assert.ok(t.includes("Rider: Ada (ada@example.com)"));
  });

  await test("formatLagos rejects junk", () => {
    assert.strictEqual(formatLagos("soon"), null);
    assert.strictEqual(formatLagos(null), null);
  });

  await test("sendOnTheGoAlert with no recipients configured skips and does not throw", async () => {
    delete process.env.OPS_ALERT_EMAILS;
    delete process.env.OPS_ALERT_WHATSAPP;
    const origError = console.error;
    console.error = () => {};
    try {
      const r = await sendOnTheGoAlert({ query: () => assert.fail("should not query") }, base);
      assert.deepStrictEqual(r, { skipped: true });
    } finally {
      console.error = origError;
    }
  });

  await test("sendOnTheGoAlert swallows a database failure", async () => {
    process.env.OPS_ALERT_EMAILS = "ops@example.com";
    const origError = console.error;
    console.error = () => {};
    try {
      const r = await sendOnTheGoAlert({ query: async () => { throw new Error("db down"); } }, base);
      assert.deepStrictEqual(r, { ok: false });
    } finally {
      console.error = origError;
      delete process.env.OPS_ALERT_EMAILS;
    }
  });

  await test("status update accepts the three statuses and nothing else", () => {
    for (const s of STATUSES) assert.deepStrictEqual(parseStatusUpdate({ status: s }), { value: s });
    for (const bad of [undefined, null, {}, { status: "done" }, { status: "" }, { status: 1 }, { status: "PENDING" }]) {
      assert.ok(parseStatusUpdate(bad).error, JSON.stringify(bad));
    }
  });

  console.log(`\n${passed} passed`);
})();
