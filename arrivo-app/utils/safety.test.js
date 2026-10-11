// Run directly: node utils/safety.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const load = (f, names) => new Function(fs.readFileSync(path.join(__dirname, f), "utf8").replace(/^export (const|function) /gm, "$1 ") + `\nreturn { ${names} };`)();
const s = load("safety.js", "RIDER_COMPLAINT_CATEGORIES, descriptionOk, shouldShowPin, spacedPin");

let passed = 0;
const test = (n, f) => { try { f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n${e.stack}`); process.exitCode = 1; } };

test("PIN card only when the server gives a PIN", () => {
  assert.ok(s.shouldShowPin({ required: true, pin: "1234" }));
  assert.ok(!s.shouldShowPin({ required: false, pin: "1234" }));
  assert.ok(!s.shouldShowPin({ required: true, pin: null }));
  assert.ok(!s.shouldShowPin(null));
  assert.strictEqual(s.spacedPin("4821"), "4 8 2 1");
});

test("description needs 10 real characters", () => {
  assert.ok(!s.descriptionOk("short"));
  assert.ok(s.descriptionOk("The driver took a wrong turn"));
});

test("every rider category has text in every language", () => {
  for (const lang of ["en", "fr", "es", "pt", "de", "zh", "hi"]) {
    const cat = JSON.parse(fs.readFileSync(path.join(__dirname, `../i18n/locales/${lang}.json`), "utf8")).safety.cat;
    for (const c of s.RIDER_COMPLAINT_CATEGORIES) assert.ok(cat[c] && cat[c].trim(), `${lang}.${c}`);
  }
});

test("every language has the same safety keys, and no em dash", () => {
  const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? flat(v, p + k + ".") : [p + k]));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "../i18n/locales/en.json"), "utf8")).safety;
  for (const lang of ["fr", "es", "pt", "de", "zh", "hi"]) {
    const raw = fs.readFileSync(path.join(__dirname, `../i18n/locales/${lang}.json`), "utf8");
    assert.ok(!raw.includes("—"), `${lang} has an em dash`);
    assert.deepStrictEqual(flat(JSON.parse(raw).safety).sort(), flat(en).sort(), lang);
  }
});

console.log(`\n${passed} passed`);
