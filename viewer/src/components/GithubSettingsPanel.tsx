import { useState } from "react";
import type { FormEvent } from "react";

interface Props {
  /** Currently saved GitHub username, if any. */
  initialGithubUsername?: string | null;
}

export default function GithubSettingsPanel({ initialGithubUsername = null }: Props) {
  const [githubUsername, setGithubUsername] = useState(initialGithubUsername ?? "");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setSaving(true);
    try {
      const resp = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUsername: githubUsername.trim() || null }),
      });
      const body = (await resp.json()) as {
        ok: boolean;
        error?: string;
        githubUsername?: string | null;
      };
      if (!resp.ok || !body.ok) {
        setError(body.error ?? `Request failed (HTTP ${resp.status}).`);
      } else {
        setGithubUsername(body.githubUsername ?? "");
        setSuccess(body.githubUsername ? "GitHub username saved." : "GitHub username cleared.");
      }
    } catch {
      setError("A network error occurred. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const trimmed = githubUsername.trim();
  const avatarSrc = trimmed
    ? `https://avatars.githubusercontent.com/${encodeURIComponent(trimmed)}?size=80`
    : null;

  return (
    <form onSubmit={handleSubmit}>
      <div className="lf-field" style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        {avatarSrc && (
          <img
            src={avatarSrc}
            alt={`${trimmed} GitHub avatar`}
            width={48}
            height={48}
            style={{ borderRadius: "50%", flexShrink: 0 }}
          />
        )}
        <div style={{ flex: 1 }}>
          <label htmlFor="acct-github" className="lf-label">
            GitHub username
          </label>
          <input
            id="acct-github"
            type="text"
            value={githubUsername}
            onChange={(e) => {
              setGithubUsername(e.target.value);
              setSuccess("");
              setError("");
            }}
            placeholder="e.g. octocat"
            className="lf-input"
            disabled={saving}
            autoComplete="off"
          />
        </div>
      </div>
      {error && <div className="lf-error">{error}</div>}
      {success && <div className="lf-success">{success}</div>}
      <button type="submit" disabled={saving} className="lf-submit">
        {saving ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
