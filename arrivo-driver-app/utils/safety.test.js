// Run directly: node utils/safety.test.js   (the file uses ES exports, so it is loaded the same way as i18n.test.js)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const load = (f, names) => new Function(fs.readFileSync(path.join(__dirname, f), "utf8").replace(/^export (const|function) /gm, "$1 ") + `\nreturn { ${names} };`)();
const s = load("safety.js", "DRIVER_COMPLAINT_CATEGORIES, cleanPin, pinReady, descriptionOk, safetyErrorKey, selfieNotice");
const { TRANSLATIONS } = load("../i18n/translations.js", "TRANSLATIONS");

let passed = 0;
const test = (n, f) => { try { f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n${e.stack}`); process.exitCode = 1; } };

test("PIN input keeps only 4 digits", () => {
  assert.strictEqual(s.cleanPin("12a3-45"), "1234");
  assert.strictEqual(s.cleanPin(null), "");
  assert.ok(s.pinReady("1234"));
  assert.ok(!s.pinReady("123"));
});

test("description needs 10 real characters", () => {
  assert.ok(!s.descriptionOk("short"));
  assert.ok(!s.descriptionOk("         x         "));
  assert.ok(s.descriptionOk("The rider shouted at me"));
});

test("every driver complaint category has text in every language", () => {
  for (const lang of Object.keys(TRANSLATIONS)) for (const c of s.DRIVER_COMPLAINT_CATEGORIES) assert.ok(TRANSLATIONS[lang][`cat_${c}`], `${lang} cat_${c}`);
});

test("every error code the safety endpoints can send to a driver has a message", () => {
  const has = (k) => Boolean(TRANSLATIONS.en[k]);
  for (const code of ["PIN_WRONG", "PIN_LOCKED", "SELFIE_REQUIRED", "CHALLENGE_EXPIRED", "TOO_MANY", "EXPRESS_PAUSED", "DUPLICATE", "WINDOW_CLOSED"]) {
    assert.strictEqual(s.safetyErrorKey({ code }, has), `e_${code}`);
  }
  assert.strictEqual(s.safetyErrorKey({ code: "NOPE" }, has), null);
});

test("selfie notice", () => {
  assert.strictEqual(s.selfieNotice({ required: false }), null);
  assert.strictEqual(s.selfieNotice({ required: true, allowed: true }), null);
  assert.deepStrictEqual(s.selfieNotice({ required: true, allowed: false, reason: "none" }), { key: "selfieNeedNew" });
  assert.strictEqual(s.selfieNotice({ required: true, allowed: false, reason: "rejected", latest: { note: "blurry" } }).params.note, "blurry");
});

console.log(`\n${passed} passed`);
