import { useState, useRef } from "react";

interface RawEntry {
  pkg: string;
  ver: string;
}

interface ProgressEvent {
  event: string;
  pkg?: string;
  ver?: string;
  version?: string;
  phase?: string;
  done?: number;
  total?: number;
  n?: number;
  of?: number;
  count?: number;
  message?: string;
  error?: string;
  elapsed_s?: string;
}

interface BundleProgress {
  pkg: string;
  ver: string;
  status: "pending" | "active" | "done" | "warning";
  phase?: string;
  done?: number;
  total?: number;
  message?: string;
}

interface Props {
  entries: RawEntry[];
}

function progressPercent(p: BundleProgress): number {
  if (p.status === "done") return 100;
  if (p.done != null && p.total != null && p.total > 0) {
    return Math.round((p.done / p.total) * 100);
  }
  return 0;
}

export default function ReingestPanel({ entries }: Props) {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<ProgressEvent[]>([]);
  const [bundleMap, setBundleMap] = useState<Map<string, BundleProgress>>(new Map());
  const [summary, setSummary] = useState<string | null>(null);
  const [filterPkg, setFilterPkg] = useState<string>("");
  const [filterVer, setFilterVer] = useState<string>("");
  const logRef = useRef<HTMLDivElement>(null);

  const uniquePkgs = Array.from(new Set(entries.map((e) => e.pkg))).sort();

  const startReingest = async () => {
    setRunning(true);
    setLog([]);
    setSummary(null);
    const initial = new Map<string, BundleProgress>();
    const scope = entries.filter(
      (e) => (!filterPkg || e.pkg === filterPkg) && (!filterVer || e.ver === filterVer)
    );
    for (const e of scope) {
      initial.set(`${e.pkg}@${e.ver}`, {
        pkg: e.pkg,
        ver: e.ver,
        status: "pending",
      });
    }
    setBundleMap(initial);

    const params = new URLSearchParams();
    if (filterPkg) params.set("pkg", filterPkg);
    if (filterVer) params.set("ver", filterVer);
    const url = `/api/reingest${params.size ? "?" + params.toString() : ""}`;

    try {
      const resp = await fetch(url, { method: "POST" });
      if (!resp.ok || !resp.body) {
        const text = await resp.text();
        setSummary(`Error ${resp.status}: ${text}`);
        setRunning(false);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: ProgressEvent;
          try {
            ev = JSON.parse(line) as ProgressEvent;
          } catch {
            continue;
          }
          setLog((prev) => [...prev, ev]);
          setBundleMap((prev) => {
            const next = new Map(prev);
            const key = ev.pkg ? `${ev.pkg}@${ev.ver ?? ""}` : null;
            if (key && next.has(key)) {
              const entry = { ...next.get(key)! };
              if (ev.event === "progress") {
                entry.status = "active";
                entry.phase = ev.phase;
                entry.done = ev.done;
                entry.total = ev.total;
              } else if (ev.event === "ingested") {
                entry.status = "done";
                entry.done = entry.total;
              } else if (ev.event === "warning") {
                entry.status = "warning";
                entry.message = ev.message;
              }
              next.set(key, entry);
            }
            return next;
          });
          if (ev.event === "done") {
            setSummary(`Done: ${ev.count ?? 0} of ${ev.total ?? 0} bundle(s) re-ingested.`);
          } else if (ev.event === "error") {
            setSummary(`Error: ${ev.error}`);
          }
          // Scroll log to bottom
          setTimeout(() => {
            if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
          }, 0);
        }
      }
    } catch (err) {
      setSummary(`Network error: ${err}`);
    }
    setRunning(false);
  };

  const bundles = Array.from(bundleMap.values());
  const visibleEntries = entries.filter(
    (e) => (!filterPkg || e.pkg === filterPkg) && (!filterVer || e.ver === filterVer)
  );

  return (
    <div className="reingest-panel">
      <section className="reingest-controls">
        <h2>Re-ingest bundles</h2>
        <p className="reingest-desc">
          Re-plays raw archived bundles through the ingest pipeline. Use this after a schema change
          or to recover a corrupted processed store.
        </p>
        <div className="reingest-filters">
          <label>
            Package
            <select
              value={filterPkg}
              onChange={(e) => {
                setFilterPkg(e.target.value);
                setFilterVer("");
              }}
              disabled={running}
            >
              <option value="">— all —</option>
              {uniquePkgs.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          {filterPkg && (
            <label>
              Version
              <select
                value={filterVer}
                onChange={(e) => setFilterVer(e.target.value)}
                disabled={running}
              >
                <option value="">— all versions —</option>
                {entries
                  .filter((e) => e.pkg === filterPkg)
                  .map((e) => (
                    <option key={e.ver} value={e.ver}>
                      {e.ver}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <button
            className="reingest-btn"
            onClick={startReingest}
            disabled={running || entries.length === 0}
          >
            {running ? "Re-ingesting…" : `Re-ingest ${visibleEntries.length} bundle(s)`}
          </button>
        </div>
      </section>

      {bundles.length > 0 && (
        <section className="reingest-progress">
          <h3>Progress</h3>
          <ul className="reingest-bundle-list">
            {bundles.map((b) => {
              const pct = progressPercent(b);
              return (
                <li
                  key={`${b.pkg}@${b.ver}`}
                  className={`reingest-bundle reingest-bundle--${b.status}`}
                >
                  <div className="reingest-bundle-header">
                    <span className="reingest-bundle-name">
                      {b.pkg} <span className="reingest-bundle-ver">{b.ver}</span>
                    </span>
                    <span className="reingest-bundle-status">
                      {b.status === "pending" && "waiting"}
                      {b.status === "active" && (b.phase ?? "ingesting…")}
                      {b.status === "done" && "✓ done"}
                      {b.status === "warning" && "⚠ warning"}
                    </span>
                  </div>
                  {b.status !== "pending" && (
                    <div className="reingest-bar-wrap">
                      <div className="reingest-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                  {b.message && <div className="reingest-bundle-msg">{b.message}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {summary && (
        <div
          className={`reingest-summary ${summary.startsWith("Error") ? "reingest-summary--error" : "reingest-summary--ok"}`}
        >
          {summary}
        </div>
      )}

      {log.length > 0 && (
        <details className="reingest-log-details">
          <summary>Raw event log ({log.length} events)</summary>
          <div className="reingest-log" ref={logRef}>
            {log.map((ev, i) => (
              <div key={i} className={`reingest-log-line reingest-log--${ev.event}`}>
                {JSON.stringify(ev)}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
