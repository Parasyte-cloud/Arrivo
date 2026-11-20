// Builds i18n/review/sensitive-strings-review.csv: every legal, safety, privacy and money
// string in the rider app, English first, then the six translations, with empty columns for the
// reviewer. Run: node i18n/review/export-review.js
// A reviewer fills "Verdict" (OK / CHANGE) and "Correction"; send the file back and the corrections
// go into the locale files. Counsel reviews the Legal group in particular.
const fs = require("fs");
const path = require("path");
const langs = ["en", "fr", "es", "pt", "de", "zh", "hi"];
const flat = (o, p = "", out = {}) => { for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === "object") flat(v, p + k + ".", out); else out[p + k] = v; } return out; };
const L = Object.fromEntries(langs.map((l) => [l, flat(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales", l + ".json"), "utf8")))]));

const GROUPS = [
  ["New: service cards, request screen, Campus 16+ confirmation", [/^services\./, /^hub\./]],
  ["Legal: privacy, data and account deletion", [/^deleteAccountSection\./, /^privacyPolicyModal\./, /^login\.byContinuing/, /^signup\.(dataProtection|checkTheBox|mustAgree|tickBox)/, /^checkout\.(agreeDashCam|iAgreeThatThisRide|agreeCancellation)/, /^support\.faq(Q|A)0$/]],
  ["Safety: welfare check, alerts, emergency contacts", [/^welfareCheck\./, /^tracking\.(panic|supportHasBeenAlerted|iDonTFeelSafe|noEmergencyContact|canTSendAlert|couldnTSendAlert|noActiveRide)/, /^emergencyContacts\./, /^route\.(someoneWeCanReachIf|emergencyContactOptional)/]],
  ["Money: payment, refunds, extra charges, receipts", [/^checkout\.(everyRideIsPaidIn|paidButNotBooked|paymentStatus|paymentIsHandledByPaystack|notEnough|yourFamilyWalletIsEmpty)/, /^tracking\.(flightIssueBody|overage|fairFare|extraTimeCharge|tipPaymentStatus|entirelyOptional)/, /^receiptCard\./]],
];
const esc = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
const rows = [["Group", "Key", ...langs.map((l) => l.toUpperCase()), "Reviewer", "Verdict (OK or CHANGE)", "Correction (language and text)"].map(esc).join(",")];
let n = 0;
for (const [group, pats] of GROUPS) {
  for (const key of Object.keys(L.en)) {
    if (!pats.some((p) => p.test(key))) continue;
    rows.push([group, key, ...langs.map((l) => L[l][key]), "", "", ""].map(esc).join(","));
    n++;
  }
}
const out = path.join(__dirname, "sensitive-strings-review.csv");
fs.writeFileSync(out, "﻿" + rows.join("\n") + "\n");
console.log(`wrote ${n} strings x ${langs.length} languages to ${path.relative(process.cwd(), out)}`);
