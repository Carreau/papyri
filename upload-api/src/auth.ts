// Token validation. Tokens are stored as SHA-256 hashes in D1.
// Schema:
//   tokens(token_hash TEXT PK, name TEXT, created_at TEXT)
//   token_packages(token_hash TEXT FK, pkg TEXT, PRIMARY KEY (token_hash, pkg))
//
// A single token can authorize uploads for multiple packages (one user may
// maintain several projects). An operator creates tokens via `papyri token create`.

export interface Env {
  DB: D1Database;
  BUNDLE_STORE: R2Bucket;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string; // e.g. "carreau/papyri"
  GITHUB_INGEST_WORKFLOW: string; // e.g. "ingest.yml"
}

async function sha256Hex(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Return true iff the bearer token is authorised to upload for `pkg`.
 * The lookup is: token_hash matches AND that hash is associated with `pkg`.
 */
export async function validateToken(
  token: string,
  pkg: string,
  env: Env,
): Promise<boolean> {
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT 1 FROM tokens t " +
      "JOIN token_packages tp ON t.token_hash = tp.token_hash " +
      "WHERE t.token_hash = ? AND tp.pkg = ? LIMIT 1",
  )
    .bind(hash, pkg)
    .first();
  return row !== null;
}
