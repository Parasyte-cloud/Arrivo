import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill, rideStatusTone } from "../components/StatusPill";
import { StaffCallButton } from "../components/StaffCallButton";
import { formatDateTime } from "../utils";
import { greeting, callOutcome, statusLabel, tabsFor, reassignableTeams, canManageDuty, teamLine, firstName, roleOptions } from "../rideDeskHelpers";

// Ride Desk: the one place support, operations and admins deal with a ride.
// Every ride has a support agent, an operations person and (once accepted) a
// driver. Pick a ride to see the rider's and driver's profiles, greet them by
// name, and call them in the app or from your own phone.

function PhoneRow({ rideId, subject, person, token, onError }) {
  const phone = person && person.phone;
  if (!phone) return <div className="desk-muted">No number on file</div>;
  const log = () => { api.logPhoneCall(token, rideId, subject).catch((e) => onError && onError(e.message)); };
  return (
    <a className="btn ghost desk-phone" href={`tel:${phone}`} onClick={log} aria-label={`Call ${firstName(person.name)} from your own phone`}>
      📱 Call from my phone · {phone}
    </a>
  );
}

function PersonCard({ title, person, subject, rideId, token, disabled, extra, onError }) {
  if (!person) {
    return (
      <div className="desk-card" data-testid={`card-${subject}`}>
        <div className="desk-eyebrow">{title}</div>
        <div className="desk-muted">{subject === "driver" ? "No driver has accepted yet." : "Unavailable"}</div>
      </div>
    );
  }
  return (
    <div className="desk-card" data-testid={`card-${subject}`}>
      <div className="desk-eyebrow">{title}</div>
      <div className="desk-name">{person.name}</div>
      <div className="desk-hello">{greeting(person)}</div>
      <dl className="desk-dl">
        {person.email ? (<><dt>Email</dt><dd>{person.email}</dd></>) : null}
        {extra}
      </dl>
      <StaffCallButton rideId={rideId} target={subject} name={person.firstName || firstName(person.name)} disabled={disabled} big />
      <div style={{ marginTop: 8 }}>
        <PhoneRow rideId={rideId} subject={subject} person={person} token={token} onError={onError} />
      </div>
    </div>
  );
}

