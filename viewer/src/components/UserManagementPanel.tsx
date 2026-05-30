import { useState } from "react";

export interface PanelUser {
  id: number;
  username: string;
  is_admin: boolean;
  must_change_password: boolean;
  created_at: number;
}

interface Props {
  initial: PanelUser[];
}

function fmtDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

export default function UserManagementPanel({ initial }: Props) {
  const [users, setUsers] = useState<PanelUser[]>(initial);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);
  const [resetting, setResetting] = useState<number | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // The one-time temporary password from the most recent reset, shown until the
  // admin dismisses it (it is not recoverable once dismissed).
  const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(
    null
  );
  const locked = creating || deleting !== null || toggling !== null || resetting !== null;
  const adminCount = users.filter((u) => u.is_admin).length;

  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const u = username.trim();
    if (!u || !password) return;
    setCreating(true);
    setResult(null);
    try {
      const resp = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password, isAdmin: makeAdmin }),
      });
      const body = (await resp.json()) as { ok: boolean; user?: PanelUser; error?: string };
      if (!resp.ok || !body.ok || !body.user) {
        setResult({ ok: false, msg: body.error ?? `HTTP ${resp.status}` });
      } else {
        setResult({ ok: true, msg: `Created user "${u}".` });
        const created = body.user;
        setUsers((prev) => [...prev, created].sort((a, b) => a.username.localeCompare(b.username)));
        setUsername("");
        setPassword("");
        setMakeAdmin(false);
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setCreating(false);
  };

  const remove = async (user: PanelUser) => {
    const ok = window.confirm(
      `Delete user "${user.username}"? Their active sessions are revoked immediately.`
    );
    if (!ok) return;
    setDeleting(user.id);
    setResult(null);
    try {
      const resp = await fetch("/api/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id }),
      });
      const body = (await resp.json()) as { ok: boolean; error?: string };
      if (!resp.ok || !body.ok) {
        setResult({ ok: false, msg: `${user.username}: ${body.error ?? `HTTP ${resp.status}`}` });
      } else {
        setResult({ ok: true, msg: `Deleted user "${user.username}".` });
        setUsers((prev) => prev.filter((u) => u.id !== user.id));
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setDeleting(null);
  };

  const toggleAdmin = async (user: PanelUser) => {
    const next = !user.is_admin;
    setToggling(user.id);
    setResult(null);
    try {
      const resp = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id, isAdmin: next }),
      });
      const body = (await resp.json()) as { ok: boolean; error?: string };
      if (!resp.ok || !body.ok) {
        setResult({ ok: false, msg: `${user.username}: ${body.error ?? `HTTP ${resp.status}`}` });
      } else {
        setResult({
          ok: true,
          msg: `${next ? "Granted" : "Revoked"} admin for "${user.username}".`,
        });
        setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, is_admin: next } : u)));
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setToggling(null);
  };

  const resetPassword = async (user: PanelUser) => {
    const ok = window.confirm(
      `Reset the password for "${user.username}"? A one-time temporary password ` +
        `will be shown once; their existing sessions are revoked and they will be ` +
        `prompted to choose a new password.`
    );
    if (!ok) return;
    setResetting(user.id);
    setResult(null);
    setTempPassword(null);
    try {
      const resp = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id, resetPassword: true }),
      });
      const body = (await resp.json()) as { ok: boolean; tempPassword?: string; error?: string };
      if (!resp.ok || !body.ok || !body.tempPassword) {
        setResult({ ok: false, msg: `${user.username}: ${body.error ?? `HTTP ${resp.status}`}` });
      } else {
        setTempPassword({ username: user.username, password: body.tempPassword });
        setUsers((prev) =>
          prev.map((u) => (u.id === user.id ? { ...u, must_change_password: true } : u))
        );
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setResetting(null);
  };

  return (
    <div className="ext-inv">
      <p className="ext-inv-desc">
        Accounts that can sign in to the admin tools. Passwords are hashed (Argon2id) and never
        shown. Resetting a password issues a one-time temporary password (shown once), revokes the
        user's sessions, and flags them to choose a new one on next sign-in. Deleting a user
        immediately revokes their sessions. The last remaining user cannot be deleted.
      </p>

      <form className="ext-inv-form" onSubmit={create}>
        <label>
          Username
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="alice"
            required
          />
        </label>
        <label>
          Password (min 8 chars)
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            minLength={8}
            required
          />
        </label>
        <label className="ext-inv-check">
          <input
            type="checkbox"
            checked={makeAdmin}
            onChange={(e) => setMakeAdmin(e.target.checked)}
          />
          Admin
        </label>
        <button className="ext-inv-btn" type="submit" disabled={locked}>
          {creating ? "Creating…" : "Add user"}
        </button>
      </form>

      {result && (
        <div className={`ext-inv-result ext-inv-result--${result.ok ? "ok" : "error"}`}>
          {result.msg}
        </div>
      )}

      {tempPassword && (
        <div className="ext-inv-result ext-inv-result--ok">
          Temporary password for <code>{tempPassword.username}</code>:{" "}
          <code>{tempPassword.password}</code>. Copy it now — it is shown only once. The user must
          change it on their next sign-in.
          <button
            className="ext-inv-btn ext-inv-btn--small"
            type="button"
            style={{ marginLeft: "8px" }}
            onClick={() => setTempPassword(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {users.length === 0 ? (
        <p className="ext-inv-empty">No users yet.</p>
      ) : (
        <table className="ext-inv-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              // The last admin can't be demoted or deleted (it would lock the
              // admin tools out); mirror the server-side guard in the UI.
              const lastAdmin = u.is_admin && adminCount <= 1;
              return (
                <tr key={u.id}>
                  <td>
                    <code>{u.username}</code>
                  </td>
                  <td>
                    {u.is_admin ? <span className="ext-inv-badge">admin</span> : "user"}
                    {u.must_change_password && (
                      <span
                        className="ext-inv-badge"
                        title="An admin reset this password; the user must change it on next sign-in"
                      >
                        must change pw
                      </span>
                    )}
                  </td>
                  <td>{fmtDate(u.created_at)}</td>
                  <td className="ext-inv-actions">
                    <button
                      className="ext-inv-btn ext-inv-btn--small"
                      type="button"
                      disabled={locked || lastAdmin}
                      title={lastAdmin ? "The last admin cannot be demoted" : undefined}
                      onClick={() => void toggleAdmin(u)}
                    >
                      {toggling === u.id ? "Saving…" : u.is_admin ? "Revoke admin" : "Make admin"}
                    </button>
                    <button
                      className="ext-inv-btn ext-inv-btn--small"
                      type="button"
                      disabled={locked}
                      onClick={() => void resetPassword(u)}
                    >
                      {resetting === u.id ? "Resetting…" : "Reset password"}
                    </button>
                    <button
                      className="ext-inv-drop"
                      type="button"
                      disabled={locked || users.length <= 1 || lastAdmin}
                      onClick={() => void remove(u)}
                    >
                      {deleting === u.id ? "Deleting…" : "Delete"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
