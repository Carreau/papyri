import { useState } from "react";
import type { FormEvent } from "react";

interface Props {
  /** Dev demo credentials to surface as a hint; null in production. */
  demo?: { username: string; password: string } | null;
}

export default function LoginForm({ demo = null }: Props) {
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
        setError((data as { message?: string }).message || "Login failed");
      }
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setError("");
    setLoading(true);
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");

      const optResp = await fetch("/api/auth/passkey/login-options", { method: "POST" });
      if (!optResp.ok) {
        const e = (await optResp.json()) as { error?: string };
        throw new Error(e.error ?? "failed to get authentication options");
      }
      const options = await optResp.json();

      let credential;
      try {
        credential = await startAuthentication({ optionsJSON: options });
      } catch (err) {
        if (err instanceof Error && err.name === "NotAllowedError") return; // user cancelled
        throw err;
      }

      const verResp = await fetch("/api/auth/passkey/login-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: credential }),
      });
      const result = (await verResp.json()) as { ok: boolean; error?: string };
      if (!result.ok) throw new Error(result.error ?? "authentication failed");

      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey login failed");
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

      <div className="lf-divider">
        <span>or</span>
      </div>

      <button
        type="button"
        onClick={() => void handlePasskeyLogin()}
        disabled={loading}
        className="lf-passkey-btn"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="8" r="4" />
          <path d="M20 21a8 8 0 1 0-16 0" />
          <path d="m18 14 2 2 4-4" />
        </svg>
        Sign in with a passkey
      </button>

      {demo && (
        <div className="lf-hint">
          <div className="lf-hint-title">Dev demo credentials</div>
          <div>
            <code>{demo.username}</code> / <code>{demo.password}</code>
          </div>
        </div>
      )}
    </div>
  );
}
