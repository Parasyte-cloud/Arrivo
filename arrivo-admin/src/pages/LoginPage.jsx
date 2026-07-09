import { useState } from "react";
import { useAuth } from "../AuthContext";

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
    } catch (err) {
      setError(err.message || "Couldn't log in.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">arrivo</div>
        <div className="brand-sub">OPS CONSOLE</div>

        <input
          className="field"
          type="email"
          placeholder="Admin email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <input
          className="field"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error ? <div className="error-text">{error}</div> : null}

        <button className="btn primary" type="submit" style={{ width: "100%", padding: "12px 0", fontSize: 13.5 }} disabled={loading}>
          {loading ? "Logging in…" : "Log In"}
        </button>

        <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 16, textAlign: "center" }}>
          Admin accounts are created via the backend's <code>create-admin.js</code> script — there's no public signup here.
        </p>
      </form>
    </div>
  );
}
