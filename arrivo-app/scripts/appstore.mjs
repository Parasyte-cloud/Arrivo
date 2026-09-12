// Talks to App Store Connect from the command line, so screenshots and
// metadata do not have to go through the website.
//
// Deliberately has no dependencies. fastlane would do this too but drags in a
// Ruby toolchain, which is miserable on Windows.
//
// ── Setting it up (once) ────────────────────────────────────────────────────
//
// App Store Connect > Users and Access > Integrations > App Store Connect API
// > Team Keys > "+". Give it the App Manager role. You get three things:
//
//   Issuer ID   a uuid at the top of that page
//   Key ID      10 characters, on the key's row
//   .p8 file    downloadable EXACTLY ONCE, so save it somewhere safe
//
// Point the script at them. Keep the .p8 outside the repo:
//
//   set ASC_ISSUER_ID=your-issuer-uuid
//   set ASC_KEY_ID=ABCD123456
//   set ASC_KEY_PATH=C:\Users\abios\keys\AuthKey_ABCD123456.p8
//
// ── Using it ────────────────────────────────────────────────────────────────
//
//   node scripts/appstore.mjs verify
//       Checks the key works and prints the app and the version it would
//       touch. Always run this first.
//
//   node scripts/appstore.mjs screenshots "C:\path\to\folder" [DISPLAY_TYPE]
//       Uploads every png/jpg in the folder, in filename order, replacing
//       whatever is in that slot. DISPLAY_TYPE defaults to APP_IPHONE_65,
//       which is the 1242x2688 / 1284x2778 slot.
//
// Screenshot upload is a three step dance: reserve a slot and get signed URLs,
// PUT the bytes to them, then commit with an md5 of the file. Apple silently
// ignores an uncommitted upload, which is why the commit is checked.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const API = "https://api.appstoreconnect.apple.com";
const APP_ID = process.env.ASC_APP_ID || "6794482846";
const LOCALE = process.env.ASC_LOCALE || "en-US";

function config() {
  const issuerId = process.env.ASC_ISSUER_ID;
  const keyId = process.env.ASC_KEY_ID;
  const keyPath = process.env.ASC_KEY_PATH;

  const missing = [
    !issuerId && "ASC_ISSUER_ID",
    !keyId && "ASC_KEY_ID",
    !keyPath && "ASC_KEY_PATH",
  ].filter(Boolean);

  if (missing.length) {
    console.error(`Missing: ${missing.join(", ")}. See the notes at the top of this file.`);
    process.exit(1);
  }
  if (!fs.existsSync(keyPath)) {
    console.error(`No .p8 file at ${keyPath}`);
    process.exit(1);
  }
  return { issuerId, keyId, privateKey: fs.readFileSync(keyPath, "utf8") };
}

// Apple wants an ES256 JWT. Node can emit the raw r||s form JWS needs directly
// with dsaEncoding, which saves unpicking the DER by hand.
function token() {
  const { issuerId, keyId, privateKey } = config();
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

  const signingInput =
    `${b64({ alg: "ES256", kid: keyId, typ: "JWT" })}.` +
    `${b64({ iss: issuerId, iat: now, exp: now + 900, aud: "appstoreconnect-v1" })}`;

  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  return `${signingInput}.${signature.toString("base64url")}`;
}

async function asc(pathname, { method = "GET", body } = {}) {
  const res = await fetch(pathname.startsWith("http") ? pathname : API + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = (data.errors || []).map((e) => `${e.title}: ${e.detail}`).join("; ");
    throw new Error(`${method} ${pathname} -> ${res.status} ${detail || text.slice(0, 300)}`);
  }
  return data;
}

// The version currently being prepared. Anything already submitted or live
// cannot be edited, so this refuses rather than silently doing nothing.
async function editableVersion() {
  const versions = await asc(`/v1/apps/${APP_ID}/appStoreVersions?limit=10`);
  const editable = versions.data.find((v) =>
    ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"].includes(
      v.attributes.appStoreState
    )
  );
  if (!editable) {
    const states = versions.data.map((v) => `${v.attributes.versionString} (${v.attributes.appStoreState})`);
    throw new Error(`No editable version. Found: ${states.join(", ") || "none"}`);
  }
  return editable;
}

async function localization(versionId) {
  const locs = await asc(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`);
  const loc = locs.data.find((l) => l.attributes.locale === LOCALE);
  if (!loc) {
    throw new Error(`No ${LOCALE} localization. Have: ${locs.data.map((l) => l.attributes.locale).join(", ")}`);
  }
  return loc;
}

async function cmdVerify() {
  const app = await asc(`/v1/apps/${APP_ID}`);
  console.log(`  app:      ${app.data.attributes.name} (${app.data.attributes.bundleId})`);

  const version = await editableVersion();
  console.log(`  version:  ${version.attributes.versionString}  [${version.attributes.appStoreState}]`);

  const loc = await localization(version.id);
  console.log(`  locale:   ${loc.attributes.locale}`);

  const sets = await asc(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=50`);
  if (!sets.data.length) {
    console.log("  screenshots: none uploaded yet");
  } else {
    for (const s of sets.data) {
      const shots = await asc(`/v1/appScreenshotSets/${s.id}/appScreenshots?limit=50`);
      console.log(`  screenshots: ${s.attributes.screenshotDisplayType} has ${shots.data.length}`);
    }
  }
  console.log("\n  key works.");
}

