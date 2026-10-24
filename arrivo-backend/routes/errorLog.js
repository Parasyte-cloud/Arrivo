// POST /api/client-errors   the apps report errors they hit (no network, a crash,
//                           a failed booking) so they land next to the server's.
// GET  /api/error-log       staff look up a ref a rider read out, or browse recent
//                           failures. ?ref=RA-XXXXXX  ?code=RIDES_400  ?source=client
//                           ?userId=12  ?limit=100
const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db/db");
const { requireAuth, requireAnyRole } = require("../middleware/auth");
const { cleanRef, newRef, short } = require("../middleware/errorTrail");

const router = express.Router();

const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many error reports." },
});

// Who sent it, if they're signed in. Only used to label the row, so a bad or
// missing token is fine.
function optionalUserId(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  try {
    const p = jwt.verify(h.slice(7), process.env.JWT_SECRET, { algorithms: ["HS256"] });
    return Number.isInteger(Number(p.id)) ? Number(p.id) : null;
  } catch (e) {
    return null;
  }
}

// Small flat object of short strings, numbers and booleans. Anything else is dropped.
function cleanContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 20)) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 200);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

router.post("/client-errors", reportLimiter, async (req, res) => {
  const b = req.body || {};
  const ref = cleanRef(b.ref) || newRef();
  const status = Number.isInteger(b.status) && b.status >= 0 && b.status < 1000 ? b.status : null;
  await pool.query(
    `INSERT INTO api_error_log
       (ref, source, status, method, path, user_id, error_code, message, detail,
        platform, app_version, app_build, user_agent, screen, context)
     VALUES ($1,'client',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      ref,
      status,
      short(b.method, 10),
      short(b.path, 200),
      optionalUserId(req),
      short(b.code, 60) || "CLIENT_ERROR",
      short(b.message, 500),
      short(b.detail, 1000),
      short(b.platform || req.get("X-Platform"), 40),
      short(b.appVersion || req.get("X-App-Version"), 40),
      short(b.appBuild || req.get("X-App-Build"), 40),
      short(req.get("User-Agent"), 200),
      short(b.screen, 60),
      cleanContext(b.context) ? JSON.stringify(cleanContext(b.context)) : null,
    ]
  );
  console.log(JSON.stringify({ type: "client_error", ref, code: short(b.code, 60), screen: short(b.screen, 60), message: short(b.message, 200) }));
  res.status(201).json({ ok: true, ref });
});

router.get("/error-log", requireAuth, requireAnyRole(["admin", "support"]), async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  const ref = cleanRef(req.query.ref);
  if (req.query.ref && !ref) return res.status(400).json({ error: "That doesn't look like a ref. It should look like RA-7KQ2MX." });
  if (ref) add("ref = ?", ref);
  if (typeof req.query.code === "string" && req.query.code) add("error_code = ?", req.query.code.slice(0, 60).toUpperCase());
  if (req.query.source === "client" || req.query.source === "server") add("source = ?", req.query.source);
  if (req.query.userId && Number.isInteger(Number(req.query.userId))) add("user_id = ?", Number(req.query.userId));
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const r = await pool.query(
    `SELECT id, created_at, ref, source, status, method, path, user_id, role, error_code, message, detail,
            platform, app_version, app_build, user_agent, screen, context
       FROM api_error_log ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC LIMIT ${limit}`,
    params
  );
  res.json({ entries: r.rows });
});

module.exports = router;
