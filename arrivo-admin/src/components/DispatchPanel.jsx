import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { formatDateTime } from "../utils";

// The "Dispatch" block in the Trip Tracker: who has this ride, putting a driver
// on it or swapping one, nudging online drivers again, and what has happened so
// far. Changing anything needs Trip Tracker manage; the backend checks too.

const EVENT_TEXT = {
  alerted: (e) => `Alerted ${e.drivers_alerted ?? 0} online driver${e.drivers_alerted === 1 ? "" : "s"}`,
  preferred_released: (e) => `Preferred driver's hold ended, alerted ${e.drivers_alerted ?? 0}`,
  reminder: (e) => `Still unassigned near pickup, alerted ${e.drivers_alerted ?? 0} again`,
  accepted: (e) => `${e.driver_name || "A driver"} accepted it in the app`,
  assigned: (e) => `${e.actor_name || "Ops"} assigned ${e.driver_name || "a driver"}`,
  reassigned: (e) => `${e.actor_name || "Ops"} moved it from ${e.from_driver_name || "a driver"} to ${e.driver_name || "another driver"}`,
};

export function DispatchPanel({ trip, onChanged }) {
  const { token, can } = useAuth();
  const canManage = can("trip-tracker", "manage");
  const tripId = trip ? trip.id : null;
  const [events, setEvents] = useState([]);
  const [drivers, setDrivers] = useState(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  // Shown straight after assigning, until the next refresh of the trip catches up.
  const [justAssigned, setJustAssigned] = useState(null);
  const driverName = justAssigned || (trip && trip.driver_name);
  const open = trip && ["requested", "accepted"].includes(trip.ride_status);

  const loadEvents = useCallback(() => {
    if (!tripId) return;
    api.getTripDispatch(token, tripId).then((r) => setEvents(r.events)).catch(() => {});
  }, [token, tripId]);

  useEffect(() => {
    setPicking(false); setDrivers(null); setMsg(null); setErr(null); setJustAssigned(null);
    loadEvents();
  }, [tripId, loadEvents]);

  const startPicking = async () => {
    setPicking(true); setErr(null);
    try { setDrivers((await api.getTripDrivers(token, tripId)).drivers); } catch (e) { setErr(e.message); }
  };

  const assign = async (d) => {
    const verb = driverName ? `Move ride #${trip.id} from ${driverName} to ${d.name}` : `Give ride #${trip.id} to ${d.name}`;
    if (!window.confirm(`${verb}? They and the rider are told straight away.`)) return;
    setBusy(true); setErr(null);
    try {
      await api.assignTripDriver(token, tripId, d.id);
      setJustAssigned(d.name);
      setMsg(`${d.name} has the ride. They and the rider have been told.`);
      setPicking(false);
      loadEvents();
      if (onChanged) onChanged();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const nudge = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.alertTripDrivers(token, tripId);
      setMsg(`Alerted ${r.alerted} online driver${r.alerted === 1 ? "" : "s"}.`);
      loadEvents();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!trip) return null;
  return (
    <div className="tt-block">
      <h3>Dispatch</h3>
      <div className="tt-person">
        <div>
          <strong>{driverName || "No driver yet"}</strong>
          <span>{driverName ? "Has this ride" : "Waiting for a driver to accept"}</span>
        </div>
        {open && canManage ? (
          <div className="tt-acts">
            <button className="btn" disabled={busy} onClick={picking ? () => setPicking(false) : startPicking}>
              {picking ? "Close" : driverName ? "Change driver" : "Assign driver"}
            </button>
            {!driverName ? <button className="btn ghost" disabled={busy} onClick={nudge}>Alert drivers again</button> : null}
          </div>
        ) : null}
      </div>
      {msg ? <p className="tt-note">{msg}</p> : null}
      {err ? <div className="error-text">{err}</div> : null}

      {picking ? (
        <div className="dp-list">
          {!drivers ? <p className="tt-note">Loading drivers…</p> : null}
          {drivers && !drivers.length ? <p className="tt-note">No approved drivers yet.</p> : null}
          {(drivers || []).map((d) => (
            <div className="dp-row" key={d.id}>
              <div>
                <strong>{d.name}</strong>
                <span>
                  <span className={d.online ? "dp-dot on" : "dp-dot"} />
                  {d.online ? "Online" : "Offline"}
                  {d.kmToPickup != null ? ` · ${d.kmToPickup} km from pickup` : ""}
                  {d.vehicle ? ` · ${d.vehicle}` : ""}
                </span>
                <span>
                  {d.midTrip ? <span className="tt-tag warn">On a trip now</span> : null}
                  {d.upcoming ? <span className="tt-tag">{d.upcoming} upcoming</span> : null}
                  {d.rating ? <span className="tt-tag">★ {Number(d.rating).toFixed(1)}</span> : null}
                </span>
              </div>
              {d.current || d.name === justAssigned ? <span className="tt-tag">Has it</span> : <button className="btn primary" disabled={busy} onClick={() => assign(d)}>Assign</button>}
            </div>
          ))}
        </div>
      ) : null}

      {events.length ? (
        <ul className="dp-log">
          {events.map((e) => (
            <li key={e.id}>
              <span>{formatDateTime(e.created_at)}</span>
              {(EVENT_TEXT[e.kind] || (() => e.kind))(e)}{e.note ? ` (${e.note})` : ""}
            </li>
          ))}
        </ul>
      ) : <p className="tt-note">No dispatch activity yet.</p>}
    </div>
  );
}