async function cmdScreenshots(dir, displayType = "APP_IPHONE_65") {
  if (!dir || !fs.existsSync(dir)) {
    console.error(`No folder at ${dir}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));

  if (!files.length) {
    console.error(`No images in ${dir}`);
    process.exit(1);
  }

  const version = await editableVersion();
  const loc = await localization(version.id);
  console.log(`  ${version.attributes.versionString} [${version.attributes.appStoreState}] ${LOCALE}`);

  const sets = await asc(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=50`);
  let set = sets.data.find((s) => s.attributes.screenshotDisplayType === displayType);

  if (!set) {
    const created = await asc("/v1/appScreenshotSets", {
      method: "POST",
      body: {
        data: {
          type: "appScreenshotSets",
          attributes: { screenshotDisplayType: displayType },
          relationships: {
            appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: loc.id } },
          },
        },
      },
    });
    set = created.data;
    console.log(`  created ${displayType} slot`);
  } else {
    // Replace rather than append, otherwise a re-run stacks duplicates and
    // Apple caps the slot at 10.
    const existing = await asc(`/v1/appScreenshotSets/${set.id}/appScreenshots?limit=50`);
    for (const shot of existing.data) {
      await asc(`/v1/appScreenshots/${shot.id}`, { method: "DELETE" });
    }
    if (existing.data.length) console.log(`  cleared ${existing.data.length} existing`);
  }

  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const name = path.basename(file);

    const reserved = await asc("/v1/appScreenshots", {
      method: "POST",
      body: {
        data: {
          type: "appScreenshots",
          attributes: { fileName: name, fileSize: bytes.length },
          relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } },
        },
      },
    });

    for (const op of reserved.data.attributes.uploadOperations) {
      const chunk = bytes.subarray(op.offset, op.offset + op.length);
      const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
      const put = await fetch(op.url, { method: op.method, headers, body: chunk });
      if (!put.ok) throw new Error(`upload of ${name} failed: ${put.status}`);
    }

    // Without this commit Apple keeps the reservation and shows nothing.
    const committed = await asc(`/v1/appScreenshots/${reserved.data.id}`, {
      method: "PATCH",
      body: {
        data: {
          type: "appScreenshots",
          id: reserved.data.id,
          attributes: {
            uploaded: true,
            sourceFileChecksum: crypto.createHash("md5").update(bytes).digest("hex"),
          },
        },
      },
    });

    const state = committed.data.attributes.assetDeliveryState?.state;
    console.log(`  uploaded ${name} (${state || "committed"})`);
  }

  console.log(`\n  ${files.length} screenshots in ${displayType}. Apple processes them for a minute or two.`);
}

const LIMITS = { description: 4000, keywords: 100, promotionalText: 170 };

// Pushes the listing copy from store/<locale>.json. Checked against Apple's
// length limits first, because the API rejects the whole request on one
// overlong field and the error does not say which.
async function cmdMetadata() {
  const file = path.join(process.cwd(), "store", `${LOCALE}.json`);
  if (!fs.existsSync(file)) {
    console.error(`No copy at ${file}`);
    process.exit(1);
  }
  const copy = JSON.parse(fs.readFileSync(file, "utf8"));

  const fields = ["description", "keywords", "promotionalText", "supportUrl", "marketingUrl"];
  const attributes = {};
  let tooLong = false;

  for (const f of fields) {
    if (copy[f] === undefined) continue;
    const value = String(copy[f]);
    const cap = LIMITS[f];
    if (cap && value.length > cap) {
      console.error(`  ${f}: ${value.length} characters, limit is ${cap}`);
      tooLong = true;
    } else {
      console.log(`  ${f}: ${value.length}${cap ? ` / ${cap}` : ""}`);
    }
    attributes[f] = value;
  }

  // The one rule that is ours rather than Apple's.
  const dashes = fields.filter((f) => copy[f] && /[–—]/.test(String(copy[f])));
  if (dashes.length) {
    console.error(`  em or en dash found in: ${dashes.join(", ")}`);
    tooLong = true;
  }

  if (tooLong) process.exit(1);

  const version = await editableVersion();
  const loc = await localization(version.id);
  console.log(`
  pushing to ${version.attributes.versionString} [${version.attributes.appStoreState}] ${LOCALE}`);

  await asc(`/v1/appStoreVersionLocalizations/${loc.id}`, {
    method: "PATCH",
    body: { data: { type: "appStoreVersionLocalizations", id: loc.id, attributes } },
  });

  console.log("  done.");
}

const [cmd, ...args] = process.argv.slice(2);

try {
  if (cmd === "verify") await cmdVerify();
  else if (cmd === "metadata") await cmdMetadata();
  else if (cmd === "screenshots") await cmdScreenshots(args[0], args[1]);
  else {
    console.log("usage:");
    console.log("  node scripts/appstore.mjs verify");
    console.log('  node scripts/appstore.mjs screenshots "C:\\path\\to\\folder" [APP_IPHONE_65]');
    process.exit(1);
  }
} catch (e) {
  console.error(`\n  ${e.message}`);
  process.exit(1);
}
