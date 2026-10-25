import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { OpsIcon } from "../components/OpsIcon";
import { openInWindow } from "../lib/openWindow";
import { formatDateTime } from "../utils";
import { AIRPORT_LOOKAHEAD_MIN, span, minutesSince, tripExceptions, upcomingAirport } from "../opsExceptions";

const REFRESH_MS = 30000;
const STALE_MS = 120000;

// [feed name, access area]. A feed is only called when the person can view its area.
const FEEDS = [
  ["analytics", "analytics"],
  ["panics", "panics"],
  ["trips", "trip-tracker"],
  ["drivers", "drivers"],
  ["tickets", "support"],
  ["flights", "flight-issues"],
  ["vehicles", "vehicles"],
];

const TONE_RANK = { critical: 0, warning: 1, neutral: 2 };

function Metric({ label, value, detail, tone = "neutral", icon }) {
  return (
    <div className={`ops-metric ${tone}`}>
      <div className="ops-metric-icon"><OpsIcon name={icon} size={18} /></div>
      <div>
        <div className="ops-metric-value">{value}</div>
        <div className="ops-metric-label">{label}</div>
        {detail ? <div className="ops-metric-detail">{detail}</div> : null}
      </div>
    </div>
  );
}

function QueueItem({ tone, eyebrow, title, meta, action, onOpen }) {
  return (
    <button type="button" className={`ops-queue-item ${tone}`} onClick={onOpen}>
      <span className="ops-queue-marker" />
      <span className="ops-queue-copy">
        <span className="ops-queue-eyebrow">{eyebrow}</span>
        <strong>{title}</strong>
        <span>{meta}</span>
      </span>
      <span className="ops-queue-action">{action} <span aria-hidden="true">→</span></span>
    </button>
  );
}

function ReadinessRow({ label, value, hint, tone = "good" }) {
  return (
    <div className="ops-readiness-row">
      <div>
        <strong>{label}</strong>
        <span>{hint}</span>
      </div>
      <span className={`ops-readiness-badge ${tone}`}>{value}</span>
    </div>
  );
}

const EMPTY = { analytics: null, panics: [], trips: [], drivers: [], tickets: [], flights: [], vehicles: [] };

