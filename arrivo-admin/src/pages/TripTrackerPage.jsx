import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill, rideStatusTone } from "../components/StatusPill";
import { CallButton } from "../components/CallButton";
import { TripMap, tripColor } from "../components/TripMap";
import { openInWindow } from "../lib/openWindow";
import { formatDateTime } from "../utils";
import "../tracker.css";

const POLL_MS = 10000;
const DETAIL_POLL_MS = 30000;

const STATUS_LABEL = {
  requested: "Waiting for a driver",
  accepted: "Driver on the way",
  in_progress: "On trip",
  completed: "Completed",
  cancelled: "Cancelled",
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "in_progress", label: "On trip" },
  { key: "accepted", label: "En route" },
  { key: "requested", label: "Waiting" },
  { key: "flight", label: "Flights" },
  { key: "alert", label: "Alerts" },
];

function agoText(iso) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function clock(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true }).replace(/\b(am|pm)\b/i, (x) => x.toUpperCase());
}

// How fresh the driver's GPS is. The driver app reports about every 20 seconds.
function gps(trip) {
  if (trip.current_lat === null || trip.current_lat === undefined) return { key: "none", label: "No GPS yet" };
  if (!trip.location_updated_at) return { key: "none", label: "No GPS yet" };
  const s = (Date.now() - new Date(trip.location_updated_at).getTime()) / 1000;
  if (s < 60) return { key: "live", label: "Live" };
  if (s < 300) return { key: "delayed", label: `Delayed ${agoText(trip.location_updated_at)}` };
  return { key: "lost", label: `Lost ${agoText(trip.location_updated_at)}` };
}

const short = (text) => String(text || "").split(",").slice(0, 2).join(",").trim();
const lastStop = (trip) => (trip.stops?.length ? trip.stops[trip.stops.length - 1] : null);
const destinationText = (trip) => {
  const stop = lastStop(trip);
  return typeof stop === "string" ? stop : stop?.address || stop?.description || "";
};
const naira = (n) => (n === null || n === undefined ? "" : `₦${Number(n).toLocaleString()}`);

function flightTone(status) {
  switch (status) {
    case "landed": return "teal";
    case "active": return "amber";
    case "cancelled": case "incident": case "diverted": return "coral";
    default: return "muted";
  }
}

function delayMinutes(arrival) {
  if (!arrival?.scheduled || !arrival?.estimated) return null;
  return Math.round((new Date(arrival.estimated) - new Date(arrival.scheduled)) / 60000);
}

function Step({ done, active, title, time }) {
  return (
    <li className={`tt-step ${done ? "done" : ""} ${active ? "active" : ""}`}>
      <span className="tt-step-dot" />
      <div><strong>{title}</strong>{time ? <span>{time}</span> : null}</div>
    </li>
  );
}

