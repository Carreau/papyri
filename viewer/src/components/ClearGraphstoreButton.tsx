import { useState } from "react";

interface Props {
  rawCount: number;
}

export default function ClearGraphstoreButton({ rawCount }: Props) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const onClick = async () => {
    const ok = window.confirm(
      `Drop every row from the graph DB and delete every processed blob? The raw archive (${rawCount} bundle${rawCount === 1 ? "" : "s"}) will be kept so you can re-ingest.`
    );
    if (!ok) return;
    setRunning(true);
    setResult(null);
    try {
      const resp = await fetch("/api/admin/clear", { method: "POST" });
      const body = (await resp.json()) as {
        ok: boolean;
        deletedBlobs?: number;
        error?: string;
        elapsed_s?: string;
      };
      if (!resp.ok || !body.ok) {
        setResult(`Error: ${body.error ?? `HTTP ${resp.status}`}`);
      } else {
        setResult(
          `Cleared. Deleted ${body.deletedBlobs ?? 0} blob entries in ${body.elapsed_s ?? "?"}s. Reload to refresh stats.`
        );
      }
    } catch (err) {
      setResult(`Network error: ${err}`);
    }
    setRunning(false);
  };

  return (
    <div className="clear-graphstore">
      <button className="clear-graphstore-btn" onClick={onClick} disabled={running} type="button">
        {running ? "Clearing…" : "Clear graphstore (keep raw archive)"}
      </button>
      <p className="clear-graphstore-desc">
        Empties <code>nodes</code>, <code>links</code>, and <code>bundles</code> tables and removes
        processed blobs. The raw archive is preserved so you can re-ingest immediately.
      </p>
      {result && (
        <div
          className={`clear-graphstore-result ${result.startsWith("Error") || result.startsWith("Network") ? "clear-graphstore-result--error" : "clear-graphstore-result--ok"}`}
        >
          {result}
        </div>
      )}
    </div>
  );
}
