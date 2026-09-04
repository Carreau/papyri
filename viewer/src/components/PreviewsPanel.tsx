import { useState } from "react";

/** One live preview namespace, as the admin page renders it. */
export interface PanelPreview {
  id: string;
  owner: string;
  repo: string;
  pr: number;
  base: string;
  updated_at: number;
  expires_at: number;
  bundles: Array<{ module: string; version: string }>;
}

interface Props {
  initialPreviews: PanelPreview[];
}

function fmtDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

/**
 * Admin panel: live PR preview namespaces, with a manual drop.
 *
 * Previews normally clean themselves up — the papyri action drops one when its
 * pull request closes, and anything missed expires on its TTL — so this is the
 * escape hatch, not the routine path.
 */
export default function PreviewsPanel({ initialPreviews }: Props) {
  const [previews, setPreviews] = useState<PanelPreview[]>(initialPreviews);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const drop = async (p: PanelPreview) => {
    if (!window.confirm(`Drop the preview for ${p.id}? Its bundles are deleted.`)) return;
    setBusy(true);
    setResult(null);
    try {
      const resp = await fetch(`/api/preview?id=${encodeURIComponent(p.id)}`, {
        method: "DELETE",
      });
      const body = (await resp.json()) as { ok: boolean; error?: string };
      if (!resp.ok || !body.ok) {
        setResult({ ok: false, msg: body.error ?? `HTTP ${resp.status}` });
      } else {
        setPreviews((prev) => prev.filter((x) => x.id !== p.id));
        setResult({ ok: true, msg: `Dropped ${p.id}.` });
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setBusy(false);
  };

  return (
    <div className="ext-inv">
      <p className="ext-inv-desc">
        Each pull-request preview lives in its own database and blob directory, so it never
        contributes back-references or search hits to the main store — and dropping one deletes a
        directory rather than unwinding a graph.
      </p>

      {result && (
        <div className={`ext-inv-result ext-inv-result--${result.ok ? "ok" : "error"}`}>
          {result.msg}
        </div>
      )}

      {previews.length === 0 ? (
        <p className="ext-inv-empty">No live previews.</p>
      ) : (
        <table className="ext-inv-table">
          <thead>
            <tr>
              <th>Pull request</th>
              <th>Bundles</th>
              <th>Last upload</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {previews.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={p.base + "/"}>
                    <code>{p.id}</code>
                  </a>
                </td>
                <td>
                  {p.bundles.length === 0 ? (
                    <em className="ext-inv-muted">none</em>
                  ) : (
                    p.bundles.map((b) => (
                      <span key={`${b.module}-${b.version}`}>
                        <code>
                          {b.module} {b.version}
                        </code>{" "}
                      </span>
                    ))
                  )}
                </td>
                <td>{fmtDate(p.updated_at)}</td>
                <td>{fmtDate(p.expires_at)}</td>
                <td>
                  <button
                    className="ext-inv-drop ext-inv-btn--small"
                    type="button"
                    onClick={() => void drop(p)}
                    disabled={busy}
                  >
                    Drop
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
