import { homedir } from "node:os";
import { join } from "node:path";

export function ingestDb(): string {
  return process.env.PAPYRI_INGEST_DB ?? join(homedir(), ".papyri", "ingest", "papyri.db");
}

/**
 * Returns true if `s` is a safe path segment (alphanumeric start, allows
 * `.`, `-`, `_`). Used to validate pkg/version values read from meta.cbor
 * before constructing filesystem paths.
 */
export function isSafeSegment(s: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s);
}
