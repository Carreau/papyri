/**
 * Shared helpers for the WebAuthn / passkey flows.
 *
 * The Relying Party ID (rpID) and expected origin are derived from the
 * canonical site URL (`PAPYRI_SITE` env var) when set, or from the incoming
 * request URL in development. This matches how browsers bind passkeys:
 * a credential registered against `example.com:4321` will not authenticate
 * against `example.com`, so both sides must agree on the same rpID + origin.
 */

export interface RpConfig {
  /** Relying Party ID — the effective domain (no port). */
  rpID: string;
  /** Full origin browsers present for verification. */
  expectedOrigin: string;
  /** Human-readable name shown in authenticator dialogs. */
  rpName: string;
}

export function getRpConfig(request: Request): RpConfig {
  const site = process.env.PAPYRI_SITE;
  if (site) {
    const url = new URL(site);
    return { rpID: url.hostname, expectedOrigin: url.origin, rpName: "Papyri Viewer" };
  }
  const url = new URL(request.url);
  return { rpID: url.hostname, expectedOrigin: url.origin, rpName: "Papyri Viewer" };
}

/** Public shape of a passkey credential sent to the browser. */
export interface PublicPasskeyCredential {
  id: number;
  name: string | null;
  backedUp: boolean;
  transports: string[] | null;
  created_at: number;
  last_used_at: number | null;
}
