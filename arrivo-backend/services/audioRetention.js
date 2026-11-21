// Deletes recordings older than the retention period unless they are on hold
// (a panic alert, or an admin, sets the hold). Runs from the scheduler sweep.
// Rows stay with deleted_at set, so the audit trail survives the audio.

const { pool } = require("../db/db");
const storage = require("./audioStorage");

async function purgeExpiredRecordings({ limit = 50 } = {}) {
  if (!storage.isConfigured()) return { purged: 0 };
  const days = storage.retentionDays();
  const due = await pool.query(
    `SELECT id FROM ride_audio_recordings
     WHERE deleted_at IS NULL AND hold = false AND created_at < now() - ($1 || ' days')::interval
     ORDER BY id LIMIT $2`,
    [String(days), limit]
  );
  let purged = 0;
  for (const { id } of due.rows) {
    try {
      const chunks = await pool.query("SELECT object_key FROM ride_audio_chunks WHERE recording_id = $1", [id]);
      await storage.deleteObjects(chunks.rows.map((c) => c.object_key));
      await pool.query("DELETE FROM ride_audio_chunks WHERE recording_id = $1", [id]);
      await pool.query("UPDATE ride_audio_recordings SET deleted_at = now() WHERE id = $1", [id]);
      purged++;
    } catch (err) {
      console.error(`Audio retention: recording ${id} not purged:`, err.message);
    }
  }
  return { purged };
}

module.exports = { purgeExpiredRecordings };
