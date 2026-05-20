import { useState } from "react";

interface Props {
  rawCount: number;
}

export default function DropRawBundlesButton({ rawCount }: Props) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const onClick = async () => {
    const ok = window.confirm(
      `Permanently delete every raw bundle (${rawCount} bundle${rawCount === 1 ? "" : "s"}) from the archive? After this, re-ingest can no longer replay from local state and maintainers must re-upload.`
    );
    if (!ok) return;
    setRunning(true);
    setResult(null);
    try {
      const resp = await fetch("/api/clear-raw", { method: "POST" });
      const body = (await resp.json()) as {
        ok: boolean;
        deletedBundles?: number;
        error?: string;
        elapsed_s?: string;
      };
      if (!resp.ok || !body.ok) {
        setResult(`Error: ${body.error ?? `HTTP ${resp.status}`}`);
      } else {
        setResult(
          `Dropped ${body.deletedBundles ?? 0} raw bundle${body.deletedBundles === 1 ? "" : "s"} in ${body.elapsed_s ?? "?"}s. Reload to refresh.`
        );
      }
    } catch (err) {
      setResult(`Network error: ${err}`);
    }
    setRunning(false);
  };

  return (
    <div className="clear-graphstore">
      <button
        className="clear-graphstore-btn"
        onClick={onClick}
        disabled={running || rawCount === 0}
        type="button"
      >
        {running ? "Dropping…" : "Drop raw bundles"}
      </button>
      <p className="clear-graphstore-desc">
        Permanently deletes every <code>_raw/&lt;pkg&gt;/&lt;ver&gt;.papyri.gz</code> entry from the
        archive. The processed store is left as-is; clear it separately above. After this, re-ingest
        can no longer replay locally — maintainers must re-upload.
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