export function TripTrackerPage({ focus = null }) {
  const { token } = useAuth();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [selectedId, setSelectedId] = useState(focus && /^\d+$/.test(String(focus.ref)) && String(focus.ref).length < 9 ? Number(focus.ref) : null);
  const [unresolved, setUnresolved] = useState(null);
  const [detail, setDetail] = useState(null); // { trip, flight }
  const [route, setRoute] = useState(null);
  const [mapMode, setMapMode] = useState({ mode: "basic", reason: "" });
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [past, setPast] = useState(null);
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const { trips } = await api.getActiveTrips(token);
      if (!alive.current) return;
      setTrips(trips);
      setUpdatedAt(new Date());
      setError(null);
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    alive.current = true;
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    const clockId = setInterval(() => tick((n) => n + 1), 5000); // keeps "12s ago" honest between polls
    return () => { alive.current = false; clearInterval(id); clearInterval(clockId); };
  }, [load]);

  // A flight number or booking reference opens the matching live trip, or the latest ride with it.
  useEffect(() => {
    if (!focus || selectedId) return undefined;
    const ref = String(focus.ref || "").trim().toUpperCase();
    if (!ref) return undefined;
    const live = trips.find((t) => String(t.flight_number || "").toUpperCase() === ref);
    if (live) { setSelectedId(live.id); return undefined; }
    if (loading) return undefined;
    let ok = true;
    api.getRides(token, { search: ref })
      .then(({ rides }) => {
        if (!ok) return;
        if (rides && rides.length) setSelectedId(rides[0].id); else setUnresolved(ref);
      })
      .catch(() => { if (ok) setUnresolved(ref); });
    return () => { ok = false; };
  }, [focus, selectedId, trips, loading, token]);

  // The selected ride's full record and flight status (flight lookups are cached for 5 minutes server side).
  useEffect(() => {
    setDetail(null);
    setRoute(null);
    if (!selectedId) return undefined;
    let live = true;
    const fetchDetail = () =>
      api.getTrip(token, selectedId)
        .then((d) => { if (live) setDetail(d); })
        .catch(() => {});
    fetchDetail();
    const id = setInterval(() => { if (!document.hidden) fetchDetail(); }, DETAIL_POLL_MS);
    return () => { live = false; clearInterval(id); };
  }, [token, selectedId]);

  // A search that matches nothing live also looks through past rides (name, email, phone, flight, ride number).
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    return trips.filter((t) => {
      if (filter === "in_progress" || filter === "accepted" || filter === "requested") { if (t.ride_status !== filter) return false; }
      if (filter === "flight" && !t.flight_number) return false;
      if (filter === "alert" && !(t.has_active_panic || ["lost", "delayed"].includes(gps(t).key) && t.ride_status !== "requested")) return false;
      if (!q) return true;
      return [String(t.id), t.rider_name, t.flight_number, t.driver_name, t.plate_number, t.pickup_address]
        .some((v) => String(v || "").toLowerCase().includes(q.replace(/^#/, "")));
    });
  }, [trips, filter, q]);

  useEffect(() => {
    setPast(null);
    if (q.length < 2 || matches.length > 0) return undefined;
    let live = true;
    const id = setTimeout(() => {
      api.getRides(token, { search: query.trim() })
        .then(({ rides }) => { if (live) setPast((rides || []).slice(0, 8)); })
        .catch(() => { if (live) setPast([]); });
    }, 350);
    return () => { live = false; clearTimeout(id); };
  }, [q, matches.length, token, query]);

  const counts = useMemo(() => ({
    all: trips.length,
    in_progress: trips.filter((t) => t.ride_status === "in_progress").length,
    accepted: trips.filter((t) => t.ride_status === "accepted").length,
    requested: trips.filter((t) => t.ride_status === "requested").length,
    flight: trips.filter((t) => t.flight_number).length,
    alert: trips.filter((t) => t.has_active_panic || (["lost", "delayed"].includes(gps(t).key) && t.ride_status !== "requested")).length,
  }), [trips]);

  const listed = trips.find((t) => t.id === selectedId);
  const trip = detail?.trip || listed || null;
  const flightInfo = detail?.flight || null;
  const onRoute = useCallback((r) => setRoute(r), []);
  const onMode = useCallback((m) => setMapMode(m), []);
  const onSelect = useCallback((id) => setSelectedId(id), []);

  // Past rides open in the detail panel even though they are not on the live map.
  const mapTrips = trip && !trips.some((t) => t.id === trip.id) ? [...trips, trip] : trips;

  const copySummary = async () => {
    if (!trip) return;
    const g = gps(trip);
    const lines = [
      `RideArrivo ride #${trip.id}: ${STATUS_LABEL[trip.ride_status] || trip.ride_status}`,
      `Rider: ${trip.rider_name}`,
      `From: ${trip.pickup_address}`,
      destinationText(trip) ? `To: ${destinationText(trip)}` : null,
      trip.flight_number ? `Flight: ${trip.flight_number}${flightInfo?.flight?.status ? ` (${flightInfo.flight.status})` : ""}` : null,
      trip.driver_name ? `Driver: ${trip.driver_name}${trip.plate_number ? `, ${trip.make_model || "car"} ${trip.plate_number}` : ""}` : "Driver: not assigned yet",
      trip.current_lat != null ? `Driver position: https://www.google.com/maps?q=${trip.current_lat},${trip.current_lng} (${g.label})` : null,
      route?.toPickup ? `Driver to pickup: ${route.toPickup.text} (${route.toPickup.distance})` : null,
      route?.toDestination ? `To destination: ${route.toDestination.text} (${route.toDestination.distance})` : null,
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked: nothing to do */ }
  };

  // A full number appears only once the detail has loaded (and been logged). A tap on it is logged too.
  const logTap = (subject) => { api.logPhoneCall(token, trip.id, subject).catch(() => {}); };
  const phoneLink = (full, hint, onTap) => {
    if (full) return <a className="btn ghost" href={`tel:${full}`} onClick={onTap}>{full}</a>;
    if (hint) return <span className="tt-tag">{hint}</span>;
    return <span className="tt-tag warn">No phone</span>;
  };

  const flight = flightInfo?.flight || null;
  const delay = delayMinutes(flight?.arrival);
  const g = trip ? gps(trip) : null;
  const status = trip?.ride_status;
  const stepIndex = status === "completed" ? 3 : status === "in_progress" ? 2 : status === "accepted" ? 1 : 0;

  return (
    <div className={`tt-page${focus ? ` focus ${focus.kind}` : ""}`}>
      <div className="page-header">
        <div>
          <span className="eyebrow">{focus ? (focus.kind === "ride" ? "Ride record" : "Live tracking") : "Real-time operations"}</span>
          <h1>{focus ? (trip ? `Ride #${trip.id}${trip.flight_number ? ` · ${trip.flight_number}` : ""}` : `Tracking ${focus.ref}`) : "Trip Tracker"}</h1>
        </div>
        <div className="tt-head-right">
          <span className={`tt-mode ${mapMode.mode}`} title={mapMode.reason}>{mapMode.mode === "google" ? "Google Maps" : "Basic map"}</span>
          {updatedAt ? <span className="tt-updated"><i className="tt-pulse" /> Updated {clock(updatedAt.toISOString())} · every 10s</span> : null}
        </div>
      </div>

      {mapMode.mode === "basic" && mapMode.reason ? <div className="tt-banner">{mapMode.reason} Add <code>VITE_GOOGLE_MAPS_API_KEY</code> in Vercel to switch on Google Maps.</div> : null}
      {error ? <div className="error-text">{error}</div> : null}

      {unresolved ? <div className="error-text">No ride found for "{unresolved}". Try the ride number or the flight number.</div> : null}

      <div className={`tt-wrap ${trip ? "with-detail" : ""}`}>
        {focus ? null : <section className="tt-list-col">
          <input
            type="search"
            className="field"
            placeholder="Ride #, flight, name, plate…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search trips"
          />
          <div className="tt-chips">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" className={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)}>
                {f.label} <span>{counts[f.key]}</span>
              </button>
            ))}
          </div>

          <div className="tt-list">
            {loading ? <div className="empty-state">Loading trips…</div> : null}
            {!loading && matches.length === 0 && !past ? (
              <div className="empty-state">{trips.length === 0 ? "No active trips right now. New bookings appear here the moment they are made." : "No trips match."}</div>
            ) : null}
            {matches.map((t) => {
              const gp = gps(t);
              return (
                <button key={t.id} type="button" className={`tt-item ${selectedId === t.id ? "on" : ""}`} onClick={() => setSelectedId(t.id)}>
                  <span className="tt-bar" style={{ background: tripColor(t) }} />
                  <div className="tt-item-body">
                    <div className="tt-item-top">
                      <strong>#{t.id} · {t.rider_name}</strong>
                      {t.has_active_panic ? <span className="tt-sos">SOS</span> : null}
                    </div>
                    <div className="tt-item-route">{short(t.pickup_address)}{destinationText(t) ? ` → ${short(destinationText(t))}` : ""}</div>
                    <div className="tt-item-meta">
                      <StatusPill label={STATUS_LABEL[t.ride_status] || t.ride_status} tone={rideStatusTone(t.ride_status)} />
                      {t.flight_number ? <span className="tt-tag">✈ {t.flight_number}</span> : null}
                      {t.ride_status !== "requested" && t.ride_status !== "completed" ? <span className={`tt-gps ${gp.key}`}>{gp.label}</span> : null}
                    </div>
                  </div>
                </button>
              );
            })}
            {past && past.length > 0 ? (
              <>
                <div className="tt-sub">Past rides</div>
                {past.map((r) => (
                  <button key={r.id} type="button" className="tt-item" onClick={() => setSelectedId(r.id)}>
                    <span className="tt-bar" style={{ background: "#8b8fa8" }} />
                    <div className="tt-item-body">
                      <div className="tt-item-top"><strong>#{r.id} · {r.rider_name}</strong></div>
                      <div className="tt-item-route">{short(r.pickup_address)}</div>
                      <div className="tt-item-meta">
                        <StatusPill label={String(r.ride_status).replace("_", " ")} tone={rideStatusTone(r.ride_status)} />
                        <span className="tt-tag">{formatDateTime(r.created_at)}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </>
            ) : null}
            {past && past.length === 0 ? <div className="empty-state">No rides found for "{query}".</div> : null}
          </div>
        </section>}

        <section className="tt-map-col">
          <TripMap trips={mapTrips} selectedId={selectedId} onSelect={onSelect} onRoute={onRoute} onMode={onMode} />
          <div className="tt-legend">
            <span><i style={{ background: "#4fd9c7" }} /> On trip</span>
            <span><i style={{ background: "#f4a300" }} /> En route</span>
            <span><i style={{ background: "#8aa0ff" }} /> Waiting</span>
            <span><i style={{ background: "#ff6b57" }} /> SOS</span>
          </div>
        </section>

        {trip ? (
          <aside className="tt-detail">
            <header className="tt-d-head">
              <div>
                <span className="eyebrow">Ride #{trip.id}</span>
                <h2>{trip.rider_name}</h2>
              </div>
              <div className="tt-d-tools">
                {focus ? null : (
                  <>
                    <button className="btn ghost" onClick={() => openInWindow(`track/${trip.id}`, `Track #${trip.id}`)} title="Open live tracking in its own window">⤢ Track</button>
                    <button className="btn ghost" onClick={() => openInWindow(`ride/${trip.id}`, `Ride #${trip.id}`)} title="Open the ride record in its own window">⤢ Ride</button>
                  </>
                )}
                {trip.rider_id ? <button className="btn ghost" onClick={() => openInWindow(`rider/${trip.rider_id}`, trip.rider_name)} title="Open the rider in its own window">⤢ Rider</button> : null}
                {focus ? null : <button className="btn ghost" onClick={() => setSelectedId(null)} aria-label="Close">✕</button>}
              </div>
            </header>

            <div className="tt-d-status">
              <StatusPill label={STATUS_LABEL[status] || status} tone={rideStatusTone(status)} />
              {trip.has_active_panic ? <span className="tt-sos">SOS ACTIVE</span> : null}
              {status === "accepted" || status === "in_progress" ? <span className={`tt-gps ${g.key}`}>{g.label}</span> : null}
            </div>

            {route && (route.toPickup || route.toDestination) ? (
              <div className="tt-eta">
                {route.toPickup ? <div><span>Driver to pickup</span><strong>{route.toPickup.text}</strong><em>{route.toPickup.distance}</em></div> : null}
                {route.toDestination ? <div><span>{status === "in_progress" ? "To destination" : "Trip length"}</span><strong>{route.toDestination.text}</strong><em>{route.toDestination.distance}</em></div> : null}
              </div>
            ) : route?.error ? <p className="tt-note">{route.error}</p> : null}

            <ul className="tt-steps">
              <Step done={stepIndex >= 0} active={stepIndex === 0} title="Booked" time={formatDateTime(trip.created_at)} />
              <Step done={stepIndex >= 1} active={stepIndex === 1} title={trip.driver_name ? `Driver assigned: ${trip.driver_name}` : "Waiting for a driver"} time={trip.scheduled_pickup_at ? `Pickup set for ${formatDateTime(trip.scheduled_pickup_at)}` : ""} />
              <Step done={stepIndex >= 2} active={stepIndex === 2} title="On trip" time={trip.tracking_started_at ? `Started ${clock(trip.tracking_started_at)}` : ""} />
              <Step done={stepIndex >= 3} active={false} title="Completed" time={trip.completed_at ? clock(trip.completed_at) : ""} />
            </ul>

            <div className="tt-block">
              <h3>Route</h3>
              <div className="tt-addr"><i className="p">P</i><span>{trip.pickup_address}</span></div>
              {destinationText(trip) ? <div className="tt-addr"><i className="d">D</i><span>{destinationText(trip)}</span></div> : null}
              {trip.stops?.length > 1 ? <p className="tt-note">{trip.stops.length - 1} extra stop{trip.stops.length > 2 ? "s" : ""} on this trip.</p> : null}
            </div>

            {trip.flight_number ? (
              <div className="tt-block">
                <h3>Flight {trip.flight_number}</h3>
                {!flightInfo ? <p className="tt-note">Checking the flight…</p> : null}
                {flightInfo && !flightInfo.configured ? <p className="tt-note">Live flight status is not switched on. Set <code>AVIATIONSTACK_KEY</code> on the backend to turn it on.</p> : null}
                {flightInfo?.error ? <p className="tt-note">{flightInfo.error}</p> : null}
                {flightInfo?.configured && !flight && !flightInfo.error ? <p className="tt-note">No live data yet. This is normal until the flight is close to boarding. Checked {agoText(flightInfo.checkedAt)}.</p> : null}
                {flight ? (
                  <>
                    <div className="tt-flight-top">
                      <StatusPill label={flight.status === "active" ? "In the air" : flight.status} tone={flightTone(flight.status)} />
                      {delay !== null ? <span className={delay > 15 ? "tt-late" : "tt-ontime"}>{delay > 15 ? `${delay} min late` : "On time"}</span> : null}
                    </div>
                    <div className="tt-kv">
                      <span>Airline</span><strong>{flight.airline || "n/a"}</strong>
                      <span>From</span><strong>{flight.departure?.airport || "n/a"}</strong>
                      <span>Scheduled arrival</span><strong>{flight.arrival?.scheduled ? clock(flight.arrival.scheduled) : "n/a"}</strong>
                      <span>Expected arrival</span><strong>{flight.arrival?.estimated ? clock(flight.arrival.estimated) : "n/a"}</strong>
                      <span>Terminal / gate</span><strong>{[flight.arrival?.terminal, flight.arrival?.gate].filter(Boolean).join(" / ") || "n/a"}</strong>
                    </div>
                    <p className="tt-note">Checked {agoText(flightInfo.checkedAt)}. Refreshed at most every 5 minutes.</p>
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="tt-block">
              <h3>People</h3>
              <div className="tt-person">
                <div><strong>{trip.rider_name}</strong><span>Rider</span></div>
                <div className="tt-acts">
                  {phoneLink(trip.rider_phone, trip.rider_phone_hint, () => logTap("rider"))}
                  <CallButton calleeUserId={trip.rider_id} calleeName={trip.rider_name} />
                </div>
              </div>
              {trip.driver_name ? (
                <div className="tt-person">
                  <div><strong>{trip.driver_name}</strong><span>Driver{trip.plate_number ? ` · ${trip.make_model || "Car"} ${trip.plate_number}` : ""}</span></div>
                  <div className="tt-acts">
                    {trip.driver_phone || trip.driver_phone_hint ? phoneLink(trip.driver_phone, trip.driver_phone_hint, () => logTap("driver")) : null}
                    {trip.driver_user_id ? <CallButton calleeUserId={trip.driver_user_id} calleeName={trip.driver_name} /> : null}
                  </div>
                </div>
              ) : null}
              {trip.emergency_contact_phone || trip.emergency_contact_phone_hint ? (
                <div className="tt-person">
                  <div><strong>{trip.emergency_contact_name || "Emergency contact"}</strong><span>Emergency contact</span></div>
                  <div className="tt-acts">{phoneLink(trip.emergency_contact_phone, trip.emergency_contact_phone_hint, () => logTap("rider"))}</div>
                </div>
              ) : null}
            </div>

            <div className="tt-block">
              <h3>Payment</h3>
              <div className="tt-kv">
                <span>Fare</span><strong>{naira(trip.fare_naira)}</strong>
                <span>Payment</span><strong>{trip.payment_status}</strong>
                {trip.vehicle_type ? <><span>Vehicle</span><strong>{trip.vehicle_type}</strong></> : null}
              </div>
            </div>

            <div className="tt-d-actions">
              <button className="btn primary" onClick={copySummary}>{copied ? "Copied" : "Copy trip update"}</button>
              {trip.current_lat != null ? (
                <a className="btn ghost" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${trip.current_lat},${trip.current_lng}`}>Open driver in Google Maps</a>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
