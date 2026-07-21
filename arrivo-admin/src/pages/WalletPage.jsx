import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";
import { formatDateTime } from "../utils";

const TYPE_LABELS = {
  topup: "Top-up",
  ride_charge: "Ride charge",
  membership_charge: "Membership charge",
  tip: "Tip",
  credit: "Credit",
  refund: "Refund",
};

function typeTone(type) {
  if (type === "topup" || type === "credit" || type === "refund") return "teal";
  if (type === "ride_charge" || type === "membership_charge") return "muted";
  return "amber";
}

// The wallet_transactions ledger (db/schema.sql) — every top-up, ride
// charge, membership charge, tip, credit, and refund, across every rider.
// This is the view that used to require a direct database query: when a
// rider disputed their balance, there was nowhere in the admin panel to
// actually see the transaction log a wallet_balance_naira figure comes
// from. Read-only for both admin and support — no adjustment/refund
// action lives here yet, this is visibility only.
export function WalletPage() {
  const { token } = useAuth();
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const { transactions } = await api.getWalletTransactions(token);
      setTransactions(transactions);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const filtered = transactions.filter((t) => {
    if (typeFilter && t.type !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return t.user_name.toLowerCase().includes(q) || t.user_email.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Money movement</span>
          <h1>Wallet</h1>
        </div>
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 12.5, marginTop: -12, marginBottom: 20 }}>
        Showing the most recent {transactions.length} transactions across all riders. This is view-only — balance
        corrections still happen through Paystack/your usual process.
      </p>

      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search by rider name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="field"
          style={{ flex: 1, minWidth: 220, maxWidth: 320 }}
        />
        <button className={`btn ${typeFilter === "" ? "primary" : "ghost"}`} onClick={() => setTypeFilter("")}>All</button>
        {Object.entries(TYPE_LABELS).map(([key, label]) => (
          <button
            key={key}
            className={`btn ${typeFilter === key ? "primary" : "ghost"}`}
            onClick={() => setTypeFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading transactions…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">{transactions.length === 0 ? "No wallet activity yet." : "No transactions match this filter."}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Rider</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Balance after</th>
                <th>Status</th>
                <th>Description</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{t.user_name}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{t.user_email}</div>
                  </td>
                  <td><StatusPill label={TYPE_LABELS[t.type] || t.type} tone={typeTone(t.type)} /></td>
                  <td style={{ color: t.amount_naira < 0 ? "var(--coral)" : "var(--teal)", fontWeight: 600 }}>
                    {t.amount_naira < 0 ? "−" : "+"}₦{Math.abs(t.amount_naira).toLocaleString()}
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                    {t.balance_after_naira != null ? `₦${t.balance_after_naira.toLocaleString()}` : "—"}
                  </td>
                  <td>
                    <StatusPill label={t.status} tone={t.status === "completed" ? "teal" : t.status === "failed" ? "coral" : "amber"} />
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{t.description || "—"}</td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{formatDateTime(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
