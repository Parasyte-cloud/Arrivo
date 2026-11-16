import assert from "node:assert/strict";
import fs from "node:fs";

const page = fs.readFileSync(
  new URL("../src/pages/TeamPage.jsx", import.meta.url),
  "utf8"
);

const api = fs.readFileSync(
  new URL("../src/api.js", import.meta.url),
  "utf8"
);

const css = fs.readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8"
);

assert.match(page, /Administration \/ Identity & Access/);
assert.match(page, /Add or invite staff/);
assert.match(page, /support@ridearrivo\.com/);
assert.match(page, /staffName/);
assert.match(page, /result\?\.created/);

assert.match(page, /Email address/);
assert.match(page, /mailto:\$\{p\.email\}/);
assert.match(page, /data-label="Email address"/);
assert.match(page, /team2ActionMenu/);

assert.match(api, /export const promotePerson/);
assert.match(api, /name = ""/);
assert.match(api, /name\.trim\(\)/);
assert.match(api, /note/);

assert.match(css, /\.team2Hero/);
assert.match(css, /\.team2InviteCard/);
assert.match(css, /\.team2DirectoryTable/);
assert.match(css, /\.team2Email/);
assert.match(css, /backdrop-filter/);
assert.match(css, /@media\(max-width:900px\)/);

console.log("PASS Team & Access modern UI contract");

assert.match(page, /Resend setup email/);
assert.match(page, /setup_status/);
assert.match(page, /invitation_delivery_status/);
assert.match(page, /emailDelivery/);
assert.match(page, /team2SetupState/);
assert.match(api, /resendPersonSetup/);
assert.match(css, /\.team2Setup-pending/);
assert.match(css, /\.team2Setup-expired/);
