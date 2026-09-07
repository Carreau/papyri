import { useState } from "react";

/** Row shape returned by `/api/oidc/publishers`. */
export interface PanelPublisher {
  id: number;
  project_name: string;
  repository: string;
  workflow_ref: string;
  environment: string | null;
  repository_owner_id: string | null;
  created_at: number;
  last_used_at: number | null;
}

interface Props {
  initial: PanelPublisher[];
  /** Projects the viewer may register a publisher for. */
  projects: string[];
}

function fmtDate(epochSeconds: number | null): string {
  return epochSeconds ? new Date(epochSeconds * 1000).toLocaleString() : "never";
}

/**
 * Register the GitHub Actions workflows allowed to upload a project without a
 * token — papyri's equivalent of PyPI trusted publishing. The value over a
 * stored secret is that it works from a fork PR, where repository secrets are
 * unavailable.
 */
export default function TrustedPublisherPanel({ initial, projects }: Props) {
  const [publishers, setPublishers] = useState<PanelPublisher[]>(initial);
  const [project, setProject] = useState(projects[0] ?? "");
  const [repository, setRepository] = useState("");
  const [workflowRef, setWorkflowRef] = useState("");
  const [environment, setEnvironment] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const resp = await fetch("/api/oidc/publishers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          repository: repository.trim(),
          workflowRef: workflowRef.trim(),
          environment: environment.trim() || null,
        }),
      });
      const body = (await resp.json()) as {
        ok: boolean;
        publisher?: PanelPublisher;
        error?: string;
      };
      if (!resp.ok || !body.ok || !body.publisher) {
        setResult({ ok: false, msg: body.error ?? `HTTP ${resp.status}` });
      } else {
        const created = body.publisher;
        setPublishers((prev) => [...prev, created]);
        setResult({
          ok: true,
          msg: `${created.repository} may now publish ${created.project_name}.`,
        });
        setRepository("");
        setWorkflowRef("");
        setEnvironment("");
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setBusy(false);
  };

  const remove = async (pub: PanelPublisher) => {
    const ok = window.confirm(
      `Stop trusting ${pub.repository} (${pub.workflow_ref}) to publish ${pub.project_name}?`
    );
    if (!ok) return;
    setBusy(true);
    setResult(null);
    try {
      const resp = await fetch("/api/oidc/publishers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: pub.id }),
      });
      const body = (await resp.json()) as { ok: boolean; error?: string };
      if (!resp.ok || !body.ok) {
        setResult({ ok: false, msg: body.error ?? `HTTP ${resp.status}` });
      } else {
        setPublishers((prev) => prev.filter((p) => p.id !== pub.id));
        setResult({ ok: true, msg: `Removed ${pub.repository} (${pub.workflow_ref}).` });
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setBusy(false);
  };

  return (
    <div className="ext-inv">
      <p className="ext-inv-desc">
        A trusted publisher lets one GitHub Actions workflow upload a project with no stored token:
        the workflow asks GitHub for a short-lived OIDC token and papyri verifies GitHub&apos;s
        signature. Unlike a secret, this works in workflows triggered by fork pull requests. The
        workflow file must live in the repository itself, and the job needs
        <code> permissions: id-token: write</code>.
      </p>

      {projects.length === 0 ? (
        <p className="ext-inv-empty">
          You are not a member of any project yet — ask an admin to assign you one.
        </p>
      ) : (
        <form className="ext-inv-form" onSubmit={add}>
          <label>
            Project
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            Repository
            <input
              type="text"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              placeholder="numpy/numpy"
              required
            />
          </label>
          <label>
            Workflow file
            <input
              type="text"
              value={workflowRef}
              onChange={(e) => setWorkflowRef(e.target.value)}
              placeholder="docs.yml"
              required
            />
          </label>
          <label>
            Environment (optional)
            <input
              type="text"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
              placeholder="docs"
            />
          </label>
          <button className="ext-inv-btn" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Add publisher"}
          </button>
        </form>
      )}

      {result && (
        <div className={`ext-inv-result ext-inv-result--${result.ok ? "ok" : "error"}`}>
          {result.msg}
        </div>
      )}

      {publishers.length === 0 ? (
        <p className="ext-inv-empty">No trusted publishers yet.</p>
      ) : (
        <table className="ext-inv-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Repository</th>
              <th>Workflow</th>
              <th>Environment</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {publishers.map((pub) => (
              <tr key={pub.id}>
                <td>
                  <code>{pub.project_name}</code>
                </td>
                <td>
                  <code>{pub.repository}</code>
                </td>
                <td>
                  <code>{pub.workflow_ref}</code>
                </td>
                <td>
                  {pub.environment ? (
                    <code>{pub.environment}</code>
                  ) : (
                    <em className="ext-inv-muted">any</em>
                  )}
                </td>
                <td>{fmtDate(pub.last_used_at)}</td>
                <td className="ext-inv-actions">
                  <button
                    className="ext-inv-drop"
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(pub)}
                  >
                    Remove
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
