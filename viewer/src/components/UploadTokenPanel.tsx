import { useState } from "react";

export interface PanelToken {
  id: number;
  user_id: number;
  name: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

interface Props {
  initial: PanelToken[];
  /** Project names the user may upload (admins see a note instead). */
  projects: string[];
  isAdmin: boolean;
}

function fmtDate(epochSeconds: number | null): string {
  if (!epochSeconds) return "—";
  return new Date(epochSeconds * 1000).toLocaleString();
}

export default function UploadTokenPanel({ initial, projects, isAdmin }: Props) {
  const [tokens, setTokens] = useState<PanelToken[]>(initial);
  const [name, setName] = useState("");
  const [ttlDays, setTtlDays] = useState("");
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<number | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // The freshly-minted secret, shown once until dismissed.
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const locked = creating || revoking !== null;

  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCreating(true);
    setResult(null);
    setNewSecret(null);
    try {
      const payload: { name?: string; ttlDays?: number } = {};
      if (name.trim()) payload.name = name.trim();
      if (ttlDays.trim()) payload.ttlDays = Number(ttlDays);
      const resp = await fetch("/api/account/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await resp.json()) as {
        ok: boolean;
        token?: PanelToken;
        secret?: string;
        error?: string;
      };
      if (!resp.ok || !body.ok || !body.token || !body.secret) {
        setResult({ ok: false, msg: body.error ?? `HTTP ${resp.status}` });
      } else {
        const created = body.token;
        setTokens((prev) => [created, ...prev]);
        setNewSecret(body.secret);
        setName("");
        setTtlDays("");
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setCreating(false);
  };

  const revoke = async (token: PanelToken) => {
    const label = token.name || `token #${token.id}`;
    if (!window.confirm(`Revoke "${label}"? Any CI or client using it can no longer upload.`)) {
      return;
    }
    setRevoking(token.id);
    setResult(null);
    try {
      const resp = await fetch("/api/account/tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: token.id }),
      });
      const body = (await resp.json()) as { ok: boolean; error?: string };
      if (!resp.ok || !body.ok) {
        setResult({ ok: false, msg: body.error ?? `HTTP ${resp.status}` });
      } else {
        setResult({ ok: true, msg: `Revoked "${label}".` });
        setTokens((prev) => prev.filter((t) => t.id !== token.id));
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setRevoking(null);
  };

  return (
    <div className="ext-inv">
      <p className="ext-inv-desc">
        Personal upload tokens let <code>papyri upload</code> ship documentation on your behalf.
        Pass one as <code>--token</code> or <code>$PAPYRI_UPLOAD_TOKEN</code>.{" "}
        {isAdmin ? (
          <>You are an admin, so a token of yours can upload any project.</>
        ) : projects.length > 0 ? (
          <>
            Your tokens can upload: <code>{projects.join(", ")}</code>.
          </>
        ) : (
          <>
            You are not assigned to any project yet, so a token cannot upload anything until an
            admin assigns you to one.
          </>
        )}
      </p>

      <form className="ext-inv-form" onSubmit={create}>
        <label>
          Label (optional)
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ci, laptop, …"
            maxLength={64}
          />
        </label>
        <label>
          Expires in days (optional)
          <input
            type="number"
            value={ttlDays}
            onChange={(e) => setTtlDays(e.target.value)}
            placeholder="never"
            min={1}
          />
        </label>
        <button className="ext-inv-btn" type="submit" disabled={locked}>
          {creating ? "Creating…" : "Create token"}
        </button>
      </form>

      {newSecret && (
        <div className="ext-inv-result ext-inv-result--ok token-secret">
          <p>
            <strong>Copy this token now — it will not be shown again:</strong>
          </p>
          <code className="token-secret-value">{newSecret}</code>
        </div>
      )}

      {result && (
        <div className={`ext-inv-result ext-inv-result--${result.ok ? "ok" : "error"}`}>
          {result.msg}
        </div>
      )}

      {tokens.length === 0 ? (
        <p className="ext-inv-empty">No tokens yet.</p>
      ) : (
        <table className="ext-inv-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.name ? <code>{t.name}</code> : <em className="ext-inv-muted">(unnamed)</em>}
                </td>
                <td>{fmtDate(t.created_at)}</td>
                <td>{fmtDate(t.last_used_at)}</td>
                <td>
                  {t.expires_at ? fmtDate(t.expires_at) : <em className="ext-inv-muted">never</em>}
                </td>
                <td className="ext-inv-actions">
                  <button
                    className="ext-inv-drop"
                    type="button"
                    disabled={locked}
                    onClick={() => void revoke(t)}
                  >
                    {revoking === t.id ? "Revoking…" : "Revoke"}
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
