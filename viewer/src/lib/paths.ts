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