function Detail({ rideId, me, isLead, onChanged }) {
  const { token } = useAuth();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [staff, setStaff] = useState([]);
  const [moving, setMoving] = useState(false);

  const load = useCallback(async () => {
    try { setD(await api.getDeskRide(token, rideId)); setErr(null); } catch (e) { setErr(e.message); }
  }, [token, rideId]);
  useEffect(() => { setD(null); load(); }, [load]);

  const teams = reassignableTeams({ role: me.role, isLead });
  useEffect(() => {
    if (!teams.length) return;
    api.getDeskTeam(token).then((r) => setStaff(r.staff.filter((s) => s.onDuty))).catch(() => {});
  }, [token, rideId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div className="error-text" role="alert">{err}</div>;
  if (!d) return <div className="empty-state">Loading ride…</div>;
  const r = d.ride;
  const callsOpen = true;

  const move = async (team, userId) => {
    if (!userId) return;
    setMoving(true);
    try { await api.reassignRide(token, rideId, team, Number(userId)); await load(); onChanged && onChanged(); }
    catch (e) { setErr(e.message); } finally { setMoving(false); }
  };

  return (
    <div className="desk-detail" data-testid="desk-detail">
      <div className="desk-detail-head">
        <div>
          <div className="desk-eyebrow">Ride #{r.id}</div>
          <h2 className="desk-h2">{r.pickup}</h2>
          {r.stops && r.stops.length ? <div className="desk-muted">via {r.stops.join(", ")}</div> : null}
        </div>
        <StatusPill label={statusLabel(r.status)} tone={rideStatusTone(r.status)} />
      </div>
      {r.panic ? <div className="desk-panic" role="alert">Safety alert active on this ride. Check the Panic Alerts page.</div> : null}

      <div className="desk-team" data-testid="desk-team">
        <span className="desk-eyebrow">Ride team</span>
        <span>{teamLine(r.team)}</span>
        {r.driver ? <span> · Driver {r.driver.firstName}</span> : null}
      </div>

      {teams.length ? (
        <div className="desk-move">
          {teams.map((t) => (
            <label key={t}>
              Move {t}
              <select className="field" disabled={moving} value="" onChange={(e) => move(t, e.target.value)} aria-label={`Move ${t} to`}>
                <option value="">Choose…</option>
                {staff.filter((s) => s.team === t).map((s) => (
                  <option key={s.userId} value={s.userId}>{s.firstName} ({s.openRides} open)</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : null}

      <div className="desk-grid2">
        <PersonCard
          title="Rider" person={d.rider} subject="rider" rideId={r.id} token={token} disabled={!callsOpen} onError={setErr}
          extra={<>
            <dt>Rides</dt><dd>{d.rider.completedRides} completed of {d.rider.rides}</dd>
            <dt>Language</dt><dd>{d.rider.language}</dd>
          </>}
        />
        <PersonCard
          title="Driver" person={d.driver} subject="driver" rideId={r.id} token={token} disabled={!d.driver} onError={setErr}
          extra={d.driver ? <>
            {d.driver.rating != null ? (<><dt>Rating</dt><dd>{Number(d.driver.rating).toFixed(1)}</dd></>) : null}
            {d.driver.vehicle ? (<><dt>Vehicle</dt><dd>{d.driver.vehicle.model} · {d.driver.vehicle.plate}</dd></>) : null}
          </> : null}
        />
      </div>

      <div className="desk-card">
        <div className="desk-eyebrow">Trip</div>
        <dl className="desk-dl">
          <dt>Fare</dt><dd>₦{Number(r.fareNaira).toLocaleString()} · {r.paymentStatus}</dd>
          {r.vehicleType ? (<><dt>Vehicle</dt><dd>{r.vehicleType}</dd></>) : null}
          {r.scheduledPickupAt ? (<><dt>Pickup</dt><dd>{formatDateTime(r.scheduledPickupAt)}</dd></>) : null}
          {r.flightNumber ? (<><dt>Flight</dt><dd>{r.flightNumber}</dd></>) : null}
          {r.emergencyContact ? (<><dt>Emergency contact</dt><dd>{r.emergencyContact.name} {r.emergencyContact.phone}</dd></>) : null}
        </dl>
      </div>

      <div className="desk-grid2">
        <div className="desk-card">
          <div className="desk-eyebrow">Calls on this ride</div>
          {d.calls.length ? <ul className="desk-list">{d.calls.map((c) => <li key={c.id}>{callOutcome(c)} <span className="desk-muted">{formatDateTime(c.at)}</span></li>)}</ul> : <div className="desk-muted">No calls yet.</div>}
        </div>
        <div className="desk-card">
          <div className="desk-eyebrow">Support tickets</div>
          {d.tickets.length ? <ul className="desk-list">{d.tickets.map((t) => <li key={t.id}>#{t.id} {t.subject} <span className="desk-muted">{t.status}{t.assignedTo ? ` · ${t.assignedTo}` : ""}</span></li>)}</ul> : <div className="desk-muted">None.</div>}
        </div>
      </div>

      <div className="desk-card">
        <div className="desk-eyebrow">Who has handled it</div>
        {d.history.length ? <ul className="desk-list">{d.history.map((h, i) => <li key={i}>{h.team}: {h.kind}{h.to ? ` to ${h.to}` : ""}{h.from ? ` from ${h.from}` : ""} <span className="desk-muted">{formatDateTime(h.at)}</span></li>)}</ul> : <div className="desk-muted">No history.</div>}
      </div>
    </div>
  );
}

function RideRow({ r, active, onPick }) {
  return (
    <button className={`desk-row${active ? " active" : ""}${r.panic ? " panic" : ""}`} onClick={() => onPick(r.id)} data-testid="desk-row" aria-pressed={active}>
      <div className="desk-row-top">
        <strong>#{r.id} · {r.rider.firstName}</strong>
        <StatusPill label={statusLabel(r.status)} tone={rideStatusTone(r.status)} />
      </div>
      <div className="desk-muted desk-clip">{r.pickup}</div>
      <div className="desk-row-team">{teamLine(r.team)}{r.driver ? ` · Driver ${r.driver.firstName}` : ""}</div>
    </button>
  );
}

function TeamTab({ me, isLead, token }) {
  const [t, setT] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => api.getDeskTeam(token).then(setT).catch((e) => setErr(e.message)), [token]);
  useEffect(() => { load(); const i = setInterval(load, 15000); return () => clearInterval(i); }, [load]);
  if (err) return <div className="error-text">{err}</div>;
  if (!t) return <div className="empty-state">Loading…</div>;
  const toggle = async (s) => {
    try { await api.setDuty(token, { userId: s.userId, onDuty: !s.onDuty }); await load(); } catch (e) { setErr(e.message); }
  };
  const makeLead = async (s) => {
    try { await api.setSupportLead(token, s.userId, !s.isLead); await load(); } catch (e) { setErr(e.message); }
  };
  return (
    <div>
      <div className="desk-waiting" data-testid="waiting">
        Waiting for a support agent: <strong>{t.waiting.waiting_support}</strong> · Waiting for operations: <strong>{t.waiting.waiting_operations}</strong>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Team</th><th>Open rides</th><th>On duty</th><th></th></tr></thead>
          <tbody>
            {t.staff.map((s) => (
              <tr key={s.userId}>
                <td>{s.name}{s.isLead ? <span className="desk-lead"> Head of support</span> : null}</td>
                <td>{s.team}</td>
                <td>{s.openRides} of {s.maxOpen}</td>
                <td>{s.onDuty ? <StatusPill label="On duty" tone="teal" /> : <StatusPill label="Off duty" tone="muted" />}</td>
                <td className="desk-actions">
                  {canManageDuty({ role: me.role, isLead }, { role: s.role }) ? <button className="btn ghost" onClick={() => toggle(s)}>{s.onDuty ? "Take off duty" : "Put on duty"}</button> : null}
                  {me.role === "admin" && s.role === "support" ? <button className="btn ghost" onClick={() => makeLead(s)}>{s.isLead ? "Remove as head" : "Make head of support"}</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!t.staff.length ? <div className="empty-state">Nobody has gone on duty yet.</div> : null}
      </div>
    </div>
  );
}

function PeopleTab({ token, meId }) {
  const [data, setData] = useState(null);
  const [events, setEvents] = useState([]);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("support");
  const load = useCallback(async () => {
    try { setData(await api.getPeople(token)); setEvents((await api.getPeopleEvents(token)).events); setErr(null); } catch (e) { setErr(e.message); }
  }, [token]);
  useEffect(() => { load(); }, [load]);
  if (err && !data) return <div className="error-text">{err}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;
  const { me, people } = data;
  const act = async (fn, ok) => {
    setErr(null); setMsg(null);
    try { await fn(); setMsg(ok); await load(); } catch (e) { setErr(e.message); }
  };
  const change = (p, r) => {
    const word = r === "rider" ? `Remove ${firstName(p.name)} from staff? They will be signed out and their open rides move to others.` : `Make ${firstName(p.name)} ${r}? They will be signed out and must sign in again.`;
    if (window.confirm(word)) act(() => api.changePersonRole(token, p.id, r), `${firstName(p.name)} is now ${r === "rider" ? "removed from staff" : r}.`);
  };
  const eventText = { promote: "brought onto staff", change: "changed role", remove: "removed from staff", grant_manage: "given staff management", revoke_manage: "staff management taken away" };
  return (
    <div data-testid="people">
      {msg ? <div className="desk-waiting">{msg}</div> : null}
      {err ? <div className="error-text">{err}</div> : null}
      {me.canManage ? (
        <form className="desk-promote" onSubmit={(e) => { e.preventDefault(); act(() => api.promotePerson(token, email.trim(), role), "Done. They must sign in again."); setEmail(""); }}>
          <input type="email" required placeholder="Email of an existing account" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
            <option value="support">Support</option>
            <option value="operations">Operations</option>
            {me.isOwner ? <option value="admin">Admin</option> : null}
          </select>
          <button className="btn" type="submit">Add to staff</button>
        </form>
      ) : <div className="desk-waiting">You can see everyone on staff. Only the owner, or an admin the owner has given staff management, can change it.</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>On duty</th><th>Open rides</th><th></th></tr></thead>
          <tbody>
            {people.map((p) => {
              const opts = roleOptions(me, p, meId);
              return (
                <tr key={p.id}>
                  <td>{p.name}<div className="desk-sub">{p.email}</div></td>
                  <td>{p.is_owner ? "Owner" : p.role}{p.support_lead ? <span className="desk-lead"> Head of support</span> : null}{p.can_manage_staff ? <span className="desk-lead"> Manages staff</span> : null}</td>
                  <td>{p.on_duty ? <StatusPill label="On duty" tone="teal" /> : <StatusPill label="Off duty" tone="muted" />}</td>
                  <td>{p.openRides}</td>
                  <td className="desk-actions">
                    {opts.map((r) => <button key={r} className="btn ghost" onClick={() => change(p, r)}>Make {r}</button>)}
                    {opts.length ? <button className="btn ghost" onClick={() => change(p, "rider")}>Remove</button> : null}
                    {me.isOwner && p.role === "admin" && !p.is_owner ? (
                      <button className="btn ghost" onClick={() => act(() => api.setCanManageStaff(token, p.id, !p.can_manage_staff), "Saved.")}>
                        {p.can_manage_staff ? "Take away staff management" : "Let manage staff"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h3 className="desk-h3">Recent changes</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}><td>{formatDateTime(e.created_at)}</td><td>{e.actor_name || "Someone"}</td>
                <td>{e.target_name || "A person"} {eventText[e.action] || e.action}{e.from_role && e.to_role && e.from_role !== e.to_role ? ` (${e.from_role} to ${e.to_role})` : ""}</td></tr>
            ))}
          </tbody>
        </table>
        {!events.length ? <div className="empty-state">No changes yet.</div> : null}
      </div>
    </div>
  );
}

function LogTab({ token }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.getAccessLog(token).then((r) => setRows(r.entries)).catch((e) => setErr(e.message)); }, [token]);
  if (err) return <div className="error-text">{err}</div>;
  if (!rows) return <div className="empty-state">Loading…</div>;
  const label = { view_number: "Looked at the number", call_in_app: "Called in the app", call_from_phone: "Called from their phone" };
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>When</th><th>Staff</th><th>Did</th><th>About</th><th>Ride</th></tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}><td>{formatDateTime(e.at)}</td><td>{e.staff}</td><td>{label[e.action] || e.action}</td><td>{e.subject} ({e.subjectRole})</td><td>#{e.rideId}</td></tr>
          ))}
        </tbody>
      </table>
      {!rows.length ? <div className="empty-state">Nothing yet.</div> : null}
    </div>
  );
}

export function RideDeskPage() {
  const { token, user } = useAuth();
  const [duty, setDuty] = useState(null);
  const [isLead, setIsLead] = useState(false);
  const [tab, setTab] = useState("mine");
  const [state, setState] = useState("open");
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);

  const tabs = useMemo(() => tabsFor({ role: user.role, isLead }), [user.role, isLead]);
  const isRides = tab === "mine" || tab === "all" || tab === "unassigned";

  const loadDuty = useCallback(() => api.getMyDuty(token).then((r) => { setDuty(r.duty); setIsLead(r.isLead); }).catch(() => {}), [token]);
  useEffect(() => { loadDuty(); }, [loadDuty]);

  const loadRides = useCallback(async () => {
    if (!isRides) return;
    try { setData(await api.getDesk(token, { scope: tab, state, q })); setErr(null); }
    catch (e) { setErr(e.message); }
  }, [token, tab, state, q, isRides]);
  useEffect(() => {
    const t = setTimeout(loadRides, q ? 300 : 0);
    const i = setInterval(loadRides, 15000);
    return () => { clearTimeout(t); clearInterval(i); };
  }, [loadRides, q]);

  const onDuty = !!(duty && duty.onDuty);
  const flip = async () => {
    setBusy(true);
    try { const r = await api.setDuty(token, { onDuty: !onDuty }); setDuty(r.duty); await loadRides(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="desk">
      <div className="page-header">
        <div>
          <span className="eyebrow">Ride Desk</span>
          <h1 style={{ margin: 0 }}>Rides, riders and drivers in one place</h1>
        </div>
        <div className="desk-duty">
          <div>
            <div className="desk-eyebrow">{onDuty ? "You are on duty" : "You are off duty"}</div>
            <div className="desk-muted">{duty ? `${duty.openRides} open ride${duty.openRides === 1 ? "" : "s"}` : "Not set up yet"}</div>
          </div>
          <button className={`btn ${onDuty ? "ghost" : "primary"}`} onClick={flip} disabled={busy} aria-pressed={onDuty} data-testid="duty-toggle">
            {onDuty ? "Go off duty" : "Go on duty"}
          </button>
        </div>
      </div>
      {!onDuty && duty ? <div className="desk-note">You are off duty, so new rides are not coming to you. Go on duty to start receiving them.</div> : null}
      {!duty ? <div className="desk-note">Go on duty to start receiving rides. Rides are shared fairly between everyone who is on duty.</div> : null}

      <div className="desk-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`desk-tab${tab === t.id ? " active" : ""}`} onClick={() => { setTab(t.id); setPicked(null); }}>
            {t.label}
            {data && data.counts && t.id === "mine" ? <span className="desk-count">{data.counts.mine}</span> : null}
            {data && data.counts && t.id === "unassigned" ? <span className="desk-count warn">{data.counts.unassigned}</span> : null}
          </button>
        ))}
      </div>

      {err ? <div className="error-text" role="alert">{err}</div> : null}

      {tab === "team" ? <TeamTab me={user} isLead={isLead} token={token} /> : null}
      {tab === "log" ? <LogTab token={token} /> : null}
      {tab === "people" ? <PeopleTab token={token} meId={user.id} /> : null}

      {isRides ? (
        <div className="desk-split">
          <div className="desk-listcol">
            <div className="desk-filters">
              <input className="field" placeholder="Search name, address or ride number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search rides" />
              <select className="field" value={state} onChange={(e) => setState(e.target.value)} aria-label="Ride state">
                <option value="open">Open</option><option value="closed">Finished</option><option value="all">All</option>
              </select>
            </div>
            {!data ? <div className="empty-state">Loading…</div> : data.rides.length === 0 ? (
              <div className="empty-state" data-testid="desk-empty">
                {tab === "mine" ? "No rides with you right now. New rides are shared between everyone on duty." : "Nothing here."}
              </div>
            ) : data.rides.map((r) => <RideRow key={r.id} r={r} active={picked === r.id} onPick={setPicked} />)}
          </div>
          <div className="desk-detailcol">
            {picked ? <Detail key={picked} rideId={picked} me={user} isLead={isLead} onChanged={loadRides} /> : <div className="empty-state">Pick a ride to see the rider, the driver and your team.</div>}
          </div>
        </div>
      ) : null}
    </div>
  );
}
