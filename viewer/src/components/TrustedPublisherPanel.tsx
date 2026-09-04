import { useState } from "react";

/** One `(project, repository, workflow)` trust entry, as the API returns it. */
export interface PanelPublisher {
  id: number;
  project: string;
  repository: string;
  workflow: string;
  created_at: number;
}

interface Props {
  initialPublishers: PanelPublisher[];
  projects: string[];
}

function fmtDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

/**
 * Admin panel: which GitHub repositories may publish PR doc previews for a
 * project using an Actions OIDC token (trusted publishing — no shared secret,
 * so it works from fork pull requests).
 */
export default function TrustedPublisherPanel({ initialPublishers, projects }: Props) {
  const [publishers, setPublishers] = useState<PanelPublisher[]>(initialPublishers);
  const [project, setProject] = useState(projects[0] ?? "");
  const [repository, setRepository] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const send = async (method: "POST" | "DELETE", body: unknown, okMsg: string) => {
    setBusy(true);
    setResult(null);
    try {
      const resp = await fetch("/api/projects/publishers", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = (await resp.json()) as {
        ok: boolean;
        publishers?: PanelPublisher[];
        error?: string;
      };
      if (!resp.ok || !parsed.ok || !parsed.publishers) {
        setResult({ ok: false, msg: parsed.error ?? `HTTP ${resp.status}` });
      } else {
        setPublishers(parsed.publishers);
        setResult({ ok: true, msg: okMsg });
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setBusy(false);
  };

  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const repo = repository.trim();
    if (!project || !repo) return;
    await send(
      "POST",
      { project, repository: repo, workflow: workflow.trim() },
      `${repo} may now publish previews for ${project}.`
    );
    setRepository("");
    setWorkflow("");
  };

  const remove = async (p: PanelPublisher) => {
    if (!window.confirm(`Stop trusting ${p.repository} to publish previews for ${p.project}?`)) {
      return;
    }
    await send("DELETE", { id: p.id }, `Removed ${p.repository} → ${p.project}.`);
  };

  return (
    <div className="ext-inv">
      <p className="ext-inv-desc">
        A trusted publisher lets a GitHub workflow upload PR doc previews with a short-lived OpenID
        Connect token instead of a shared secret, so previews work on pull requests from forks.
        Leave the workflow field empty to trust any workflow in the repository.
      </p>

      <form className="ext-inv-form" onSubmit={(e) => void add(e)}>
        <select
          value={project}
          onChange={(e) => setProject(e.currentTarget.value)}
          aria-label="Project"
          disabled={projects.length === 0}
        >
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={repository}
          onChange={(e) => setRepository(e.currentTarget.value)}
          placeholder="owner/repo"
          aria-label="GitHub repository"
        />
        <input
          type="text"
          value={workflow}
          onChange={(e) => setWorkflow(e.currentTarget.value)}
          placeholder=".github/workflows/docs.yml (optional)"
          aria-label="Workflow file"
          size={38}
        />
        <button
          className="ext-inv-btn"
          type="submit"
          disabled={busy || projects.length === 0 || !repository.trim()}
        >
          Trust repository
        </button>
      </form>

      {projects.length === 0 && (
        <p className="ext-inv-desc">Create a project first — a publisher always maps to one.</p>
      )}

      {result && (
        <div className={`ext-inv-result ext-inv-result--${result.ok ? "ok" : "error"}`}>
          {result.msg}
        </div>
      )}

      {publishers.length === 0 ? (
        <p className="ext-inv-desc">No trusted publishers yet.</p>
      ) : (
        <table className="ext-inv-table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Project</th>
              <th>Workflow</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {publishers.map((p) => (
              <tr key={p.id}>
                <td>
                  <code>{p.repository}</code>
                </td>
                <td>{p.project}</td>
                <td>{p.workflow === "" ? <em>any</em> : <code>{p.workflow}</code>}</td>
                <td>{fmtDate(p.created_at)}</td>
                <td>
                  <button
                    className="ext-inv-drop ext-inv-btn--small"
                    type="button"
                    onClick={() => void remove(p)}
                    disabled={busy}
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
