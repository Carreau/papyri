import { useState } from "react";
import type { FormEvent } from "react";

interface Props {
  /** When true the form opens immediately (admin-forced password reset). */
  mustChange?: boolean;
}

export default function AccountSettingsPanel({ mustChange = false }: Props) {
  const [open, setOpen] = useState(mustChange);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }

    setSaving(true);
    try {
      const resp = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = (await resp.json()) as { ok: boolean; error?: string; revokedSessions?: number };
      if (!resp.ok || !body.ok) {
        setError(body.error ?? `Request failed (HTTP ${resp.status}).`);
      } else {
        const revoked = body.revokedSessions ?? 0;
        setSuccess(
          revoked > 0
            ? `Password updated. ${revoked} other session${revoked === 1 ? "" : "s"} signed out.`
            : "Password updated."
        );
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setOpen(false);
      }
    } catch {
      setError("A network error occurred. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
  };

  if (!open) {
    return (
      <div className="acct-collapsed">
        {success && <div className="lf-success">{success}</div>}
        <button type="button" className="lf-submit acct-change-btn" onClick={() => setOpen(true)}>
          Change password
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="lf-field">
        <label htmlFor="acct-current" className="lf-label">
          Current password
        </label>
        <input
          id="acct-current"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="Enter current password"
          className="lf-input"
          disabled={saving}
          autoComplete="current-password"
          required
          autoFocus
        />
      </div>

      <div className="lf-field">
        <label htmlFor="acct-new" className="lf-label">
          New password (min 8 chars)
        </label>
        <input
          id="acct-new"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="Enter new password"
          className="lf-input"
          disabled={saving}
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>

      <div className="lf-field">
        <label htmlFor="acct-confirm" className="lf-label">
          Confirm new password
        </label>
        <input
          id="acct-confirm"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Re-enter new password"
          className="lf-input"
          disabled={saving}
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>

      {error && <div className="lf-error">{error}</div>}

      <div className="acct-actions">
        <button type="submit" disabled={saving} className="lf-submit">
          {saving ? "Updating…" : "Update password"}
        </button>
        {!mustChange && (
          <button
            type="button"
            disabled={saving}
            className="lf-submit acct-cancel-btn"
            onClick={handleCancel}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
