import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Absolute path to the bundle data root (blob store + raw archive).
 * Override with PAPYRI_INGEST_DIR.
 */
export function ingestDir(): string {
  return process.env.PAPYRI_INGEST_DIR ?? join(homedir(), ".papyri", "ingest");
}

/**
 * Absolute path to the SQLite graph DB used by the Node/local backend.
 * Override with PAPYRI_INGEST_DB for testing or custom installations;
 * otherwise it sits inside `ingestDir()`, so pointing PAPYRI_INGEST_DIR
 * somewhere else moves the DB with it.
 */
export function ingestDb(): string {
  return process.env.PAPYRI_INGEST_DB ?? join(ingestDir(), "papyri.db");
}

/**
 * Returns true if `s` is a safe path segment (alphanumeric start, allows
 * `.`, `-`, `_`, `+`). Used to validate pkg/version values read from
 * meta.cbor / Bundle nodes before constructing storage keys. `+` is needed
 * for PEP 440 local version identifiers (e.g.
 * `1.18.0.dev0+git20260420.763dbc8`).
 */
export function isSafeSegment(s: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._\-+]*$/.test(s);
}
