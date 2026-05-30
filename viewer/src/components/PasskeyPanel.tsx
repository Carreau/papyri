import { useState, useCallback } from "react";
import type { PublicPasskeyCredential } from "../lib/passkey.ts";

interface Props {
  initial: PublicPasskeyCredential[];
}

function fmt(ts: number | null): string {
  if (ts === null) return "never";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function PasskeyPanel({ initial }: Props) {
  const [passkeys, setPasskeys] = useState<PublicPasskeyCredential[]>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  const refresh = useCallback(async () => {
    const r = await fetch("/api/account/passkeys");
    if (r.ok) {
      const data = (await r.json()) as { passkeys: PublicPasskeyCredential[] };
      setPasskeys(data.passkeys);
    }
  }, []);

  const addPasskey = async () => {
    setError("");
    setBusy(true);
    try {
      // Lazy-load the browser library so it's not in the initial bundle.
      const { startRegistration } = await import("@simplewebauthn/browser");

      const optResp = await fetch("/api/auth/passkey/register-options");
      if (!optResp.ok) {
        const e = (await optResp.json()) as { error?: string };
        throw new Error(e.error ?? "failed to get registration options");
      }
      const options = await optResp.json();

      const name = prompt('Name this passkey (e.g. "MacBook Touch ID"):')?.trim() ?? null;

      let credential;
      try {
        credential = await startRegistration({ optionsJSON: options });
      } catch (err) {
        if (err instanceof Error && err.name === "NotAllowedError") return; // user cancelled
        throw err;
      }

      const verResp = await fetch("/api/auth/passkey/register-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: credential, name }),
      });
      const result = (await verResp.json()) as { ok: boolean; error?: string };
      if (!result.ok) throw new Error(result.error ?? "registration failed");

      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Remove this passkey? You won't be able to use it to sign in.")) return;
    setError("");
    setBusy(true);
    try {
      const r = await fetch("/api/account/passkeys", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = (await r.json()) as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "delete failed");
      setPasskeys((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (pk: PublicPasskeyCredential) => {
    setEditingId(pk.id);
    setEditName(pk.name ?? "");
  };

  const saveEdit = async (id: number) => {
    setError("");
    setBusy(true);
    try {
      const r = await fetch("/api/account/passkeys", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: editName }),
      });
      const data = (await r.json()) as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "rename failed");
      setPasskeys((prev) => prev.map((p) => (p.id === id ? { ...p, name: editName || null } : p)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pk-panel">
      {passkeys.length === 0 ? (
        <p className="pk-empty">No passkeys registered yet.</p>
      ) : (
        <ul className="pk-list">
          {passkeys.map((pk) => (
            <li key={pk.id} className="pk-item">
              <div className="pk-item-main">
                {editingId === pk.id ? (
                  <span className="pk-edit-row">
                    <input
                      className="lf-input pk-name-input"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Passkey name"
                      disabled={busy}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveEdit(pk.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                    <button
                      className="pk-btn pk-btn-save"
                      onClick={() => void saveEdit(pk.id)}
                      disabled={busy}
                    >
                      Save
                    </button>
                    <button
                      className="pk-btn pk-btn-cancel"
                      onClick={() => setEditingId(null)}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="pk-name">{pk.name ?? <em>Unnamed</em>}</span>
                    <span className="pk-meta">
                      Added {fmt(pk.created_at)} · Last used {fmt(pk.last_used_at)}
                      {pk.backedUp && " · synced"}
                    </span>
                  </>
                )}
              </div>
              {editingId !== pk.id && (
                <span className="pk-actions">
                  <button
                    className="pk-btn pk-btn-rename"
                    onClick={() => startEdit(pk)}
                    disabled={busy}
                  >
                    Rename
                  </button>
                  <button
                    className="pk-btn pk-btn-remove"
                    onClick={() => void remove(pk.id)}
                    disabled={busy}
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <div className="lf-error pk-error">{error}</div>}

      <button className="lf-submit pk-add-btn" onClick={() => void addPasskey()} disabled={busy}>
        {busy ? "Working…" : "+ Add passkey"}
      </button>

      <style>{`
        .pk-panel { margin-top: 4px; }
        .pk-empty { font-size: 13px; color: var(--muted, #666); margin: 0 0 12px; }
        .pk-list { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .pk-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--border, #e5e5e5); border-radius: 6px; background: var(--surface-raised, #fafafa); }
        .pk-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .pk-name { font-size: 14px; font-weight: 500; }
        .pk-name em { font-weight: normal; color: var(--muted, #666); font-style: normal; }
        .pk-meta { font-size: 12px; color: var(--muted, #888); }
        .pk-actions { display: flex; gap: 6px; flex-shrink: 0; align-items: center; }
        .pk-edit-row { display: flex; align-items: center; gap: 6px; }
        .pk-name-input { flex: 1; min-width: 0; font-size: 13px; padding: 4px 8px; }
        .pk-btn { font-size: 12px; padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border, #ccc); background: var(--surface, #fff); cursor: pointer; white-space: nowrap; }
        .pk-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .pk-btn-remove { color: var(--error, #c0392b); border-color: var(--error, #c0392b); }
        .pk-btn-remove:hover:not(:disabled) { background: var(--error, #c0392b); color: #fff; }
        .pk-btn-save { color: var(--accent, #0066cc); border-color: var(--accent, #0066cc); }
        .pk-btn-save:hover:not(:disabled) { background: var(--accent, #0066cc); color: #fff; }
        .pk-add-btn { margin-top: 0; }
        .pk-error { margin-bottom: 10px; }
      `}</style>
    </div>
  );
}
