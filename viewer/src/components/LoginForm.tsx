import { useState } from "react";
import type { FormEvent } from "react";

export default function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        // Login lives on the admin surface (and `/` on that surface 404s
        // when the split is enabled), so land on the admin dashboard.
        window.location.href = "/admin";
      } else {
        const data = await response.json();
        setError(data.message || "Login failed");
      }
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <div className="lf-field">
          <label htmlFor="username" className="lf-label">
            Username
          </label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter username"
            className="lf-input"
            disabled={loading}
            autoFocus
          />
        </div>

        <div className="lf-field">
          <label htmlFor="password" className="lf-label">
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            className="lf-input"
            disabled={loading}
          />
        </div>

        {error && <div className="lf-error">{error}</div>}

        <button type="submit" disabled={loading} className="lf-submit">
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <div className="lf-hint">
        <div className="lf-hint-title">Demo credentials</div>
        <div>
          <code>admin</code> / <code>password</code>
        </div>
      </div>
    </div>
  );
}
