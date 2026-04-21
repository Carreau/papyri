// Client island: checkbox filter for node type listing pages.
// Reads elements with data-nodetype attribute inside a container and
// shows/hides them based on which checkboxes are checked.
//
// Usage:
//   <NodeTypeFilter client:load listId="node-list" types={[...]} />
//
// Each filterable element must have:
//   data-nodetype="{__type value}"

import { useEffect, useRef, useState } from "react";

interface TypeOption {
  key: string;
  label: string;
  count: number;
}

interface Props {
  listId: string;
  types: TypeOption[];
  defaultChecked?: boolean;
}

export default function NodeTypeFilter({ listId, types, defaultChecked = true }: Props) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(types.map((t) => [t.key, defaultChecked]))
  );
  const prevChecked = useRef(checked);

  useEffect(() => {
    const list = document.getElementById(listId);
    if (!list) return;
    const entries = list.querySelectorAll<HTMLElement>("[data-nodetype]");
    for (const el of entries) {
      const t = el.dataset.nodetype ?? "";
      el.hidden = !(checked[t] ?? true);
    }
    prevChecked.current = checked;
  }, [listId, checked]);

  function toggle(key: string) {
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function setAll(value: boolean) {
    setChecked(Object.fromEntries(types.map((t) => [t.key, value])));
  }

  const allOn = types.every((t) => checked[t.key]);
  const allOff = types.every((t) => !checked[t.key]);

  return (
    <div className="nt-filter">
      <div className="nt-filter-heading">
        <span>Node types</span>
        <span className="nt-filter-actions">
          <button
            className="nt-filter-btn"
            onClick={() => setAll(true)}
            disabled={allOn}
            aria-label="Select all"
          >
            all
          </button>
          <button
            className="nt-filter-btn"
            onClick={() => setAll(false)}
            disabled={allOff}
            aria-label="Deselect all"
          >
            none
          </button>
        </span>
      </div>
      <ul className="nt-filter-list">
        {types.map((t) => (
          <li key={t.key}>
            <label className="nt-filter-label">
              <input
                type="checkbox"
                checked={checked[t.key] ?? true}
                onChange={() => toggle(t.key)}
              />
              <span className="nt-filter-name">{t.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
