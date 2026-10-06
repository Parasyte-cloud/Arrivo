const express = require("express");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db/db");
const { requireAuth, requireAnyRole } = require("../middleware/auth");
const { csvLine, UTF8_BOM } = require("../services/csv");
const {
  DATASETS,
  MAX_ROWS,
  parseRange,
  countSql,
  pageSql,
  datasetsFor,
} = require("../services/operationsExport");

const router = express.Router();

// Admin and operations only. Support staff can read the console but are
// deliberately left out: a download takes the whole dataset out of the system
// in one go, which is a bigger step than looking at a page.
router.use(requireAuth, requireAnyRole(["admin", "operations"]));

// Keyed by user, not IP, so people on one office connection do not throttle
// each other. The limit is about bulk copying: a person doing their job needs
// a handful of files a day, not hundreds.
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.EXPORT_RATE_LIMIT) || 40,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.id),
  handler: (req, res) =>
    res.status(429).json({ error: "Too many downloads this hour. Please wait a little and try again." }),
});

// GET /api/admin/exports: the datasets this person may download.
router.get("/", (req, res) => {
  res.json({ datasets: datasetsFor(req.user.role), maxRows: MAX_ROWS });
});

// GET /api/admin/exports/history: who downloaded what, newest first. Admin
// only: operations staff can export but cannot read the record of exports.
router.get("/history", async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Only an administrator can view the export history." });
  }
  const result = await pool.query(
    `SELECT id, user_email, user_role, dataset, date_from, date_to, row_count, status, ip,
            to_char(created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD HH24:MI:SS') AS time_wat
     FROM export_audit_log
     ORDER BY id DESC
     LIMIT 100`
  );
  res.json({ history: result.rows });
});

// GET /api/admin/exports/:dataset?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/:dataset", exportLimiter, async (req, res) => {
  const dataset = Object.prototype.hasOwnProperty.call(DATASETS, req.params.dataset)
    ? DATASETS[req.params.dataset]
    : null;
  if (!dataset) return res.status(404).json({ error: "Unknown export." });

  if (dataset.audience === "admin" && req.user.role !== "admin") {
    return res.status(403).json({ error: "This export is limited to administrators." });
  }

  let range;
  try {
    range = parseRange(req.query);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const total = (await pool.query(countSql(dataset, range))).rows[0].n;
  if (total > MAX_ROWS) {
    return res.status(413).json({
      error: `This would be ${total.toLocaleString("en-NG")} rows, more than the ${MAX_ROWS.toLocaleString("en-NG")} limit for one file. Choose a shorter date range.`,
    });
  }

  // Written before any data leaves, so an attempt is on record even if the
  // download then fails or the connection drops half way.
  const audit = (
    await pool.query(
      `INSERT INTO export_audit_log (user_id, user_email, user_role, dataset, date_from, date_to, row_count, status, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'started', $8, $9)
       RETURNING id`,
      [
        req.user.id,
        req.user.email || "",
        req.user.role,
        req.params.dataset,
        range.from,
        range.to,
        total,
        req.ip || null,
        String(req.headers["user-agent"] || "").slice(0, 300) || null,
      ]
    )
  ).rows[0].id;

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
  const span = range.from || range.to ? `-${range.from || "start"}-to-${range.to || "now"}` : "";
  const filename = `arrivo-${req.params.dataset}${span}-exported-${today}.csv`;

  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Row-Count", String(total));
  // The browser console reads these two to name the file and show the count.
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Row-Count");

  let sent = 0;
  let headers = null;
  let aborted = false;
  res.on("close", () => {
    if (!res.writableEnded) aborted = true;
  });

  const finish = (status) =>
    pool
      .query("UPDATE export_audit_log SET status = $1, row_count = $2, completed_at = now() WHERE id = $3", [status, sent, audit])
      .catch((err) => console.error("Could not update export audit row %s:", audit, err.message));

  try {
    let afterKey = 0;
    for (;;) {
      if (aborted) break;
      const result = await pool.query(pageSql(dataset, range, afterKey));
      const page = result.rows;

      // result.fields lists the columns even when there are no rows, so an
      // empty export still gets its header line.
      if (!headers) {
        headers = result.fields.map((f) => f.name).filter((n) => n !== "_key");
        res.write(UTF8_BOM + csvLine(headers));
      }

      if (page.length === 0) break;
      let chunk = "";
      for (const row of page) {
        chunk += csvLine(headers.map((h) => row[h]));
        sent += 1;
      }
      res.write(chunk);
      afterKey = page[page.length - 1]._key;
    }

    if (aborted) {
      await finish("aborted");
      return;
    }
    await finish("completed");
    res.end();
  } catch (err) {
    console.error("Export %s failed:", req.params.dataset, err.message);
    await finish("failed");
    if (!res.headersSent) {
      res.removeHeader("Content-Disposition");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(500).json({ error: "The export could not be created. Please try again." });
    }
    // Cut the connection rather than ending cleanly. A file that stops early
    // but looks complete would be taken as proof of operations when it is not.
    res.destroy(err);
  }
});

module.exports = router;
