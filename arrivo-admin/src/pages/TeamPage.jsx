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
  setup_email: "had their setup email resent",
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
  const [staffName, setStaffName] = useState("");
  const [role, setRole] = useState("support");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [setupBusyId, setSetupBusyId] = useState(null);
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
  const resendSetup = async (p) => {
    if (setupBusyId) return;

    setSetupBusyId(p.id);
    setErr(null);
    setMsg(null);

    try {
      const result =
        await api.resendPersonSetup(
          token,
          p.id
        );

      setMsg(
        result.emailDelivery === "sent"
          ? `A new password setup email was sent to ${p.email}.`
          : result.emailDelivery === "not_configured"
            ? `Setup email for ${p.email} was regenerated, but email delivery is not configured.`
            : `A new setup link was generated for ${p.email}, but delivery failed.`
      );

      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSetupBusyId(null);
    }
  };

  const changeRole = (p, r) => {
    const word = r === "rider"
      ? `Remove ${firstName(p.name)} from staff? They're signed out everywhere at once and their open rides move to others.`
      : `Make ${firstName(p.name)} ${r}? They're signed out and start from the ${r} preset.`;
    if (window.confirm(word)) act(() => api.changePersonRole(token, p.id, r), `${firstName(p.name)} is now ${r === "rider" ? "removed from staff" : r}.`);
  };

  return (
    <div className="team2-page">
      <div className="page-header team2Hero">
        <div className="team2HeroCopy">
          <div className="eyebrow">
            Administration / Identity & Access
          </div>
          <h1>Team & Access</h1>
          <p>
            Govern ArrivoOps staff identities, operational roles and console
            permissions from one secure workspace.
          </p>
        </div>

        <div className="team2SecurityMark" aria-label="Access control status">
          <span>ACCESS CONTROL</span>
          <strong>Governed</strong>
          <small>Role and permission changes are audited</small>
        </div>
      </div>

      <div className="stat-grid team2Stats">
        <div className="stat-card team2StatCard">
          <div className="stat-num">{all.length}</div>
          <div className="stat-label">ArrivoOps staff</div>
        </div>

        <div className="stat-card team2StatCard">
          <div className="stat-num">
            {all.filter((p) => p.role === "support").length}
          </div>
          <div className="stat-label">Support</div>
        </div>

        <div className="stat-card team2StatCard">
          <div className="stat-num">
            {all.filter((p) => p.role === "operations").length}
          </div>
          <div className="stat-label">Operations</div>
        </div>

        <div className="stat-card team2StatCard">
          <div className="stat-num">
            {all.filter((p) => p.role === "admin").length}
          </div>
          <div className="stat-label">Admins</div>
        </div>

        <div className="stat-card team2StatCard">
          <div className="stat-num">
            {all.filter((p) => p.on_duty).length}
          </div>
          <div className="stat-label">On duty</div>
        </div>

        <div className="stat-card team2StatCard">
          <div
            className="stat-num"
            style={{ color: stale.length ? "var(--amber)" : undefined }}
          >
            {stale.length}
          </div>
          <div className="stat-label">Needs sign-in review</div>
        </div>
      </div>

      {msg ? <div className="desk-waiting">{msg}</div> : null}
      {err ? <div className="error-text">{err}</div> : null}

      {me.canManage ? (
        <form
          className="desk-promote team2InviteCard"
          onSubmit={async (e) => {
            e.preventDefault();
            if (inviteBusy) return;

            setInviteBusy(true);
            setErr(null);
            setMsg(null);

            try {
              const result = await api.promotePerson(
                token,
                email.trim(),
                role,
                "Managed through Team & Access",
                staffName.trim()
              );

              if (result?.created) {
                const deliveryMessage =
                  result.emailDelivery === "sent"
                    ? "Staff account provisioned and the secure password setup email was sent."
                    : result.emailDelivery === "not_configured"
                      ? "Staff account provisioned, but setup email delivery is not configured. Use Resend setup email after mail is configured."
                      : "Staff account provisioned, but the setup email could not be delivered. Use Resend setup email.";

                setMsg(deliveryMessage);
              } else {
                setMsg(
                  "Existing account updated. The new staff role and access preset are active."
                );
              }

              setEmail("");
              setStaffName("");
              await load();
              reloadAccess();
            } catch (e) {
              setErr(e.message);
            } finally {
              setInviteBusy(false);
            }
          }}
        >
          <div className="team2InviteIntro">
            <div className="team2InviteIcon" aria-hidden="true">+</div>

            <div>
              <div className="eyebrow">Add or invite staff</div>
              <h3>Grant ArrivoOps access</h3>
              <p>
                Existing Arrivo accounts are promoted immediately. If a
                @ridearrivo.com address does not yet exist in ArrivoOps, it can
                be provisioned securely here.
              </p>
            </div>
          </div>

          <div className="team2InviteFields">
            <label>
              <span>Name <em>optional</em></span>
              <input
                className="field"
                type="text"
                maxLength={120}
                autoComplete="name"
                placeholder="e.g. Wuraola Awotungase"
                value={staffName}
                onChange={(e) => setStaffName(e.target.value)}
              />
            </label>

            <label>
              <span>Company email</span>
              <input
                className="field"
                type="email"
                required
                autoComplete="email"
                placeholder="support@ridearrivo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>

            <label>
              <span>Role</span>
              <select
                className="field"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                aria-label="Role"
              >
                <option value="support">Support</option>
                <option value="operations">Operations</option>
                {me.isOwner ? <option value="admin">Admin</option> : null}
              </select>
            </label>

            <button
              className="btn primary team2InviteButton"
              type="submit"
              disabled={inviteBusy}
            >
              {inviteBusy ? "Adding…" : "Add / invite staff"}
            </button>
          </div>

          <div className="team2InviteFoot">
            <span>Company-managed identity</span>
            <span>Secure password setup</span>
            <span>Audited role assignment</span>
          </div>
        </form>
      ) : (
        <div className="desk-waiting">
          You can view the staff directory. Only the owner, or an authorised
          admin, can change staff access.
        </div>
      )}

      <div className="team2DirectoryToolbar">
        <div>
          <strong>Staff directory</strong>
          <small>{people.length} of {all.length} staff shown</small>
        </div>

        <div className="team2Search">
          <span aria-hidden="true">⌕</span>
          <input
            className="field"
            placeholder="Search name, email or role"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search staff"
          />
        </div>
      </div>

      <div className="table-wrap team2DirectoryTable">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email address</th>
              <th>Setup</th>
              <th>Role</th>
              <th>Access</th>
              <th>Last sign-in</th>
              <th>Duty</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const opts = roleOptions(me, p, user.id);
              const editable = canEdit(me, p, user.id);
              return (
                <tr key={p.id}>
                  <td data-label="Name">
                    <div className="team2Person">
                      <div className="team2Avatar" aria-hidden="true">
                        {(p.name || p.email || "?").trim().charAt(0).toUpperCase()}
                      </div>

                      <div>
                        <strong>{p.name || "Unnamed staff"}</strong>
                        {p.is_owner ? <small>Workspace owner</small> : null}
                      </div>
                    </div>
                  </td>

                  <td data-label="Email address">
                    {p.email ? (
                      <a className="team2Email" href={`mailto:${p.email}`}>
                        {p.email}
                      </a>
                    ) : (
                      <span className="team2MissingEmail">
                        Email unavailable
                      </span>
                    )}
                  </td>

                  <td data-label="Setup">
                    <div className="team2SetupState">
                      <span
                        className={`team2Setup team2Setup-${
                          p.setup_status || "active"
                        }`}
                      >
                        {p.setup_status === "pending"
                          ? "Setup pending"
                          : p.setup_status === "expired"
                            ? "Invite expired"
                            : "Active"}
                      </span>

                      {p.setup_status !== "active" &&
                      p.invitation_delivery_status ? (
                        <small>
                          Email: {
                            p.invitation_delivery_status === "sent"
                              ? "sent"
                              : p.invitation_delivery_status === "not_configured"
                                ? "not configured"
                                : "failed"
                          }
                        </small>
                      ) : null}
                    </div>
                  </td>

                  <td data-label="Role">
                    <span
                      className={`team2Role team2Role-${
                        p.is_owner ? "owner" : p.role
                      }`}
                    >
                      {p.is_owner ? "Owner" : p.role}
                    </span>

                    <div className="team2RoleMeta">
                      {p.support_lead ? <span>Head of support</span> : null}
                      {p.can_manage_staff ? <span>Manages staff</span> : null}
                    </div>
                  </td>

                  <td data-label="Access">
                    {p.is_owner ? "Everything" : accessSummary(p.permissions)}
                    {p.customised && p.customised.length ? (
                      <span className="desk-lead"> Custom</span>
                    ) : null}
                  </td>

                  <td data-label="Last sign-in">
                    {p.last_login_at ? (
                      formatDateTime(p.last_login_at)
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>
                        Never
                      </span>
                    )}
                  </td>

                  <td data-label="Duty">
                    {p.on_duty ? (
                      <StatusPill label="On duty" tone="teal" />
                    ) : (
                      <StatusPill label="Off duty" tone="muted" />
                    )}
                  </td>

                  <td className="desk-actions" data-label="Actions">
                    {editable ||
                    opts.length ||
                    (me.isOwner && p.role === "admin" && !p.is_owner) ? (
                      <details className="team2ActionMenu">
                        <summary>Manage</summary>

                        <div className="team2ActionPopover">
                          {editable ? (
                            <button
                              type="button"
                              onClick={() => setEditing(p)}
                            >
                              Edit access
                            </button>
                          ) : null}

                          {editable &&
                          p.setup_status !== "active" ? (
                            <button
                              type="button"
                              disabled={setupBusyId === p.id}
                              onClick={() => {
                                void resendSetup(p);
                              }}
                            >
                              {setupBusyId === p.id
                                ? "Sending setup email…"
                                : "Resend setup email"}
                            </button>
                          ) : null}

                          {opts.map((r) => (
                            <button
                              type="button"
                              key={r}
                              onClick={() => changeRole(p, r)}
                            >
                              Make {r}
                            </button>
                          ))}

                          {me.isOwner &&
                          p.role === "admin" &&
                          !p.is_owner ? (
                            <button
                              type="button"
                              onClick={() =>
                                act(
                                  () =>
                                    api.setCanManageStaff(
                                      token,
                                      p.id,
                                      !p.can_manage_staff
                                    ),
                                  "Saved."
                                )
                              }
                            >
                              {p.can_manage_staff
                                ? "Remove staff management"
                                : "Allow staff management"}
                            </button>
                          ) : null}

                          {opts.length ? (
                            <button
                              type="button"
                              className="danger"
                              onClick={() => changeRole(p, "rider")}
                            >
                              Remove from staff
                            </button>
                          ) : null}
                        </div>
                      </details>
                    ) : (
                      <span className="team2Locked">Protected</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!people.length ? <div className="empty-state">Nobody matches that.</div> : null}
      </div>

      <div className="team2SectionHeading">
        <div>
          <div className="eyebrow">Audit trail</div>
          <h3 className="desk-h3">Recent access changes</h3>
        </div>
        <small>{events.length} recent events</small>
      </div>
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
