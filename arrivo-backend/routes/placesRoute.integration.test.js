// GET /api/places/route: sign-in needed, bad coordinates refused before any Google call.
//   DATABASE_URL=postgres://... node routes/placesRoute.integration.test.js
const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");
const placesRouter = require("./places");

const app = express();
app.use("/api/places", placesRouter);
const server = http.createServer(app);
const get = async (path, token) => {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return res.status;
};

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, r));
  const u = (await pool.query("INSERT INTO users (name,email,phone,password_hash,role) VALUES ('Route Rider',$1,'+2348033000001','x','rider') RETURNING id", [`route-${Date.now()}@example.com`])).rows[0].id;
  const token = jwt.sign({ id: u, email: "r@example.com", role: "rider", tv: 0 }, process.env.JWT_SECRET, { algorithm: "HS256" });
  const q = "fromLat=6.58&fromLng=3.32&toLat=6.43&toLng=3.43";
  assert.strictEqual(await get(`/api/places/route?${q}`), 401);
  console.log("  ok  no token, no route");
  for (const bad of ["", "fromLat=abc&fromLng=3&toLat=6&toLng=3", "fromLat=95&fromLng=3&toLat=6&toLng=3", "fromLat=6&fromLng=3&toLat=6", "fromLat=6&fromLng=200&toLat=6&toLng=3"]) {
    assert.strictEqual(await get(`/api/places/route?${bad}`, token), 400, bad);
  }
  console.log("  ok  missing, non-numeric and out-of-range coordinates are 400");
  await pool.query("DELETE FROM users WHERE id=$1", [u]);
  server.close();
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
