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
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        window.location.href = "/";
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

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    boxSizing: "border-box",
    border: "1px solid #d0d0d0",
    borderRadius: "6px",
    fontSize: "14px",
    background: "var(--surface, #fff)",
    color: "inherit",
  };

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: "14px" }}>
          <label
            htmlFor="username"
            style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 500 }}
          >
            Username
          </label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter username"
            style={inputStyle}
            disabled={loading}
            autoFocus
          />
        </div>

        <div style={{ marginBottom: "20px" }}>
          <label
            htmlFor="password"
            style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 500 }}
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            style={inputStyle}
            disabled={loading}
          />
        </div>

        {error && (
          <div
            style={{
              color: "#b00020",
              background: "#fdecea",
              padding: "8px 10px",
              borderRadius: "6px",
              marginBottom: "14px",
              fontSize: "13px",
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            width: "100%",
            padding: "10px",
            backgroundColor: loading ? "#9bbfe6" : "#0066cc",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: "14px",
            fontWeight: 500,
          }}
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <div
        style={{
          marginTop: "20px",
          padding: "12px",
          background: "rgba(0,0,0,0.03)",
          borderRadius: "6px",
          fontSize: "12px",
          color: "var(--muted, #666)",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: "4px" }}>Demo credentials</div>
        <div>
          <code>admin</code> / <code>password</code>
        </div>
      </div>
    </div>
  );
}
