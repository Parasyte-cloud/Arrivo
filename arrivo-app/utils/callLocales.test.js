// Every language must carry the same call keys and placeholders as English,
// and no copy may contain an em dash. Run: node utils/callLocales.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "i18n", "locales");
const load = (l) => JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), "utf8")).call;
const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
const holes = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join(",");

const en = Object.fromEntries(flat(load("en")));
let n = 0;
for (const l of ["fr", "de", "es", "pt", "hi", "zh"]) {
  const t = Object.fromEntries(flat(load(l)));
  assert.deepStrictEqual(Object.keys(t).sort(), Object.keys(en).sort(), `${l}: key set differs from en`);
  for (const [k, v] of Object.entries(t)) {
    assert.ok(v && v.trim(), `${l}.${k} is empty`);
    assert.strictEqual(holes(v), holes(en[k]), `${l}.${k}: placeholders differ from en`);
    n++;
  }
}
for (const l of ["en", "fr", "de", "es", "pt", "hi", "zh"]) {
  for (const [k, v] of flat(load(l))) assert.ok(!v.includes("—"), `${l}.${k} has an em dash`);
}
console.log(`callLocales: ok (${n} strings across 6 languages match English)`);
