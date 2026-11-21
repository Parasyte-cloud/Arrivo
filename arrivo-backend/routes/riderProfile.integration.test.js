// Rider profile (name, phone, email, photo, home address) against a REAL Postgres.
//   DATABASE_URL=postgres://... node routes/riderProfile.integration.test.js
const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";

const express = require("express");
require("express-async-errors");
const { pool } = require("../db/db");
const authRouter = require("./auth");

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`); process.exitCode = 1; }
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/api/auth", authRouter);
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

async function api(path, { method = "GET", token, body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/auth${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, body: json, text };
}

const stamp = Date.now();
const made = [];
async function mkRider(n) {
  const r = await pool.query(
    "INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1,$2,$3,'x','rider') RETURNING id",
    [`Rider ${n}`, `profile-${n}-${stamp}@example.com`, "+2348100000001"]
  );
  const id = r.rows[0].id;
  made.push(id);
  return { id, email: `profile-${n}-${stamp}@example.com`, token: jwt.sign({ id, email: `u${id}@example.com`, role: "rider", tv: 0 }, process.env.JWT_SECRET, { algorithm: "HS256" }) };
}
// A 1x1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

(async () => {
  await new Promise((r) => server.listen(0, r));

  await test("a new rider has no home address", async () => {
    const u = await mkRider(1);
    const r = await api("/me", { token: u.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.home_address, null);
  });

  await test("name, phone, home address and photo save together and come back", async () => {
    const u = await mkRider(2);
    const r = await api("/me", {
      method: "PATCH", token: u.token,
      body: { name: "  Ada Obi  ", phone: "+2348012345678", homeAddress: "  12 Admiralty Way, Lekki  ", avatarDataUrl: PNG },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.user.name, "Ada Obi");
    assert.equal(r.body.user.phone, "+2348012345678");
    assert.equal(r.body.user.home_address, "12 Admiralty Way, Lekki");
    assert.equal(r.body.user.avatar_url, PNG);
    assert.equal(r.body.user.email, u.email);
    const again = await api("/me", { token: u.token });
    assert.equal(again.body.user.home_address, "12 Admiralty Way, Lekki");
    assert.equal(again.body.user.name, "Ada Obi");
  });

  await test("saving one field leaves the others alone", async () => {
    const u = await mkRider(3);
    await api("/me", { method: "PATCH", token: u.token, body: { homeAddress: "5 Marina Rd", name: "Bola Ade" } });
    const r = await api("/me", { method: "PATCH", token: u.token, body: { phone: "+2348099999999" } });
    assert.equal(r.body.user.home_address, "5 Marina Rd");
    assert.equal(r.body.user.name, "Bola Ade");
    assert.equal(r.body.user.phone, "+2348099999999");
  });

  await test("home address can be cleared with an empty string or null", async () => {
    const u = await mkRider(4);
    await api("/me", { method: "PATCH", token: u.token, body: { homeAddress: "5 Marina Rd" } });
    assert.equal((await api("/me", { method: "PATCH", token: u.token, body: { homeAddress: "   " } })).body.user.home_address, null);
    await api("/me", { method: "PATCH", token: u.token, body: { homeAddress: "again" } });
    assert.equal((await api("/me", { method: "PATCH", token: u.token, body: { homeAddress: null } })).body.user.home_address, null);
  });

  await test("bad input is refused and nothing is changed", async () => {
    const u = await mkRider(5);
    await api("/me", { method: "PATCH", token: u.token, body: { homeAddress: "keep me" } });
    const cases = [
      { homeAddress: "x".repeat(301) },
      { homeAddress: 12345 },
      { name: "" },
      { name: "   " },
      { name: "n".repeat(101) },
      { name: { first: "x" } },
      { phone: "08012345678" }, // no country code
    ];
    for (const body of cases) {
      const r = await api("/me", { method: "PATCH", token: u.token, body });
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    }
    const me = await api("/me", { token: u.token });
    assert.equal(me.body.user.home_address, "keep me");
    assert.equal(me.body.user.name, "Rider 5");
  });

  await test("a rider cannot change their email or role through the profile", async () => {
    const u = await mkRider(6);
    const r = await api("/me", { method: "PATCH", token: u.token, body: { email: "hijack@example.com", role: "admin", name: "Still Me" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.email, u.email);
    assert.equal(r.body.user.role, "rider");
    const row = (await pool.query("SELECT email, role FROM users WHERE id = $1", [u.id])).rows[0];
    assert.equal(row.email, u.email);
    assert.equal(row.role, "rider");
  });

  await test("profile needs a login and only touches the caller", async () => {
    assert.equal((await api("/me", { method: "PATCH", body: { name: "x" } })).status, 401);
    const a = await mkRider(7);
    const b = await mkRider(8);
    await api("/me", { method: "PATCH", token: a.token, body: { homeAddress: "A's place" } });
    assert.equal((await api("/me", { token: b.token })).body.user.home_address, null);
  });

  await test("the public user never leaks secrets", async () => {
    const u = await mkRider(9);
    const r = await api("/me", { token: u.token });
    for (const f of ["password_hash", "reset_token", "email_verification_token", "apple_refresh_token"]) {
      assert.ok(!(f in r.body.user), f);
    }
  });

  await pool.query("DELETE FROM users WHERE id = ANY($1)", [made]);
  server.close();
  await pool.end();
  console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
})().catch((e) => { console.error(e); process.exit(1); });
