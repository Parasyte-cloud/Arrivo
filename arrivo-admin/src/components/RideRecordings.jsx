import React, { useRef, useState } from "react";
import * as api from "../api";
import { formatDateTime } from "../utils";

function minutes(seconds) {
  const s = Math.round(Number(seconds) || 0);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// Lists a ride's audio recordings and plays them chunk after chunk. Admin only.
// Opening a recording asks the API for short-lived links, and the API logs who
// asked before it hands them out, so there is no way to listen without a record.
export function RideRecordings({ token, rideId }) {
  const [recordings, setRecordings] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(null); // { id, chunks, index }
  const [log, setLog] = useState({}); // id -> entries
  const audioRef = useRef(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api.getRideRecordings(token, rideId);
      setRecordings(data.recordings);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const listen = async (rec) => {
    setError(null);
    try {
      const data = await api.getRecordingPlayUrls(token, rec.id);
      if (!data.chunks.length) {
        setError("Nothing has finished uploading for this recording.");
        return;
      }
      setPlaying({ id: rec.id, chunks: data.chunks, index: 0 });
    } catch (e) {
      setError(e.message);
    }
  };

  const toggleHold = async (rec) => {
    try {
      await api.setRecordingHold(token, rec.id, !rec.hold);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const showLog = async (rec) => {
    try {
      const data = await api.getRecordingAccessLog(token, rec.id);
      setLog((l) => ({ ...l, [rec.id]: data.log }));
    } catch (e) {
      setError(e.message);
    }
  };

  const onEnded = () => {
    setPlaying((p) => (p && p.index + 1 < p.chunks.length ? { ...p, index: p.index + 1 } : null));
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase" }}>
        Audio recordings
      </div>
      {recordings === null ? (
        <button className="btn" disabled={busy} onClick={load}>{busy ? "Checking…" : "Check for recordings"}</button>
      ) : recordings.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>No recordings for this ride.</div>
      ) : (
        recordings.map((rec) => (
          <div key={rec.id} style={{ fontSize: 12.5, padding: "8px 0", borderBottom: "1px solid var(--card-border)" }}>
            <div>
              <strong>{rec.recorded_by}</strong> · {formatDateTime(rec.created_at)} · {minutes(rec.total_seconds)} ({rec.chunks_uploaded} parts)
              {rec.started_via_panic ? " · started by panic" : ""}
              {rec.hold ? " · ON HOLD" : ""}
              {rec.deleted_at ? " · deleted" : ""}
            </div>
            {!rec.deleted_at ? (
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button className="btn primary" onClick={() => listen(rec)}>Listen</button>
                <button className="btn" onClick={() => toggleHold(rec)}>{rec.hold ? "Release hold" : "Hold (keep past 30 days)"}</button>
                <button className="btn" onClick={() => showLog(rec)}>Who listened</button>
              </div>
            ) : null}
            {playing && playing.id === rec.id ? (
              <audio
                key={playing.index}
                ref={audioRef}
                src={playing.chunks[playing.index].url}
                controls
                autoPlay
                onEnded={onEnded}
                style={{ width: "100%", marginTop: 8 }}
              />
            ) : null}
            {log[rec.id] ? (
              <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {log[rec.id].length === 0 ? <li>No one has listened yet.</li> : log[rec.id].map((e, i) => (
                  <li key={i}>{e.action} · {e.user_email} · {formatDateTime(e.created_at)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))
      )}
      {error ? <div style={{ color: "var(--coral)", fontSize: 12.5, marginTop: 6 }}>{error}</div> : null}
    </div>
  );
}
