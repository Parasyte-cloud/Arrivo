// Alert lifecycle + deduplication (spec sections 10-12).
//
// The core guarantee this file provides: a vehicle sending telemetry
// every 10-20s during one continuous deviation produces ONE alert row
// that gets updated, never dozens of new rows. That guarantee lives here,
// not in the caller — so nothing calling this service can accidentally
// bypass it by inserting directly.

const VALID_TRANSITIONS = {
  OPEN: ["ACKNOWLEDGED", "RESOLVED", "DISMISSED"],
  ACKNOWLEDGED: ["INVESTIGATING", "RESOLVED", "DISMISSED"],
  INVESTIGATING: ["RESOLVED", "DISMISSED"],
  RESOLVED: [], // terminal — a resolved alert is never reopened; a new deviation creates a new alert
  DISMISSED: [], // terminal
};

class InvalidAlertTransitionError extends Error {
  constructor(from, to) {
    super(`Cannot transition alert from ${from} to ${to}`);
    this.name = "InvalidAlertTransitionError";
  }
}

/**
 * The single entry point for "something happened that might be
 * alert-worthy". Looks for an existing OPEN or ACKNOWLEDGED or
 * INVESTIGATING alert of the same type on this ride first — if one
 * exists, updates it in place rather than creating a new row. Only
 * inserts a new alert if none of those non-terminal states currently
 * exist for this ride+type.
 */
async function upsertAlert({ db, rideId, type, severity, telemetry, distanceFromRouteM, distanceFromDestinationKm }) {
  const existing = await db.query(
    `SELECT id, severity, status FROM safety_alerts
     WHERE ride_id = $1 AND type = $2 AND status IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING')
     ORDER BY created_at DESC LIMIT 1`,
    [rideId, type]
  );

  if (existing.rows && existing.rows.length > 0) {
    const alert = existing.rows[0];
    // Update the existing incident's current telemetry snapshot and, if
    // severity has genuinely escalated, bump it — but never silently
    // downgrade severity here; de-escalation is a resolution decision,
    // not something a telemetry update should do quietly.
    const severityRank = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    const newSeverity = severityRank[severity] > severityRank[alert.severity] ? severity : alert.severity;

    await db.query(
      `UPDATE safety_alerts SET
         severity = $1, current_lat = $2, current_lng = $3,
         distance_from_route_m = $4, distance_from_destination_km = $5,
         speed_kmh = $6, heading_deg = $7, gps_accuracy_m = $8
       WHERE id = $9`,
      [newSeverity, telemetry.lat, telemetry.lng, distanceFromRouteM, distanceFromDestinationKm,
       telemetry.speedKmh, telemetry.headingDeg, telemetry.accuracyM, alert.id]
    );

    return { alertId: alert.id, created: false, escalated: newSeverity !== alert.severity, severity: newSeverity };
  }

  const inserted = await db.query(
    `INSERT INTO safety_alerts
       (ride_id, type, severity, status, current_lat, current_lng, distance_from_route_m, distance_from_destination_km, speed_kmh, heading_deg, gps_accuracy_m)
     VALUES ($1, $2, $3, 'OPEN', $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [rideId, type, severity, telemetry.lat, telemetry.lng, distanceFromRouteM, distanceFromDestinationKm,
     telemetry.speedKmh, telemetry.headingDeg, telemetry.accuracyM]
  );

  return { alertId: inserted.rows[0].id, created: true, escalated: false, severity };
}

async function transitionAlert({ db, alertId, currentStatus, toStatus, resolutionReason = null }) {
  const allowed = VALID_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(toStatus)) {
    throw new InvalidAlertTransitionError(currentStatus, toStatus);
  }

  const timestampField = toStatus === "ACKNOWLEDGED" ? "acknowledged_at" : toStatus === "RESOLVED" ? "resolved_at" : null;
  const sql = timestampField
    ? `UPDATE safety_alerts SET status = $1, ${timestampField} = now(), notes = COALESCE(notes || E'\\n', '') || $2 WHERE id = $3`
    : `UPDATE safety_alerts SET status = $1 WHERE id = $2`;
  const params = timestampField ? [toStatus, resolutionReason || "", alertId] : [toStatus, alertId];

  await db.query(sql, params);
  return { alertId, status: toStatus };
}

/**
 * Auto-resolution (spec section 12) — only called once the deviation
 * engine itself has confirmed recovery persistence, never on a single
 * "back on route" sample. This function doesn't re-check persistence
 * itself; that's the deviation engine's job. This just performs the
 * resolution once told to.
 */
async function autoResolveAlert({ db, alertId, currentStatus, finalLat, finalLng }) {
  if (currentStatus === "RESOLVED" || currentStatus === "DISMISSED") {
    return { alertId, status: currentStatus, alreadyTerminal: true };
  }
  await db.query(
    `UPDATE safety_alerts SET status = 'RESOLVED', resolved_at = now(), auto_resolved = true,
       notes = COALESCE(notes || E'\\n', '') || $1
     WHERE id = $2`,
    [`Auto-resolved: vehicle returned to route and maintained it (final position ${finalLat}, ${finalLng})`, alertId]
  );
  return { alertId, status: "RESOLVED", alreadyTerminal: false };
}

module.exports = { VALID_TRANSITIONS, InvalidAlertTransitionError, upsertAlert, transitionAlert, autoResolveAlert };
