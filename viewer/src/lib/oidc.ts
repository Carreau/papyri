/**
 * GitHub Actions OIDC verification — trusted publishing for doc bundles.
 *
 * Fork pull requests cannot read repository secrets, so a bearer token can
 * never work for the most common contribution flow (and `pull_request_target`
 * is a known footgun). Instead a workflow asks GitHub for a short-lived,
 * workload-bound ID token (`id-token: write`) and sends *that* as the bearer.
 * We verify its signature against GitHub's published JWKS and read the
 * workload identity straight out of the claims:
 *
 *   repository       "numpy/numpy"          — who is uploading
 *   workflow_ref     "numpy/numpy/.github/workflows/docs.yml@refs/pull/42/merge"
 *   event_name       "pull_request"
 *   ref              "refs/pull/42/merge"   — which PR the preview belongs to
 *
 * The preview namespace is derived from those claims alone — never from
 * anything the client says — so a workflow can only ever write into the
 * preview of its own pull request.
 *
 * This follows PyPI's trusted-publisher model. Verification is done with
 * `node:crypto` rather than a JWT library: one issuer, one algorithm (RS256),
 * one small set of checks, and `createPublicKey` consumes GitHub's JWK
 * directly — a dependency would carry more surface than the ~80 lines here.
 */
import { createPublicKey, verify as cryptoVerify, timingSafeEqual } from "node:crypto";
import { makePreviewRef, type PreviewRef } from "./preview.ts";

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

/** Where GitHub publishes the signing keys for the tokens it mints. */
const JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;

/** How long a fetched key set is reused before being refreshed. */
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Floor between two JWKS fetches, so an unknown `kid` cannot be a DoS lever. */
const JWKS_MIN_REFETCH_MS = 60 * 1000;

/** Clock skew tolerated on `exp` / `nbf` / `iat`. */
const CLOCK_SKEW_S = 60;

/** Refuse absurd tokens before doing any work. */
const MAX_TOKEN_BYTES = 16 * 1024;

/** Claims we rely on. GitHub sends many more; the rest are ignored. */
export interface GithubOidcClaims {
  iss: string;
  aud: string;
  exp: number;
  /** `owner/repo`. */
  repository: string;
  repository_owner: string;
  /** `owner/repo/.github/workflows/x.yml@<ref>`. */
  workflow_ref: string;
  /** `pull_request`, `push`, … */
  event_name: string;
  /** `refs/pull/<n>/merge` for a pull_request run. */
  ref: string;
  sha?: string;
  actor?: string;
  run_id?: string;
}

/**
 * Audience the ID token must carry. Both ends default to the literal
 * "papyri"; a deployment that wants a distinct audience sets
 * `PAPYRI_OIDC_AUDIENCE` here and passes `--oidc-audience` (or
 * `PAPYRI_OIDC_AUDIENCE`) on the uploading side. The two must agree exactly,
 * which is why the default is a fixed string rather than something derived
 * from a URL that could differ by a trailing slash.
 */
export function expectedAudience(): string {
  return process.env.PAPYRI_OIDC_AUDIENCE || "papyri";
}

/** True when OIDC uploads are enabled for this deployment. */
export function oidcEnabled(): boolean {
  return process.env.PAPYRI_OIDC_DISABLED !== "1";
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
let lastFetchAttempt = 0;

async function fetchJwks(): Promise<Jwk[]> {
  const resp = await fetch(JWKS_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`JWKS fetch failed: HTTP ${resp.status}`);
  const body = (await resp.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error("JWKS response carried no keys");
  }
  return body.keys;
}

/**
 * Signing key for `kid`. Served from cache; a cache miss (GitHub rotates keys)
 * triggers at most one refetch per `JWKS_MIN_REFETCH_MS`.
 */
async function keyForKid(kid: string): Promise<Jwk | null> {
  const now = Date.now();
  const fresh = jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh) {
    const hit = jwksCache!.keys.find((k) => k.kid === kid);
    if (hit) return hit;
    if (now - lastFetchAttempt < JWKS_MIN_REFETCH_MS) return null;
  }
  lastFetchAttempt = now;
  const keys = await fetchJwks();
  jwksCache = { keys, fetchedAt: now };
  return keys.find((k) => k.kid === kid) ?? null;
}

/** Drop the cached key set (tests, and an admin-triggered refresh). */
export function resetJwksCache(): void {
  jwksCache = null;
  lastFetchAttempt = 0;
}

