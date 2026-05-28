import { useState } from "react";

export interface ExternalProject {
  name: string;
  base_url: string;
  version: string | null;
  fetched_at: number | null;
  objects: number;
}

interface Props {
  initial: ExternalProject[];
}

interface LoadResponse {
  ok: boolean;
  project?: string;
  version?: string;
  count?: number;
  error?: string;
}

function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export default function ExternalInventoryPanel({ initial }: Props) {
  const [projects, setProjects] = useState<ExternalProject[]>(initial);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [unloading, setUnloading] = useState<string | null>(null);
  const [dropping, setDropping] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const locked = busy !== null || unloading !== null || dropping !== null || registering;

  const load = async (projName: string, projBase: string) => {
    setBusy(projName);
    setResult(null);
    try {
      const resp = await fetch("/api/admin/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projName, base_url: projBase }),
      });
      const body = (await resp.json()) as LoadResponse;
      if (!resp.ok || !body.ok) {
        setResult({ ok: false, msg: `${projName}: ${body.error ?? `HTTP ${resp.status}`}` });
      } else {
        setResult({
          ok: true,
          msg: `${projName}: loaded ${body.count ?? 0} objects (version ${body.version || "?"}).`,
        });
        setProjects((prev) => {
          const row: ExternalProject = {
            name: projName,
            base_url: projBase,
            version: body.version ?? null,
            fetched_at: Date.now(),
            objects: body.count ?? 0,
          };
          const idx = prev.findIndex((p) => p.name === projName);
          if (idx === -1) return [...prev, row].sort((a, b) => a.name.localeCompare(b.name));
          const next = prev.slice();
          next[idx] = row;
          return next;
        });
      }
    } catch (err) {
      setResult({ ok: false, msg: `${projName}: network error: ${err}` });
    }
    setBusy(null);
  };

  // Stage a (name, base_url) pair without fetching. The pair is remembered so
  // it can be loaded / reloaded / dropped from the table without re-typing.
  const register = async (projName: string, projBase: string) => {
    setRegistering(true);
    setResult(null);
    try {
      const resp = await fetch("/api/admin/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projName, base_url: projBase, register_only: true }),
      });
      const body = (await resp.json()) as { ok: boolean; error?: string };
      if (!resp.ok || !body.ok) {
        setResult({ ok: false, msg: `${projName}: ${body.error ?? `HTTP ${resp.status}`}` });
      } else {
        setResult({ ok: true, msg: `${projName}: added — click Load to fetch objects.` });
        setProjects((prev) => {
          const idx = prev.findIndex((p) => p.name === projName);
          if (idx === -1) {
            const row: ExternalProject = {
              name: projName,
              base_url: projBase,
              version: null,
              fetched_at: null,
              objects: 0,
            };
            return [...prev, row].sort((a, b) => a.name.localeCompare(b.name));
          }
          // Existing entry: just update the URL, keep any loaded objects/version.
          const next = prev.slice();
          next[idx] = { ...next[idx]!, base_url: projBase };
          return next;
        });
      }
    } catch (err) {
      setResult({ ok: false, msg: `${projName}: network error: ${err}` });
    }
    setRegistering(false);
  };

  // Clear a project's objects but keep the (name, base_url) row for easy
  // re-load. Resets it to the "staged, not loaded" state.
  const unload = async (projName: string) => {
    setUnloading(projName);
    setResult(null);
    try {
      const resp = await fetch("/api/admin/inventory", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projName, objects_only: true }),
      });
      const body = (await resp.json()) as { ok: boolean; error?: string };
      if (!resp.ok || !body.ok) {
        setResult({ ok: false, msg: `${projName}: ${body.error ?? `HTTP ${resp.status}`}` });
      } else {
        setResult({ ok: true, msg: `${projName}: unloaded — pair kept, click Load to re-fetch.` });
        setProjects((prev) =>
          prev.map((p) =>
            p.name === projName ? { ...p, version: null, fetched_at: null, objects: 0 } : p
          )
        );
      }
    } catch (err) {
      setResult({ ok: false, msg: `${projName}: network error: ${err}` });
    }
    setUnloading(null);
  };

  const drop = async (projName: string) => {
    const ok = window.confirm(
      `Drop external inventory "${projName}"? Cross-package links into it will stop resolving.`
    );
    if (!ok) return;
    setDropping(projName);
    setResult(null);
    try {
      const resp = await fetch("/api/admin/inventory", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projName }),
      });
      const body = (await resp.json()) as { ok: boolean; error?: string };
      if (!resp.ok || !body.ok) {
        setResult({ ok: false, msg: `${projName}: ${body.error ?? `HTTP ${resp.status}`}` });
      } else {
        setResult({ ok: true, msg: `${projName}: dropped.` });
        setProjects((prev) => prev.filter((p) => p.name !== projName));
      }
    } catch (err) {
      setResult({ ok: false, msg: `${projName}: network error: ${err}` });
    }
    setDropping(null);
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const n = name.trim();
    const b = baseUrl.trim();
    if (!n || !b) return;
    void register(n, b).then(() => {
      setName("");
      setBaseUrl("");
    });
  };

  return (
    <div className="ext-inv">
      <p className="ext-inv-desc">
        Register a project that does <em>not</em> publish a papyri bundle (numpy, the Python stdlib,
        …) so cross-package references resolve to its Sphinx docs. The base URL is the doc root;{" "}
        <code>objects.inv</code> is fetched from <code>&lt;base&gt;/objects.inv</code>.{" "}
        <strong>Add</strong> stages the project; <strong>Load</strong> then fetches its inventory.
        The pair is remembered, so you can re-load or drop it without re-typing the URL.
      </p>

      <form className="ext-inv-form" onSubmit={onSubmit}>
        <label>
          Project name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="numpy"
            required
          />
        </label>
        <label>
          Base URL (objects.inv root)
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://numpy.org/doc/stable/"
            required
          />
        </label>
        <button className="ext-inv-btn" type="submit" disabled={locked}>
          {registering ? "Adding…" : "Add"}
        </button>
      </form>

      {result && (
        <div className={`ext-inv-result ext-inv-result--${result.ok ? "ok" : "error"}`}>
          {result.msg}
        </div>
      )}

      {projects.length === 0 ? (
        <p className="ext-inv-empty">No external inventories registered yet.</p>
      ) : (
        <table className="ext-inv-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Base URL</th>
              <th>Version</th>
              <th>Objects</th>
              <th>Fetched</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.name}>
                <td>
                  <code>{p.name}</code>
                </td>
                <td className="ext-inv-url">{p.base_url}</td>
                <td>{p.version || "—"}</td>
                <td className="ext-inv-num">{p.objects.toLocaleString()}</td>
                <td>{fmtDate(p.fetched_at)}</td>
                <td className="ext-inv-actions">
                  <button
                    className="ext-inv-reload"
                    type="button"
                    disabled={locked}
                    onClick={() => void load(p.name, p.base_url)}
                  >
                    {busy === p.name
                      ? p.fetched_at
                        ? "Reloading…"
                        : "Loading…"
                      : p.fetched_at
                        ? "Reload"
                        : "Load"}
                  </button>
                  {p.fetched_at ? (
                    <button
                      className="ext-inv-unload"
                      type="button"
                      disabled={locked}
                      onClick={() => void unload(p.name)}
                    >
                      {unloading === p.name ? "Unloading…" : "Unload"}
                    </button>
                  ) : null}
                  <button
                    className="ext-inv-drop"
                    type="button"
                    disabled={locked}
                    onClick={() => void drop(p.name)}
                  >
                    {dropping === p.name ? "Dropping…" : "Drop"}
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
