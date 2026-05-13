// localStorage-backed store for recent search queries.
//
// Queries are stored newest-first. The store is capped at MAX_ENTRIES so it
// stays small. Every function is a no-op when localStorage is unavailable
// (SSR, private-browsing restrictions, etc.).

const STORAGE_KEY = "papyri:recent-searches";
const MAX_ENTRIES = 10;

function safeRead(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function safeWrite(entries: string[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota exceeded or other storage error — silently ignore
  }
}

/** Returns up to MAX_ENTRIES recent queries, newest first. */
export function getRecentSearches(): string[] {
  return safeRead();
}

/**
 * Prepends `query` to the list, removing any prior duplicate, and trims to
 * MAX_ENTRIES. Whitespace-only queries are ignored.
 */
export function addRecentSearch(query: string): void {
  const q = query.trim();
  if (!q) return;
  const existing = safeRead().filter((s) => s !== q);
  safeWrite([q, ...existing].slice(0, MAX_ENTRIES));
}

/** Removes all stored recent searches. */
export function clearRecentSearches(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
