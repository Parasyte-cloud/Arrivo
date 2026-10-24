import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";
import { formatDateTime } from "../utils";
import { firstName, roleOptions } from "../rideDeskHelpers";

// Everyone on staff, what each person can see and change in this console, and
// who changed what. The owner, or an admin the owner allows, makes changes.
// The backend enforces every permission (arrivo-backend/services/staffAccess.js).

const LEVEL_LABEL = { none: "Hidden", view: "View", manage: "Manage" };
const EVENT_TEXT = {
  promote: "brought onto staff", change: "changed role", remove: "removed from staff",
  grant_manage: "given staff management", revoke_manage: "staff management taken away",
  permissions: "access changed",
};
const DAY = 24 * 60 * 60 * 1000;

function accessSummary(permissions) {
  const values = Object.values(permissions || {});
  const manage = values.filter((v) => v === "manage").length;
  const view = values.filter((v) => v === "view").length;
  if (!manage && !view) return "No pages";
  return [manage ? `${manage} manage` : null, view ? `${view} view` : null].filter(Boolean).join(", ");
}

function canEdit(me, person, myId) {
  if (!me.canManage || person.id === myId || person.is_owner) return false;
  return me.isOwner || person.role !== "admin";
}

function AccessEditor({ person, catalog, onClose, onSaved }) {
  const { token } = useAuth();
  const [draft, setDraft] = useState(person.permissions);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const preset = catalog.presets[person.role] || {};
  const changed = catalog.areas.filter((a) => draft[a.id] !== person.permissions[a.id]);

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const body = Object.fromEntries(changed.map((a) => [a.id, draft[a.id]]));
      await api.setPersonPermissions(token, person.id, body);
      onSaved(`${firstName(person.name)}'s access is saved. It applies on their next click, no sign-out needed.`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card team-editor" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{person.name}</h3>
        <div className="desk-sub" style={{ marginBottom: 12 }}>{person.email} · {person.role}. Starting point is the {person.role} preset, marked with a dot.</div>
        <div className="team-grid">
          {catalog.areas.map((a) => (
            <div className="team-row" key={a.id}>
              <div className="team-area">{a.label}</div>
              <div className="team-levels" role="radiogroup" aria-label={a.label}>
                {catalog.levels.map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    role="radio"
                    aria-checked={draft[a.id] === lvl}
                    className={`team-level ${draft[a.id] === lvl ? `on ${lvl}` : ""}`}
                    onClick={() => setDraft({ ...draft, [a.id]: lvl })}
                  >
                    {LEVEL_LABEL[lvl]}{preset[a.id] === lvl ? " •" : ""}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {err ? <div className="error-text">{err}</div> : null}
        <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={saving || !changed.length} onClick={save}>
            {saving ? "Saving…" : changed.length ? `Save ${changed.length} change${changed.length > 1 ? "s" : ""}` : "No changes"}
          </button>
          <button className="btn ghost" onClick={() => setDraft({ ...preset })}>Reset to {person.role} preset</button>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function TeamPage() {
  const { token, user, reloadAccess } = useAuth();
  const [data, setData] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [events, setEvents] = useState([]);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("support");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      const [people, cat, ev] = await Promise.all([api.getPeople(token), api.getAccessCatalog(token), api.getPeopleEvents(token)]);
      setData(people); setCatalog(cat); setEvents(ev.events); setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const people = useMemo(() => {
    const list = (data && data.people) || [];
    const q = search.trim().toLowerCase();
    return q ? list.filter((p) => `${p.name} ${p.email} ${p.role}`.toLowerCase().includes(q)) : list;
  }, [data, search]);

  if (err && !data) return <div className="error-text">{err}</div>;
  if (!data || !catalog) return <div className="empty-state">Loading…</div>;
  const { me } = data;
  const all = data.people;
  const stale = all.filter((p) => !p.last_login_at || Date.now() - new Date(p.last_login_at).getTime() > 30 * DAY);

  const act = async (fn, ok) => {
    setErr(null); setMsg(null);
    try { await fn(); setMsg(ok); await load(); reloadAccess(); } catch (e) { setErr(e.message); }
  };
  const changeRole = (p, r) => {
    const word = r === "rider"
      ? `Remove ${firstName(p.name)} from staff? They're signed out everywhere at once and their open rides move to others.`
      : `Make ${firstName(p.name)} ${r}? They're signed out and start from the ${r} preset.`;
    if (window.confirm(word)) act(() => api.changePersonRole(token, p.id, r), `${firstName(p.name)} is now ${r === "rider" ? "removed from staff" : r}.`);
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="eyebrow">Team & Access</div>
          <h1>Who can see and do what</h1>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card"><div className="stat-num">{all.length}</div><div className="stat-label">Staff accounts</div></div>
        <div className="stat-card"><div className="stat-num">{all.filter((p) => p.role === "admin").length}</div><div className="stat-label">Admins</div></div>
        <div className="stat-card"><div className="stat-num">{all.filter((p) => p.on_duty).length}</div><div className="stat-label">On duty now</div></div>
        <div className="stat-card"><div className="stat-num" style={{ color: stale.length ? "var(--amber)" : undefined }}>{stale.length}</div><div className="stat-label">No sign-in for 30 days</div></div>
      </div>

      {msg ? <div className="desk-waiting">{msg}</div> : null}
      {err ? <div className="error-text">{err}</div> : null}

      {me.canManage ? (
        <form className="desk-promote" onSubmit={(e) => { e.preventDefault(); act(() => api.promotePerson(token, email.trim(), role), "Added. They start from that role's preset and must sign in again."); setEmail(""); }}>
          <input className="field" type="email" required placeholder="Email of an existing account" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
          <select className="field" style={{ maxWidth: 160 }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
            <option value="support">Support</option>
            <option value="operations">Operations</option>
            {me.isOwner ? <option value="admin">Admin</option> : null}
          </select>
          <button className="btn" type="submit">Add to staff</button>
        </form>
      ) : (
        <div className="desk-waiting">You can see everyone on staff. Only the owner, or an admin the owner allows, can change it.</div>
      )}

      <input className="field" style={{ maxWidth: 320, margin: "12px 0" }} placeholder="Search name, email or role" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search staff" />

      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Access</th><th>Last sign-in</th><th>On duty</th><th></th></tr></thead>
          <tbody>
            {people.map((p) => {
              const opts = roleOptions(me, p, user.id);
              const editable = canEdit(me, p, user.id);
              return (
                <tr key={p.id}>
                  <td>{p.name}<div className="desk-sub">{p.email}</div></td>
                  <td>
                    {p.is_owner ? "Owner" : p.role}
                    {p.support_lead ? <span className="desk-lead"> Head of support</span> : null}
                    {p.can_manage_staff ? <span className="desk-lead"> Manages staff</span> : null}
                  </td>
                  <td>
                    {p.is_owner ? "Everything" : accessSummary(p.permissions)}
                    {p.customised && p.customised.length ? <span className="desk-lead"> Custom</span> : null}
                  </td>
                  <td>{p.last_login_at ? formatDateTime(p.last_login_at) : <span style={{ color: "var(--text-muted)" }}>Never</span>}</td>
                  <td>{p.on_duty ? <StatusPill label="On duty" tone="teal" /> : <StatusPill label="Off duty" tone="muted" />}</td>
                  <td className="desk-actions">
                    {editable ? <button className="btn" onClick={() => setEditing(p)}>Edit access</button> : null}
                    {opts.map((r) => <button key={r} className="btn ghost" onClick={() => changeRole(p, r)}>Make {r}</button>)}
                    {opts.length ? <button className="btn ghost" onClick={() => changeRole(p, "rider")}>Remove</button> : null}
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
        {!people.length ? <div className="empty-state">Nobody matches that.</div> : null}
      </div>

      <h3 className="desk-h3">Recent changes</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{formatDateTime(e.created_at)}</td>
                <td>{e.actor_name || "Someone"}</td>
                <td>
                  {e.target_name || "A person"} {EVENT_TEXT[e.action] || e.action}
                  {e.from_role && e.to_role && e.from_role !== e.to_role ? ` (${e.from_role} to ${e.to_role})` : ""}
                  {e.action === "permissions" && e.note ? <div className="desk-sub">{e.note}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!events.length ? <div className="empty-state">No changes yet.</div> : null}
      </div>

      {editing ? (
        <AccessEditor
          person={editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSaved={(text) => { setEditing(null); setMsg(text); load(); }}
        />
      ) : null}
    </div>
  );
}
