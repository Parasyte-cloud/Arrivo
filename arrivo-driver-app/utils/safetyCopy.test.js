// Guards the safety wording in utils/safetyCopy.js. Run directly:
//   node utils/safetyCopy.test.js
// Loads the module without a bundler (import-free data, same approach as
// privacyPolicy.test.js). The wording is legal copy, so these checks stop an
// accidental edit from dropping a disclosure or changing a retention period.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "safetyCopy.js");
const src = fs.readFileSync(file, "utf8");
assert.ok(!/^\s*import\s/m.test(src), "safetyCopy.js has to stay import-free for this test to load it");
const EM_DASH = String.fromCharCode(0x2014);
assert.ok(!src.includes(EM_DASH), "no em dashes in safety copy");

const load = new Function(
  src.replace(/^export const /gm, "const ") +
    "\nreturn { SAFETY_PRIVACY_URL, SAFETY_RETENTION, RECORDING_CONSENT, EMERGENCY_BUTTON_NOTICE, SUPPORT_CALL_NOTICE, PRE_TRIP_NOTICE };"
);
const c = load();

assert.deepStrictEqual(c.SAFETY_RETENTION, { emergencyAudioDays: 30, supportCallDays: 30, dashcamNoEventDays: 14 }, "retention periods follow counsel's advice");
assert.ok(/ridearrivo\.com\/privacy/.test(c.SAFETY_PRIVACY_URL), "links to the website privacy policy");

const consent = c.RECORDING_CONSENT.body;
for (const part of ["stored securely", "authorised RideArrivo safety staff", "every listen is logged", "30 days", "police", "covers you only", "privacy policy", "stop at any time"]) {
  assert.ok(consent.includes(part), `recording consent mentions: ${part}`);
}
assert.ok(/emergency/i.test(c.EMERGENCY_BUTTON_NOTICE.body) && /operations team/.test(c.EMERGENCY_BUTTON_NOTICE.body) && /112/.test(c.EMERGENCY_BUTTON_NOTICE.body), "emergency notice: emergencies only, alerts operations, 112");
assert.ok(/recorded/.test(c.SUPPORT_CALL_NOTICE) && /30 days/.test(c.SUPPORT_CALL_NOTICE), "support call notice says it is recorded and for how long");
const bullets = c.PRE_TRIP_NOTICE.bullets.join(" ");
for (const part of ["Emergency Button", "Live Support", "Dash cam", "video only", "14 days", "covers you only"]) {
  assert.ok(bullets.includes(part), `pre-trip notice mentions: ${part}`);
}
// The two apps carry the same file.
const other = path.join(__dirname, "..", "..", "arrivo-driver-app", "utils", "safetyCopy.js");
if (fs.existsSync(other)) assert.strictEqual(fs.readFileSync(other, "utf8"), src, "arrivo-app and arrivo-driver-app safetyCopy.js must be identical");
console.log("safetyCopy: all checks passed");
