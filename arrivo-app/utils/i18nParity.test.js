// Every rider language file must have exactly the same keys and the same {{placeholders}} as English,
// no em dash, and every t("key") used in the app must exist. Run: node utils/i18nParity.test.js
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const langs = ["en", "fr", "zh", "de", "hi", "es", "pt"];
const flat = (o, p = "", out = {}) => { for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === "object") flat(v, p + k + ".", out); else out[p + k] = v; } return out; };
const load = (l) => flat(JSON.parse(fs.readFileSync(path.join(root, "i18n/locales", l + ".json"), "utf8")));
const ph = (s) => (String(s).match(/\{\{\s*[\w.]+\s*\}\}/g) || []).map((x) => x.replace(/\s/g, "")).sort().join(",");
let fail = 0;
const bad = (m) => { fail++; console.error("FAIL " + m); };
const en = load("en");
for (const l of langs) {
  const d = load(l);
  for (const k of Object.keys(en)) {
    if (!(k in d)) bad(l + " missing " + k);
    else {
      if (ph(en[k]) !== ph(d[k])) bad(l + " placeholders differ " + k);
      if (String(d[k]).trim() === "") bad(l + " empty " + k);
    }
  }
  for (const k of Object.keys(d)) if (!(k in en)) bad(l + " extra " + k);
  for (const k of Object.keys(d)) if (/—/.test(d[k])) bad(l + " em dash " + k);
}
const files = [];
const walk = (dir) => { for (const f of fs.readdirSync(dir)) { if (f === "node_modules" || f === "i18n" || f.startsWith(".")) continue; const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.js$/.test(f) && !/\.test\.js$/.test(f)) files.push(p); } };
walk(root);
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)) if (!(m[1] in en)) bad(path.relative(root, f) + " uses unknown key " + m[1]);
}
if (fail) { console.error(fail + " problem(s)"); process.exit(1); }
console.log("i18n parity ok: " + Object.keys(en).length + " keys x " + langs.length + " languages");
