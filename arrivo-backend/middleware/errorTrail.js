// Gives every failed request a short reference (like RA-7KQ2MX) and an error
// code, and writes it down, so "I couldn't book" can be traced to the exact
// request.
//
// - The app sends its own X-Request-Id so the ref it shows matches ours.
//   Anything else gets a fresh one.
// - Every 4xx/5xx JSON body gets requestId and errorCode added.
// - Clients that don't show the ref themselves (older app builds, web pages)
//   get it appended to the error text, so a rider can still read it out.
// - Every failure is one JSON line in the Render logs. Booking, payment and
//   server errors are also saved to api_error_log for 30 days.
//
// Nothing from the request body is stored, only the route, status, the error
// text we sent, and for 5xx the real error message (never shown to clients).

const crypto = require("crypto");

const REF_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const REF_RE = /^RA-[A-HJKMNP-Z2-9]{6,12}$/;
const KEEP_DAYS = 30;

// 4xx on these is worth keeping. They're the money and booking paths.
const STORED_4XX = /^\/api\/(rides|instant-rides|payments|wallet|memberships|on-the-go|family|safety|calls)(\/|$)/;

function newRef() {
  const bytes = crypto.randomBytes(6);
  let out = "RA-";
  for (const b of bytes) out += REF_CHARS[b % REF_CHARS.length];
  return out;
}

function cleanRef(value) {
  const v = typeof value === "string" ? value.trim().toUpperCase() : "";
  return REF_RE.test(v) ? v : null;
}

function short(value, max) {
  if (value == null) return null;
  const s = String(value).replace(/[\u0000-\u001f]+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

// RIDES_400, PAYMENTS_502, or the route's own code when it set one.
function errorCodeFor(path, status, body) {
  if (body && typeof body.errorCode === "string") return body.errorCode;
  if (body && typeof body.code === "string" && /^[A-Za-z0-9_]{2,40}$/.test(body.code)) return body.code.toUpperCase();
  const area = (String(path).match(/^\/api\/([a-z0-9-]+)/i) || [])[1] || "API";
  return `${area.replace(/-/g, "_").toUpperCase()}_${status}`;
}

function shouldStore(path, status) {
  if (status >= 500) return true;
  if (status < 400 || status === 401 || status === 404) return false;
  return STORED_4XX.test(path);
}

function clientInfo(req) {
  return {
    platform: short(req.get("X-Platform"), 40),
    appVersion: short(req.get("X-App-Version"), 40),
    appBuild: short(req.get("X-App-Build"), 40),
    userAgent: short(req.get("User-Agent"), 200),
  };
}

function errorTrail({ store } = {}) {
  let lastPurge = 0;

  async function save(row) {
    if (!store) return;
    try {
      await store.insert(row);
      if (Date.now() - lastPurge > 60 * 60 * 1000) {
        lastPurge = Date.now();
        await store.purge(KEEP_DAYS);
      }
    } catch (e) {
      console.warn("[error-trail] could not save", row.ref, e.message);
    }
  }

  return function errorTrailMiddleware(req, res, next) {
    const ref = cleanRef(req.get("X-Request-Id")) || newRef();
    req.requestId = ref;
    res.setHeader("X-Request-Id", ref);

    const path = String(req.originalUrl || req.url || "").split("?")[0];
    const info = clientInfo(req);
    let sent = null;

    const json = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      if (status >= 400 && body && typeof body === "object" && !Array.isArray(body) && !body.requestId) {
        const code = errorCodeFor(path, status, body);
        body = { ...body, requestId: ref, errorCode: code };
        // New app builds show the ref themselves and send X-App-Build.
        if (!info.appBuild && typeof body.error === "string" && (status >= 500 || shouldStore(path, status))) {
          body.error = `${body.error} (Ref: ${ref})`;
        }
        sent = { code, message: typeof body.error === "string" ? body.error : null };
      }
      return json(body);
    };

    res.on("finish", () => {
      const status = res.statusCode;
      if (status < 400) return;
      const row = {
        ref,
        source: "server",
        status,
        method: req.method,
        path: short(path, 200),
        userId: req.user && Number.isInteger(Number(req.user.id)) ? Number(req.user.id) : null,
        role: short(req.user && req.user.role, 20),
        errorCode: short(sent ? sent.code : errorCodeFor(path, status, null), 60),
        message: short(sent && sent.message, 500),
        detail: short(res.locals && res.locals.errorDetail, 1000),
        ...info,
      };
      console.log(JSON.stringify({ type: "api_error", ...row }));
      if (shouldStore(path, status)) save(row);
    });

    next();
  };
}

// Postgres-backed store for api_error_log (see db/schema.sql).
function pgStore(pool) {
  return {
    insert: (r) =>
      pool.query(
        `INSERT INTO api_error_log
           (ref, source, status, method, path, user_id, role, error_code, message, detail,
            platform, app_version, app_build, user_agent, screen, context)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [r.ref, r.source, r.status, r.method, r.path, r.userId, r.role, r.errorCode, r.message, r.detail,
          r.platform, r.appVersion, r.appBuild, r.userAgent, r.screen || null, r.context ? JSON.stringify(r.context) : null]
      ),
    purge: (days) => pool.query("DELETE FROM api_error_log WHERE created_at < now() - ($1 || ' days')::interval", [String(days)]),
  };
}

module.exports = { errorTrail, pgStore, newRef, cleanRef, errorCodeFor, shouldStore, short, REF_RE };
