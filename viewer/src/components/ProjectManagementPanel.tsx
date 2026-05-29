import { useState } from "react";

export interface PanelMember {
  id: number;
  username: string;
  is_admin: boolean;
  created_at: number;
}

export interface PanelProject {
  id: number;
  name: string;
  created_at: number;
  members: PanelMember[];
}

interface Props {
  initialProjects: PanelProject[];
  users: PanelMember[];
}

function fmtDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

export default function ProjectManagementPanel({ initialProjects, users }: Props) {
  const [projects, setProjects] = useState<PanelProject[]>(initialProjects);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // Per-project "add member" selection.
  const [selected, setSelected] = useState<Record<number, number>>({});

  const sortProjects = (list: PanelProject[]) =>
    [...list].sort((a, b) => a.name.localeCompare(b.name));

  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setCreating(true);
    setResult(null);
    try {
      const resp = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      const body = (await resp.json()) as { ok: boolean; project?: PanelProject; error?: string };
      if (!resp.ok || !body.ok || !body.project) {
        setResult({ ok: false, msg: body.error ?? `HTTP ${resp.status}` });
      } else {
        setResult({ ok: true, msg: `Created project "${n}".` });
        const created = body.project;
        setProjects((prev) => sortProjects([...prev, created]));
        setName("");
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setCreating(false);
  };

  const remove = async (project: PanelProject) => {
    const ok = window.confirm(
      `Delete project "${project.name}"? All member assignments are removed. ` +
        `Already-uploaded bundles are untouched.`
    );
    if (!ok) return;
    setBusy(true);
    setResult(null);
    try {
      const resp = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: project.id }),
      });
      const body = (await resp.json()) as { ok: boolean; error?: string };
      if (!resp.ok || !body.ok) {
        setResult({ ok: false, msg: `${project.name}: ${body.error ?? `HTTP ${resp.status}`}` });
      } else {
        setResult({ ok: true, msg: `Deleted project "${project.name}".` });
        setProjects((prev) => prev.filter((p) => p.id !== project.id));
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setBusy(false);
  };

  const updateMembers = async (
    method: "POST" | "DELETE",
    projectId: number,
    userId: number,
    label: string
  ) => {
    setBusy(true);
    setResult(null);
    try {
      const resp = await fetch("/api/projects/members", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, userId }),
      });
      const body = (await resp.json()) as {
        ok: boolean;
        members?: PanelMember[];
        error?: string;
      };
      if (!resp.ok || !body.ok || !body.members) {
        setResult({ ok: false, msg: body.error ?? `HTTP ${resp.status}` });
      } else {
        const members = body.members;
        setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, members } : p)));
        setResult({ ok: true, msg: label });
      }
    } catch (err) {
      setResult({ ok: false, msg: `network error: ${err}` });
    }
    setBusy(false);
  };

  return (
    <div className="ext-inv">
      <p className="ext-inv-desc">
        A project is a package name (e.g. <code>numpy</code>). Assigning a user to a project lets
        them upload that package&apos;s documentation with one of their personal upload tokens
        (admins may upload any project). Deleting a project only removes assignments — it never
        deletes already-ingested bundles.
      </p>

      <form className="ext-inv-form" onSubmit={create}>
        <label>
          Project (package) name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="numpy"
            required
          />
        </label>
        <button className="ext-inv-btn" type="submit" disabled={creating || busy}>
          {creating ? "Creating…" : "Add project"}
        </button>
      </form>

      {result && (
        <div className={`ext-inv-result ext-inv-result--${result.ok ? "ok" : "error"}`}>
          {result.msg}
        </div>
      )}

      {projects.length === 0 ? (
        <p className="ext-inv-empty">No projects yet.</p>
      ) : (
        <table className="ext-inv-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Created</th>
              <th>Members</th>
              <th>Assign</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const memberIds = new Set(p.members.map((m) => m.id));
              const candidates = users.filter((u) => !memberIds.has(u.id));
              const pick = selected[p.id] ?? candidates[0]?.id ?? 0;
              return (
                <tr key={p.id}>
                  <td>
                    <code>{p.name}</code>
                  </td>
                  <td>{fmtDate(p.created_at)}</td>
                  <td>
                    {p.members.length === 0 ? (
                      <em className="ext-inv-muted">none</em>
                    ) : (
                      <ul className="proj-member-list">
                        {p.members.map((m) => (
                          <li key={m.id}>
                            <code>{m.username}</code>
                            {m.is_admin && <span className="ext-inv-badge">admin</span>}
                            <button
                              className="ext-inv-drop ext-inv-btn--small"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void updateMembers(
                                  "DELETE",
                                  p.id,
                                  m.id,
                                  `Removed "${m.username}" from "${p.name}".`
                                )
                              }
                            >
                              remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>
                    {candidates.length === 0 ? (
                      <em className="ext-inv-muted">all assigned</em>
                    ) : (
                      <div className="proj-assign">
                        <select
                          value={pick}
                          disabled={busy}
                          onChange={(e) =>
                            setSelected((prev) => ({ ...prev, [p.id]: Number(e.target.value) }))
                          }
                        >
                          {candidates.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.username}
                            </option>
                          ))}
                        </select>
                        <button
                          className="ext-inv-btn ext-inv-btn--small"
                          type="button"
                          disabled={busy || !pick}
                          onClick={() => {
                            const u = candidates.find((c) => c.id === pick);
                            if (!u) return;
                            void updateMembers(
                              "POST",
                              p.id,
                              u.id,
                              `Assigned "${u.username}" to "${p.name}".`
                            );
                          }}
                        >
                          Add
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="ext-inv-actions">
                    <button
                      className="ext-inv-drop"
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(p)}
                    >
                      Delete
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
