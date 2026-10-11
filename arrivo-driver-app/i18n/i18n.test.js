// Run directly: node i18n/i18n.test.js
// Guards the translations: every language has every key, uses the same
// {placeholders} as English, has no em dash, and the fallbacks work.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const load = (f, names) => new Function(fs.readFileSync(path.join(__dirname, f), "utf8").replace(/^export (const|function) /gm, "$1 ") + `\nreturn { ${names} };`)();
const { TRANSLATIONS, LANGUAGES } = load("translations.js", "TRANSLATIONS, LANGUAGES");
const { translate, pickLanguage, formatNumber } = load("i18n.js", "translate, pickLanguage, formatNumber");

let passed = 0;
const test = (n, f) => { try { f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n${e.stack}`); process.exitCode = 1; } };
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

test("every listed language has a table, and the 7 website languages are covered", () => {
  assert.deepStrictEqual(LANGUAGES.map((l) => l.code).sort(), ["de", "en", "es", "fr", "hi", "pt", "zh"]);
  for (const { code } of LANGUAGES) assert.ok(TRANSLATIONS[code], `missing table for ${code}`);
});

test("no language is missing a key, and none has an extra", () => {
  const en = Object.keys(TRANSLATIONS.en).sort();
  for (const { code } of LANGUAGES) {
    assert.deepStrictEqual(Object.keys(TRANSLATIONS[code]).sort(), en, `${code} keys differ from en`);
  }
});

test("placeholders match English in every language", () => {
  for (const { code } of LANGUAGES) {
    for (const [key, text] of Object.entries(TRANSLATIONS[code])) {
      assert.strictEqual(placeholders(text), placeholders(TRANSLATIONS.en[key]), `${code}.${key}: "${text}"`);
    }
  }
});

test("no empty strings and no em dash anywhere", () => {
  for (const { code } of LANGUAGES) {
    for (const [key, text] of Object.entries(TRANSLATIONS[code])) {
      assert.ok(text.trim().length > 0, `${code}.${key} is empty`);
      assert.ok(!text.includes("—"), `${code}.${key} has an em dash`);
    }
  }
});

test("every cash-out error code the backend can send has a message", () => {
  for (const code of ["NAME_MISMATCH", "ACCOUNT_NOT_FOUND", "INVALID_ACCOUNT_NUMBER", "UNKNOWN_BANK", "BANK_LOOKUP_UNAVAILABLE", "NO_BANK_ACCOUNT",
    "BELOW_MINIMUM", "ABOVE_MAXIMUM", "BANK_COOLING_OFF", "INSUFFICIENT_WITHDRAWABLE", "DAILY_LIMIT", "INSUFFICIENT_BALANCE", "CASHOUT_DISABLED", "INVALID_AMOUNT"]) {
    assert.ok(TRANSLATIONS.en[`e_${code}`], `no message for ${code}`);
  }
  for (const s of ["pending_review", "queued", "processing", "paid", "failed", "rejected", "reversed"]) assert.ok(TRANSLATIONS.en[`st_${s}`], `no status ${s}`);
});

test("translate fills placeholders, falls back to English, then to the key", () => {
  assert.strictEqual(translate(TRANSLATIONS, "en", "progressActive", { done: 3, target: 10 }), "3 of 10 trips done");
  assert.strictEqual(translate(TRANSLATIONS, "fr", "progressActive", { done: 3, target: 10 }), "3 courses sur 10");
  const partial = { en: { a: "Hello {n}" }, fr: {} };
  assert.strictEqual(translate(partial, "fr", "a", { n: 2 }), "Hello 2");
  assert.strictEqual(translate(partial, "xx", "a", { n: 2 }), "Hello 2");
  assert.strictEqual(translate(partial, "fr", "missing"), "missing");
  assert.strictEqual(translate(partial, "en", "a"), "Hello {n}", "an unfilled placeholder stays visible rather than becoming undefined");
});

test("device locales map to a supported language or English", () => {
  const sup = LANGUAGES.map((l) => l.code);
  assert.strictEqual(pickLanguage("fr-NG", sup), "fr");
  assert.strictEqual(pickLanguage("zh_Hans_CN", sup), "zh");
  assert.strictEqual(pickLanguage("yo-NG", sup), "en");
  assert.strictEqual(pickLanguage("", sup), "en");
  assert.strictEqual(pickLanguage(undefined, sup), "en");
});

test("numbers get thousands separators", () => {
  assert.strictEqual(formatNumber(1500), "1,500");
  assert.strictEqual(formatNumber(200000), "200,000");
  assert.strictEqual(formatNumber(999), "999");
  assert.strictEqual(formatNumber("45000.4"), "45,000");
});

console.log(`\n${passed} passed`);
