import { useState } from "react";

export interface PanelUser {
  id: number;
  username: string;
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
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const locked = creating || deleting !== null;

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
        body: JSON.stringify({ username: u, password }),
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

  return (
    <div className="ext-inv">
      <p className="ext-inv-desc">
        Accounts that can sign in to the admin tools. Passwords are hashed (scrypt) and never shown.
        Deleting a user immediately revokes their sessions. The last remaining user cannot be
        deleted.
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
        <button className="ext-inv-btn" type="submit" disabled={locked}>
          {creating ? "Creating…" : "Add user"}
        </button>
      </form>

      {result && (
        <div className={`ext-inv-result ext-inv-result--${result.ok ? "ok" : "error"}`}>
          {result.msg}
        </div>
      )}

      {users.length === 0 ? (
        <p className="ext-inv-empty">No users yet.</p>
      ) : (
        <table className="ext-inv-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <code>{u.username}</code>
                </td>
                <td>{fmtDate(u.created_at)}</td>
                <td className="ext-inv-actions">
                  <button
                    className="ext-inv-drop"
                    type="button"
                    disabled={locked || users.length <= 1}
                    onClick={() => void remove(u)}
                  >
                    {deleting === u.id ? "Deleting…" : "Delete"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
