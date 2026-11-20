// A rider's ID photo in ArrivoOps, against a real Postgres and the real admin router with the real guards.
//
//   DATABASE_URL=postgres://localhost/... node routes/adminRiderIdDocument.integration.test.js
//   npm run test:integration
//
// What this protects, in the order it matters:
//   1. The riders LIST never carries the photo. users.id_document_url holds the whole image as a data URL (up to
//      6MB), so selecting it put up to 200 riders' passport and NIN photos into one response that Operations
//      could read. The list now carries has_id_document instead.
//   2. The photo comes from its own route, one rider at a time, and only for someone with manage on Riders
//      (admin and the owner). Support and Operations have view, so they are refused, and so is everyone who is
//      not staff, with or without a token.
//   3. The route cannot be used to run anything: only PNG, JPEG and WEBP are ever served, with the type fixed by
//      the server, so a bad stored value comes back as an error and never as HTML or SVG.
//   4. The photo is not cached and deleted accounts do not give theirs up.

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");
const adminRouter = require("./admin");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message}`);
    process.exitCode = 1;
  }
}

const app = express();
app.use(express.json());
app.use("/api/admin", adminRouter);
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

const tag = `idtest${Date.now()}`;
const users = {};

const PNG = Buffer.from("not-a-real-png-but-fixed-bytes-0123456789");
const JPG = Buffer.from("not-a-real-jpeg-but-fixed-bytes-abcdef");
const WEBP = Buffer.from("not-a-real-webp-but-fixed-bytes-ABCDEF");
const dataUrl = (type, bytes) => `data:image/${type};base64,${bytes.toString("base64")}`;

function tokenFor(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "10m" });
}

async function get(path, user) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: user ? { Authorization: `Bearer ${tokenFor(user)}` } : {},
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: bytes.toString("utf8") };
}

async function makeUser(label, role, { doc = null, deletedAt = null } = {}) {
  const email = `${tag}-${label}@example.test`;
  const r = await pool.query(
    `INSERT INTO users (name, email, phone, password_hash, role, id_document_url, id_verification_status, deleted_at)
     VALUES ($1, $2, '+2348011112222', 'x', $3, $4, $5, $6)
     RETURNING id, email, role`,
    [`${label} user`, email, role, doc, doc ? "pending" : "unverified", deletedAt]
  );
  return r.rows[0];
}

async function cleanup() {
  await pool.query("DELETE FROM users WHERE email LIKE $1", [`${tag}%`]);
}

(async () => {
  await ready;
  await new Promise((resolve) => server.listen(0, resolve));
  await cleanup();

  try {
    users.admin = await makeUser("admin", "admin");
    users.support = await makeUser("support", "support");
    users.ops = await makeUser("ops", "operations");
    users.driver = await makeUser("driver", "driver");
    users.withPng = await makeUser("withpng", "rider", { doc: dataUrl("png", PNG) });
    users.withJpg = await makeUser("withjpg", "rider", { doc: dataUrl("jpeg", JPG) });
    users.withWebp = await makeUser("withwebp", "rider", { doc: dataUrl("webp", WEBP) });
    users.noDoc = await makeUser("nodoc", "rider");
    users.gone = await makeUser("gone", "rider", { doc: dataUrl("png", PNG), deletedAt: new Date() });
    users.html = await makeUser("html", "rider", { doc: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" });
    users.svg = await makeUser("svg", "rider", { doc: "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSkvPg==" });

    const mine = (rows) => rows.filter((r) => String(r.email).startsWith(tag));
    const idUrl = (u) => `/api/admin/riders/${u.id}/id-document`;

    // ── 1. The list does not carry the photo ─────────────────────────

    for (const who of ["admin", "support", "ops"]) {
      await test(`${who} gets the riders list with a flag and no photo anywhere in it`, async () => {
        const r = await get("/api/admin/riders", users[who]);
        assert.equal(r.status, 200);
        const body = JSON.parse(r.text);
        const riders = mine(body.riders);
        assert.ok(riders.length >= 6, "the test riders are in the list");
        for (const rider of riders) assert.ok(!("id_document_url" in rider), "no id_document_url field");
        // Nothing that looks like an embedded image either, whatever the field is called.
        assert.ok(!r.text.includes("data:image"), "no data URL in the response");
        assert.ok(!r.text.includes(PNG.toString("base64")), "no photo bytes in the response");
        const flag = (u) => riders.find((x) => x.id === u.id).has_id_document;
        assert.strictEqual(flag(users.withPng), true);
        assert.strictEqual(flag(users.withJpg), true);
        assert.strictEqual(flag(users.noDoc), false);
        // The review state is still there for the queue.
        assert.equal(riders.find((x) => x.id === users.withPng.id).id_verification_status, "pending");
      });
    }

    // ── 2. Who can fetch the photo ────────────────────────────────────

    await test("an admin gets the exact image, with a fixed type and no caching", async () => {
      const r = await get(idUrl(users.withPng), users.admin);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "image/png");
      assert.ok(r.bytes.equals(PNG), "the bytes are exactly what was uploaded");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.match(r.headers.get("cache-control"), /no-store/);
      assert.match(r.headers.get("cache-control"), /private/);
    });

    await test("JPEG and WEBP come back with their own types", async () => {
      const j = await get(idUrl(users.withJpg), users.admin);
      assert.equal(j.headers.get("content-type"), "image/jpeg");
      assert.ok(j.bytes.equals(JPG));
      const w = await get(idUrl(users.withWebp), users.admin);
      assert.equal(w.headers.get("content-type"), "image/webp");
      assert.ok(w.bytes.equals(WEBP));
    });

    await test("support and operations are refused: they can view Riders but not the ID photo", async () => {
      for (const who of ["support", "ops"]) {
        const r = await get(idUrl(users.withPng), users[who]);
        assert.equal(r.status, 403, `${who} must be refused`);
        assert.ok(!r.bytes.includes(PNG), "and nothing of the photo leaks in the refusal");
      }
    });

    await test("the doubled-slash and upper-case tricks do not get past the check", async () => {
      for (const path of [
        `/api/admin//riders/${users.withPng.id}/id-document`,
        `/API/ADMIN/RIDERS/${users.withPng.id}/ID-DOCUMENT`,
        `/api/admin/riders/${users.withPng.id}/id-document/`,
      ]) {
        const r = await get(path, users.support);
        assert.ok([403, 404].includes(r.status), `${path} gave ${r.status}`);
        assert.ok(!r.bytes.includes(PNG), `${path} leaked the photo`);
      }
    });

    await test("a driver and a stranger with no token get nothing", async () => {
      assert.equal((await get(idUrl(users.withPng), users.driver)).status, 403);
      assert.equal((await get(idUrl(users.withPng), null)).status, 401);
    });

    await test("the owner can hand the photo to one person on purpose", async () => {
      await pool.query("UPDATE users SET staff_permissions = $1 WHERE id = $2", [JSON.stringify({ riders: "manage" }), users.support.id]);
      try {
        const r = await get(idUrl(users.withPng), users.support);
        assert.equal(r.status, 200);
        assert.ok(r.bytes.equals(PNG));
      } finally {
        await pool.query("UPDATE users SET staff_permissions = NULL WHERE id = $1", [users.support.id]);
      }
      assert.equal((await get(idUrl(users.withPng), users.support)).status, 403, "and it is gone again once taken back");
    });

    await test("taking Riders down to view takes the photo away from an admin too", async () => {
      await pool.query("UPDATE users SET staff_permissions = $1 WHERE id = $2", [JSON.stringify({ riders: "view" }), users.admin.id]);
      try {
        assert.equal((await get(idUrl(users.withPng), users.admin)).status, 403);
        assert.equal((await get("/api/admin/riders", users.admin)).status, 200, "the list is still theirs");
      } finally {
        await pool.query("UPDATE users SET staff_permissions = NULL WHERE id = $1", [users.admin.id]);
      }
    });

    // ── 3. Only images are ever served ────────────────────────────────

    await test("a stored value that is not a PNG, JPEG or WEBP is an error and never served as HTML or SVG", async () => {
      for (const u of [users.html, users.svg]) {
        const r = await get(idUrl(u), users.admin);
        assert.equal(r.status, 422);
        assert.match(r.headers.get("content-type"), /json/);
        assert.ok(!/<script|<svg/i.test(r.text));
      }
    });

    // ── 4. Missing and removed ────────────────────────────────────────

    await test("no photo, no such rider, a driver id, a deleted account and a bad id are each refused plainly", async () => {
      assert.equal((await get(idUrl(users.noDoc), users.admin)).status, 404);
      assert.equal((await get("/api/admin/riders/999999999/id-document", users.admin)).status, 404);
      assert.equal((await get(idUrl(users.driver), users.admin)).status, 404, "only riders have an ID photo here");
      assert.equal((await get(idUrl(users.gone), users.admin)).status, 404, "a deleted account does not give its photo up");
      assert.equal((await get("/api/admin/riders/abc/id-document", users.admin)).status, 400);
    });
  } finally {
    await cleanup();
    server.close();
    await pool.end();
  }
  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
