import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { formatDateTime } from "../utils";
import { PhoneLink } from "../components/PhoneLink";
import { StatusPill } from "../components/StatusPill";

// Tickets riders submit from the Support screen in the app. Until this page
// existed they were write-only: the endpoint stored them and nothing ever
// showed them to anyone.
//
// Filtering is done server-side because the API caps the list at 200, newest
// first. Filter in the browser instead and a busy month of closed tickets
// would push open ones off the end where nobody would ever see them.

const TYPE_TONE = {
  complaint: "coral",
  inquiry: "muted",
  support: "amber",
};

// A complaint reads as the one most likely to need a person, so it gets the
// same red treatment the panic list uses.
const CARD_TONE = {
  complaint: "alert-card danger",
  inquiry: "alert-card",
  support: "alert-card warning",
};

const FILTERS = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

export function SupportPage() {
  const { token, isReadOnly } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [filter, setFilter] = useState("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [closingId, setClosingId] = useState(null);

  const load = useCallback(async () => {
    try {
      const { tickets } = await api.getSupportTickets(token, filter === "all" ? undefined : filter);
      setTickets(tickets);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, filter]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const close = async (id) => {
    setClosingId(id);
    try {
      await api.setSupportTicketStatus(token, id, "closed");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setClosingId(null);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Riders</span>
          <h1>Support Tickets</h1>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`btn ${filter === f.id ? "primary" : "ghost"}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      {loading ? (
        <div className="empty-state">Loading tickets...</div>
      ) : tickets.length === 0 ? (
        <div className="empty-state">
          {filter === "open"
            ? "No open tickets. Nothing is waiting on anyone right now."
            : filter === "closed"
            ? "No closed tickets yet."
            : "No tickets have been submitted yet."}
        </div>
      ) : (
        tickets.map((t) => (
          <div key={t.id} className={CARD_TONE[t.type] || "alert-card"} style={{ marginBottom: 14 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
                marginBottom: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <StatusPill label={t.type} tone={TYPE_TONE[t.type] || "muted"} />
                  <StatusPill label={t.status} tone={t.status === "open" ? "amber" : "teal"} />
                  <span style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                    #{t.id} · {formatDateTime(t.created_at)}
                  </span>
                </div>
                <div style={{ fontWeight: 700, fontSize: 15, marginTop: 8 }}>{t.subject}</div>
              </div>

              {/* Closing is a mutation, so a support account is told why there's
                  no button rather than being shown one that would 403. */}
              {t.status === "open" ? (
                isReadOnly ? (
                  <span style={{ color: "var(--text-muted)", fontSize: 12.5 }}>Admin only</span>
                ) : (
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={closingId === t.id}
                    onClick={() => close(t.id)}
                  >
                    {closingId === t.id ? "Closing..." : "Mark closed"}
                  </button>
                )
              ) : null}
            </div>

            <div style={{ whiteSpace: "pre-wrap", fontSize: 13.5, marginBottom: 14 }}>{t.description}</div>

            <div className="detail-grid" style={{ fontSize: 13.5 }}>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginBottom: 2 }}>RIDER</div>
                <div style={{ fontWeight: 600 }}>{t.user_name}</div>
                <div>
                  <a href={`mailto:${t.user_email}`} style={{ color: "var(--teal)", fontWeight: 600 }}>
                    {t.user_email}
                  </a>
                </div>
                <div>
                  <PhoneLink phone={t.user_phone} fallback="No phone on file" />
                </div>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginBottom: 2 }}>BOOKING</div>
                {t.ride_id ? (
                  <div style={{ fontWeight: 600 }}>Ride #{t.ride_id}</div>
                ) : (
                  <div style={{ color: "var(--text-muted)" }}>Nothing attached</div>
                )}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