/** Seed the key set directly, bypassing the network. Tests only. */
export function primeJwksCache(keys: Jwk[]): void {
  jwksCache = { keys, fetchedAt: Date.now() };
}

function b64uToBuffer(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(b64uToBuffer(segment).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("malformed JWT segment");
  }
  return parsed as Record<string, unknown>;
}

/** Raised for every rejected token; the message is safe to return to a client. */
export class OidcError extends Error {}

/** True when `bearer` has the shape of a JWT (three base64url segments). */
export function looksLikeJwt(bearer: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer);
}

/**
 * Verify a GitHub Actions ID token and return its claims.
 *
 * Checks, in order: shape, RS256 header with a known `kid`, RSA signature over
 * `header.payload`, then `iss`, `aud`, and the time window. Throws `OidcError`
 * on any failure.
 */
export async function verifyGithubOidcToken(
  token: string,
  audience: string = expectedAudience()
): Promise<GithubOidcClaims> {
  if (token.length > MAX_TOKEN_BYTES) throw new OidcError("token too large");
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("malformed token");
  const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJsonSegment(headerSeg);
    payload = decodeJsonSegment(payloadSeg);
  } catch {
    throw new OidcError("malformed token");
  }

  if (header.alg !== "RS256") throw new OidcError(`unsupported token algorithm: ${header.alg}`);
  const kid = header.kid;
  if (typeof kid !== "string" || !kid) throw new OidcError("token has no key id");

  let jwk: Jwk | null;
  try {
    jwk = await keyForKid(kid);
  } catch (err) {
    throw new OidcError(`could not fetch GitHub signing keys: ${err}`);
  }
  if (!jwk) throw new OidcError("token signed by an unknown key");

  let ok = false;
  try {
    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    ok = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${headerSeg}.${payloadSeg}`),
      key,
      b64uToBuffer(signatureSeg)
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new OidcError("token signature verification failed");

  if (payload.iss !== GITHUB_ISSUER) throw new OidcError(`unexpected token issuer: ${payload.iss}`);

  const aud = payload.aud;
  const audValues = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  const audOk = audValues.some(
    (a) =>
      typeof a === "string" &&
      a.length === audience.length &&
      timingSafeEqual(Buffer.from(a), Buffer.from(audience))
  );
  if (!audOk) throw new OidcError("token audience does not match this server");

  const now = Math.floor(Date.now() / 1000);
  const exp = payload.exp;
  if (typeof exp !== "number" || exp + CLOCK_SKEW_S < now) throw new OidcError("token expired");
  for (const field of ["nbf", "iat"] as const) {
    const v = payload[field];
    if (typeof v === "number" && v - CLOCK_SKEW_S > now) {
      throw new OidcError(`token ${field} is in the future`);
    }
  }

  for (const field of ["repository", "repository_owner", "workflow_ref", "event_name", "ref"]) {
    if (typeof payload[field] !== "string" || !payload[field]) {
      throw new OidcError(`token is missing the ${field} claim`);
    }
  }

  return payload as unknown as GithubOidcClaims;
}

/**
 * Workflow file path out of a `workflow_ref` claim:
 * `owner/repo/.github/workflows/docs.yml@refs/pull/42/merge` →
 * `.github/workflows/docs.yml`. Returns "" when the claim has an unexpected
 * shape (which only ever *narrows* what a publisher matches).
 */
export function workflowFile(claims: GithubOidcClaims): string {
  const beforeRef = claims.workflow_ref.split("@")[0] ?? "";
  const prefix = `${claims.repository}/`;
  return beforeRef.startsWith(prefix) ? beforeRef.slice(prefix.length) : "";
}

/**
 * Preview namespace a token is allowed to write, derived entirely from its
 * claims. Null when the run is not a pull request (a push/tag build has no
 * preview to own).
 *
 * `pull_request_target` runs with the *base* repository's permissions on
 * untrusted code and is deliberately not accepted.
 */
export function previewRefFromClaims(claims: GithubOidcClaims): PreviewRef | null {
  if (claims.event_name !== "pull_request") return null;
  const m = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(claims.ref);
  if (!m) return null;
  const [owner, repo] = claims.repository.split("/");
  if (!owner || !repo) return null;
  return makePreviewRef(owner, repo, m[1]!);
}