export function OpsOverviewPage({ setPage }) {
  const { token, can, user } = useAuth();
  const [data, setData] = useState(EMPTY);
  const [failed, setFailed] = useState([]); // feeds this person may view that did not load
  const [skipped, setSkipped] = useState([]); // feeds outside this person's access
  const [loaded, setLoaded] = useState([]); // feeds that have loaded at least once
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [tick, setTick] = useState(Date.now());
  const inFlight = useRef(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const calls = {
        analytics: () => api.getAnalytics(token),
        panics: () => api.getPanics(token),
        trips: () => api.getActiveTrips(token),
        drivers: () => api.getDrivers(token),
        tickets: () => api.getSupportTickets(token, "open"),
        flights: () => api.getFlightIssues(token),
        vehicles: () => api.getVehicles(token),
      };
      const names = FEEDS.map(([name]) => name);
      const allowed = FEEDS.filter(([, area]) => can(area)).map(([name]) => name);
      const results = await Promise.allSettled(names.map((n) => (allowed.includes(n) ? calls[n]() : Promise.resolve(null))));
      if (!alive.current) return;
      const byName = Object.fromEntries(names.map((n, i) => [n, results[i]]));
      const ok = (n) => allowed.includes(n) && byName[n].status === "fulfilled";
      const value = (n) => (ok(n) ? byName[n].value : null);
      setData((prev) => ({
        // A feed that failed keeps its last good numbers on screen, marked as unavailable below.
        analytics: ok("analytics") ? value("analytics") : prev.analytics,
        panics: ok("panics") ? value("panics")?.panics || [] : prev.panics,
        trips: ok("trips") ? value("trips")?.trips || [] : prev.trips,
        drivers: ok("drivers") ? value("drivers")?.drivers || [] : prev.drivers,
        tickets: ok("tickets") ? value("tickets")?.tickets || [] : prev.tickets,
        flights: ok("flights") ? value("flights")?.flightIssues || [] : prev.flights,
        vehicles: ok("vehicles") ? value("vehicles")?.vehicles || [] : prev.vehicles,
      }));
      setFailed(allowed.filter((n) => byName[n].status === "rejected"));
      setLoaded((prev) => [...new Set([...prev, ...allowed.filter((n) => byName[n].status === "fulfilled")])]);
      setSkipped(names.filter((n) => !allowed.includes(n)));
      if (allowed.some((n) => byName[n].status === "fulfilled")) setUpdatedAt(new Date());
      setLoading(false);
    } finally {
      inFlight.current = false;
    }
  }, [token, can]);

  useEffect(() => {
    alive.current = true;
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); setTick(Date.now()); }, REFRESH_MS);
    // Coming back to the tab should not show numbers from before it was hidden.
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive.current = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);

  const has = (name) => !skipped.includes(name);
  const down = (name) => failed.includes(name);
  const stale = updatedAt ? tick - updatedAt.getTime() > STALE_MS : false;

  const derived = useMemo(() => {
    const now = Date.now();
    const { trips, analytics, drivers, vehicles, panics, flights, tickets } = data;
    const inProgress = trips.filter((t) => t.ride_status === "in_progress").length;
    const waiting = trips.filter((t) => t.ride_status === "requested").length;
    const accepted = trips.filter((t) => t.ride_status === "accepted").length;
    const onlineDrivers = analytics?.onlineDrivers ?? drivers.filter((d) => d.is_online || d.online).length;
    const verifiedDrivers = analytics?.verifiedDrivers ?? drivers.filter((d) => d.is_verified).length;
    const unassignedVehicles = vehicles.filter((v) => !v.assigned_driver_name).length;

    const queue = [];
    panics.forEach((p) => {
      const active = minutesSince(p.panic_triggered_at, now);
      queue.push({
        key: `panic-${p.id}`, tone: "critical", rank: -(active || 0),
        eyebrow: "Safety · highest priority", title: `Panic on ride #${p.id}`,
        meta: `${p.rider_name || "Rider"}${active !== null ? ` · ${active} min active` : ""}`,
        page: "panics", action: "Open safety",
      });
    });
    tripExceptions(trips, now).forEach((e) => queue.push(e));
    flights.forEach((f) => queue.push({
      key: `flight-${f.id}`, tone: "warning", rank: 0, eyebrow: "Airport operations",
      title: `Flight ${f.flight_number || "change"} needs intervention`,
      meta: `Ride #${f.id} · ${f.flight_issue === "cancelled" ? "cancelled" : "schedule changed"}`,
      page: "flight-issues", action: "Review flight",
    }));
    tickets.slice(0, 5).forEach((t) => {
      const age = minutesSince(t.created_at, now);
      queue.push({
        key: `ticket-${t.id}`, tone: t.type === "complaint" || (age !== null && age > 24 * 60) ? "warning" : "neutral",
        rank: -(age || 0), eyebrow: `Support · ${t.type || "ticket"}`, title: t.subject || `Open ticket #${t.id}`,
        meta: `${t.user_name || "Rider"} · ${formatDateTime(t.created_at)}`, page: "support", action: "Open queue",
      });
    });
    queue.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || a.rank - b.rank);

    return {
      inProgress, waiting, accepted, onlineDrivers, verifiedDrivers, unassignedVehicles,
      queue: queue.slice(0, 8), queueTotal: queue.length,
      airport: upcomingAirport(trips, now),
      critical: queue.filter((q) => q.tone === "critical").length,
    };
    // tick re-evaluates the time based rules (waiting, overdue) between refreshes.
  }, [data, tick]);

  const posture = derived.critical
    ? { label: "Critical attention", tone: "critical", copy: `${derived.critical} ${derived.critical === 1 ? "item needs" : "items need"} an operator now.` }
    : derived.queueTotal
      ? { label: "Attention required", tone: "warning", copy: `${derived.queueTotal} open exception${derived.queueTotal === 1 ? "" : "s"} across active operations.` }
      : failed.length
        ? { label: "Partial picture", tone: "warning", copy: `${failed.length} feed${failed.length === 1 ? "" : "s"} could not load, so this view may be missing exceptions.` }
        : { label: "Operations stable", tone: "good", copy: "No open safety, dispatch, flight or support exceptions in your permitted queues." };

  // A feed that has never loaded must not read as zero or "clear": that would be a false all-clear.
  const unknown = (name) => !has(name) || (down(name) && !loaded.includes(name));
  const show = (name, value) => (unknown(name) ? "n/a" : value);
  const note = (name, text) => (!has(name) ? "Not in your access" : down(name) ? (loaded.includes(name) ? "Feed unavailable, showing last good value" : "Feed unavailable") : text);
  const ready = (name, value) => (!has(name) ? "n/a" : unknown(name) ? "Unavailable" : value);
  const openItem = (item) => (item.track ? openInWindow(`track/${item.track}`, `Ride #${item.track}`) : setPage(item.page));

  return (
    <div className="ops-overview">
      <section className="ops-command-hero">
        <div>
          <span className="eyebrow">Live operations command</span>
          <h1>ArrivoOps Command Center</h1>
          <p>One operating picture for dispatch, safety, riders, drivers, fleet and service recovery.</p>
        </div>
        <div className={`ops-posture ${posture.tone}`} role="status">
          <span className="ops-live-dot" />
          <div><strong>{posture.label}</strong><span>{posture.copy}</span></div>
        </div>
      </section>

      <div className="ops-metrics-grid">
        <Metric icon="car" label="Trips in progress" value={show("trips", derived.inProgress)} detail={note("trips", `${derived.accepted} accepted · ${derived.waiting} waiting`)} tone={has("trips") && derived.waiting ? "amber" : "teal"} />
        <Metric icon="users" label="Drivers online" value={has("analytics") || has("drivers") ? derived.onlineDrivers : "n/a"} detail={has("analytics") || has("drivers") ? `${derived.verifiedDrivers} verified fleet drivers` : "Not in your access"} tone="teal" />
        <Metric icon="alert" label="Active safety alerts" value={show("panics", data.panics.length)} detail={note("panics", data.panics.length ? "Immediate response required" : "No open panic alerts")} tone={has("panics") && data.panics.length ? "coral" : "neutral"} />
        <Metric icon="plane" label="Flight exceptions" value={show("flights", data.flights.length)} detail={note("flights", "Cancellations and reschedules")} tone={has("flights") && data.flights.length ? "amber" : "neutral"} />
        <Metric icon="message" label="Open support" value={show("tickets", data.tickets.length)} detail={note("tickets", "Current rider service queue")} tone={has("tickets") && data.tickets.length ? "amber" : "neutral"} />
        <Metric icon="car" label="Fleet unassigned" value={show("vehicles", derived.unassignedVehicles)} detail={note("vehicles", `${data.vehicles.length} vehicles visible`)} tone={has("vehicles") && derived.unassignedVehicles ? "amber" : "neutral"} />
      </div>

      <div className="ops-overview-grid">
        <section className="ops-panel ops-focus-panel">
          <div className="ops-panel-head">
            <div><span className="ops-panel-kicker">Manage by exception</span><h2>Focus queue</h2></div>
            <button type="button" className="ops-icon-button" onClick={load} title="Refresh command center" aria-label="Refresh command center"><OpsIcon name="refresh" /></button>
          </div>
          {loading ? <div className="ops-skeleton-list"><span /><span /><span /></div> : derived.queue.length ? (
            <div className="ops-queue-list">
              {derived.queue.map((item) => <QueueItem key={item.key} {...item} onOpen={() => openItem(item)} />)}
              {derived.queueTotal > derived.queue.length ? <div className="ops-panel-note">{derived.queueTotal - derived.queue.length} more not shown. Open the matching page for the full list.</div> : null}
            </div>
          ) : failed.length ? (
            <div className="ops-clear-state"><OpsIcon name="alert" size={28} /><strong>Cannot confirm the queue is clear</strong><span>Some feeds failed to load. Check the warning below before treating this as quiet.</span></div>
          ) : (
            <div className="ops-clear-state"><OpsIcon name="shield" size={28} /><strong>No open exceptions</strong><span>The queues available to {user?.name || "you"} are clear right now.</span></div>
          )}
          {failed.length ? <div className="ops-feed-warning" role="alert">{failed.length} feed{failed.length > 1 ? "s" : ""} could not be refreshed ({failed.join(", ")}). Other pages stay available from the navigation.</div> : null}
          {stale ? <div className="ops-feed-warning" role="alert">This view has not refreshed for over {Math.round(STALE_MS / 60000)} minutes. Use the refresh button before relying on it.</div> : null}
        </section>

        <div className="ops-side-stack">
          <section className="ops-panel">
            <div className="ops-panel-head"><div><span className="ops-panel-kicker">Current capacity</span><h2>Operational readiness</h2></div></div>
            <div className="ops-readiness-list">
              <ReadinessRow label="Dispatch" value={ready("trips", derived.inProgress ? `${derived.inProgress} live` : "Ready")} hint={`${derived.waiting} requested · ${derived.accepted} accepted`} tone={unknown("trips") ? "watch" : derived.waiting ? "watch" : "good"} />
              <ReadinessRow label="Safety" value={ready("panics", data.panics.length ? `${data.panics.length} alert` : "Clear")} hint="Active rider panic queue" tone={unknown("panics") ? "watch" : data.panics.length ? "critical" : "good"} />
              <ReadinessRow label="Airport ops" value={ready("flights", data.flights.length ? `${data.flights.length} issue` : "Clear")} hint="Flight cancellations and reschedules" tone={unknown("flights") || data.flights.length ? "watch" : "good"} />
              <ReadinessRow label="Fleet supply" value={ready("vehicles", data.vehicles.length ? `${data.vehicles.length} listed` : "None")} hint={`${derived.unassignedVehicles} not assigned to a driver`} tone={derived.unassignedVehicles ? "watch" : "good"} />
              <ReadinessRow label="Rider support" value={ready("tickets", data.tickets.length ? `${data.tickets.length} open` : "Clear")} hint="Current service recovery queue" tone={unknown("tickets") || data.tickets.length ? "watch" : "good"} />
            </div>
          </section>

          {has("trips") ? (
            <section className="ops-panel">
              <div className="ops-panel-head"><div><span className="ops-panel-kicker">Next {AIRPORT_LOOKAHEAD_MIN / 60} hours</span><h2>Airport pickups</h2></div></div>
              {derived.airport.length ? (
                <div className="ops-airport-list">
                  {derived.airport.map(({ trip, until }) => (
                    <button key={trip.id} type="button" className="ops-airport-row" onClick={() => openInWindow(`track/${trip.id}`, `Ride #${trip.id}`)}>
                      <span className="ops-airport-flight"><OpsIcon name="plane" size={15} />{trip.flight_number}</span>
                      <span className="ops-airport-meta">{trip.rider_name || "Rider"} · {until < 0 ? `${span(until)} overdue` : `in ${span(until)}`}</span>
                      <span className={`ops-readiness-badge ${trip.driver_name ? "good" : "watch"}`}>{trip.driver_name ? "Driver set" : "No driver"}</span>
                    </button>
                  ))}
                </div>
              ) : <div className="ops-panel-note">No airport pickups with a flight number in the next {AIRPORT_LOOKAHEAD_MIN / 60} hours.</div>}
            </section>
          ) : null}
        </div>
      </div>

      <section className="ops-panel ops-launchpad">
        <div className="ops-panel-head">
          <div><span className="ops-panel-kicker">Multitask workspace</span><h2>Open another operations surface</h2></div>
          <span className="ops-panel-note">Opens as another RA-workspace window when embedded</span>
        </div>
        <div className="ops-launch-grid">
          {[
            ["ride-desk", "headset", "Ride Desk", "Coordinate live rides, people and handoffs"],
            ["trip-tracker", "radar", "Trip Tracker", "Track trip state, route and flight context"],
            ["live-map", "map", "Live Map", "Keep moving rides visible while you work"],
            ["panics", "alert", "Safety", "Keep the panic queue in a dedicated window"],
            ["drivers", "users", "Drivers", "Review driver readiness and verification"],
            ["support", "message", "Support", "Keep service-recovery work beside dispatch"],
          ].filter(([id]) => can(id)).map(([id, icon, label, text]) => (
            <button key={id} type="button" className="ops-launch-card" onClick={() => openInWindow(id, label)}>
              <span><OpsIcon name={icon} size={20} /></span><div><strong>{label}</strong><small>{text}</small></div><OpsIcon name="external" size={16} />
            </button>
          ))}
        </div>
      </section>

      <div className="ops-refresh-line"><span className="ops-live-dot" /> Auto-refreshes every {REFRESH_MS / 1000} seconds{updatedAt ? ` · last updated ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</div>
    </div>
  );
}
