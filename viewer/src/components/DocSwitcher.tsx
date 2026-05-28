import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
  type ReactElement,
} from "react";

export interface VersionEntry {
  v: string;
  group: string; // BLAKE2b hex digest — same value = identical content
}

interface VersionGroup {
  group: string;
  items: VersionEntry[];
}

interface Props {
  versions: VersionEntry[]; // ordered oldest → newest
  current: string;
  hrefs: Record<string, string>; // v → page URL
}

function buildGroups(versions: VersionEntry[]): VersionGroup[] {
  const groups: VersionGroup[] = [];
  for (const item of versions) {
    const last = groups[groups.length - 1];
    if (last && last.group === item.group) last.items.push(item);
    else groups.push({ group: item.group, items: [item] });
  }
  return groups;
}

function versionRangeLabel(items: VersionEntry[]): string {
  if (items.length === 1) return `v${items[0]!.v}`;
  return `v${items[0]!.v} – v${items[items.length - 1]!.v}`;
}

export default function DocSwitcher({ versions, current, hrefs }: Props): ReactElement | null {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // All hooks must be called unconditionally before any early return.

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        panelRef.current?.contains(e.target as Node)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus the current-version row (or first row) when panel opens
  useEffect(() => {
    if (!open) return;
    const currentOpt = panelRef.current?.querySelector<HTMLElement>("[aria-current=true]");
    const firstOpt = panelRef.current?.querySelector<HTMLElement>("[role=option]");
    (currentOpt ?? firstOpt)?.focus();
  }, [open]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        e.preventDefault();
        return;
      }
      if (!open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      const opts = [...(panelRef.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
      const idx = opts.indexOf(document.activeElement as HTMLElement);
      if (e.key === "ArrowDown") opts[Math.min(idx + 1, opts.length - 1)]?.focus();
      else opts[Math.max(idx - 1, 0)]?.focus();
      e.preventDefault();
    },
    [open]
  );

  // Early exit after all hooks — nothing to show for a single version.
  const currentEntry = versions.find((x) => x.v === current);
  if (!currentEntry || versions.length <= 1) return null;

  const groups = buildGroups(versions);
  const currentGroup = currentEntry.group;
  const isLatest = versions[versions.length - 1]!.v === current;
  const sameGroup = versions.filter((x) => x.group === currentGroup);
  const first = sameGroup[0]!;
  const last = sameGroup[sameGroup.length - 1]!;
  const hasLeft = first.v !== current;
  const hasRight = last.v !== current;
  const currentIdx = versions.findIndex((x) => x.v === current);
  const firstIdx = versions.findIndex((x) => x.v === first.v);
  const lastIdx = versions.findIndex((x) => x.v === last.v);
  const leftAdjacent = currentIdx - firstIdx === 1;
  const rightAdjacent = lastIdx - currentIdx === 1;

  return (
    <div className="ds-switcher" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="ds-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ds-range-label">
          {hasLeft && (
            <>
              <span className="ds-edge">v{first.v}</span>
              <span className="ds-sep">{leftAdjacent ? "–" : "…"}</span>
            </>
          )}
          <span className="ds-cur">v{current}</span>
          {hasRight && (
            <>
              <span className="ds-sep">{rightAdjacent ? "–" : "…"}</span>
              <span className="ds-edge">v{last.v}</span>
            </>
          )}
          {isLatest && <span className="ds-onward">&nbsp;and onward</span>}
        </span>
        <span className="ds-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div ref={panelRef} className="ds-panel" role="listbox">
          {[...groups].reverse().map((g) => {
            const isCurrent = g.group === currentGroup;
            const isLatestGroup =
              g.items[g.items.length - 1]!.v === versions[versions.length - 1]!.v;
            return (
              <div key={g.group} className={`ds-group${isCurrent ? " ds-group--current" : ""}`}>
                {g.items.length > 1 && (
                  <div className="ds-group-head" aria-hidden="true">
                    <span className="ds-dot" />
                    <span>
                      {versionRangeLabel(g.items)}
                      {isLatestGroup ? " – onward" : ""}
                      {isCurrent ? " · identical to current" : ""}
                    </span>
                  </div>
                )}
                {[...g.items].reverse().map((item) => {
                  const isCur = item.v === current;
                  return (
                    <a
                      key={item.v}
                      role="option"
                      aria-current={isCur ? "true" : undefined}
                      aria-selected={isCur}
                      className={`ds-opt${isCur ? " ds-opt--current" : ""}`}
                      href={hrefs[item.v] ?? "#"}
                      tabIndex={0}
                      onClick={() => setOpen(false)}
                    >
                      <span className="ds-v">v{item.v}</span>
                      {isCur && <span className="ds-badge">current</span>}
                    </a>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
