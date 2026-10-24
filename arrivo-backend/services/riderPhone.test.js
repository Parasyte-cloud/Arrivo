// Run: node services/riderPhone.test.js   (no database needed)
const assert = require("assert");
const { ensureRiderPhone, allowedWithoutPhone } = require("./riderPhone");

let passed = 0;
const test = async (n, f) => { try { await f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n${e.stack}`); process.exitCode = 1; } };

// Just enough of pg for these two queries.
function fakeDb(row) {
  const writes = [];
  return {
    writes,
    query: async (sql, params) => {
      if (sql.startsWith("SELECT")) return { rows: row ? [{ ...row }] : [] };
      if (sql.startsWith("UPDATE")) { writes.push(params); row.phone = params[1]; return { rows: [] }; }
      throw new Error("unexpected " + sql);
    },
  };
}
const rider = { id: 5, role: "rider" };

(async () => {
  await test("rider with no number is asked for one", async () => {
    const r = await ensureRiderPhone(fakeDb({ phone: null, whatsapp_number: null }), rider);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "PHONE_REQUIRED");
  });
  await test("a junk number on file counts as none", async () => {
    const r = await ensureRiderPhone(fakeDb({ phone: "08012", whatsapp_number: "" }), rider);
    assert.strictEqual(r.body.code, "PHONE_REQUIRED");
  });
  await test("phone on file is enough", async () => {
    assert.deepStrictEqual(await ensureRiderPhone(fakeDb({ phone: "+2348012345678" }), rider), { ok: true });
  });
  await test("WhatsApp on file is enough", async () => {
    assert.deepStrictEqual(await ensureRiderPhone(fakeDb({ phone: null, whatsapp_number: "+447700900123" }), rider), { ok: true });
  });
  await test("number sent with the booking is saved when the account has none", async () => {
    const db = fakeDb({ phone: null, whatsapp_number: null });
    assert.deepStrictEqual(await ensureRiderPhone(db, rider, " +2348012345678 "), { ok: true });
    assert.deepStrictEqual(db.writes, [[5, "+2348012345678"]]);
  });
  await test("a good number on file isn't overwritten from a booking", async () => {
    const db = fakeDb({ phone: "+2348011111111" });
    assert.deepStrictEqual(await ensureRiderPhone(db, rider, "+2348022222222"), { ok: true });
    assert.strictEqual(db.writes.length, 0);
  });
  await test("a badly formatted number is refused with its own code", async () => {
    const db = fakeDb({ phone: null });
    const r = await ensureRiderPhone(db, rider, "08012345678");
    assert.strictEqual(r.body.code, "PHONE_INVALID");
    assert.strictEqual(db.writes.length, 0);
  });
  await test("staff and drivers aren't checked", async () => {
    for (const role of ["admin", "support", "operations", "driver"]) {
      assert.deepStrictEqual(await ensureRiderPhone(fakeDb({ phone: null }), { id: 1, role }), { ok: true });
    }
  });
  await test("a paid booking is never held back over the phone", () => {
    assert.strictEqual(allowedWithoutPhone({ paymentReference: "T123" }), true);
    assert.strictEqual(allowedWithoutPhone({}), false);
    assert.strictEqual(allowedWithoutPhone(null), false);
  });
  console.log(`\nriderPhone: ${passed} passed`);
})();
