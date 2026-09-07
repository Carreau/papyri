/**
 * GitHub Actions OIDC ("trusted publishing") token verification.
 *
 * A workflow running on GitHub Actions can ask GitHub for a short-lived,
 * repository-scoped OIDC ID token (`ACTIONS_ID_TOKEN_REQUEST_URL`). The token
 * is a JWT signed by GitHub whose claims describe *which* workflow, in *which*
 * repository, at *which* ref/environment is running. Verifying that signature
 * lets a viewer instance trust an upload from a repository's own CI without
 * that repository holding a long-lived secret — which is the point: fork PRs
 * cannot read repository secrets, so a bearer token cannot cover the most
 * common contribution flow.
 *
 * This module does the crypto and the *generic* JWT checks (signature, issuer,
 * audience, expiry). Mapping the verified claims to a papyri project is a
 * policy decision and lives in the auth store (`oidc_publishers`, see
 * `auth-db.ts`); the upload endpoint wires the two together.
 *
 * Signature verification uses `node:crypto` directly rather than a JWT
 * library: GitHub only ever issues RS256 tokens from a published JWKS, so the
 * whole job is "fetch JWKS, match `kid`, RSA-SHA256 verify" plus the claim
 * checks below. The rules enforced here:
 *
 *   - header `alg` must be RS256 — the algorithm is pinned, never read as a
 *     capability from the token (no `none`, no HMAC confusion);
 *   - header `kid` must name a key currently published in GitHub's JWKS;
 *   - `iss` must equal the GitHub Actions issuer exactly;
 *   - `aud` must equal the audience this deployment expects (see
 *     `getOidcAudience`) — this is what stops a token minted for some other
 *     service being replayed at papyri;
 *   - `exp` must be in the future and `nbf`/`iat` not in the future, within a
 *     small clock-skew tolerance;
 *   - the claims papyri authorizes on (`repository`, `job_workflow_ref`) must
 *     be present.
 */

import { createPublicKey, verify as cryptoVerify, constants as cryptoConstants } from "node:crypto";

/** The one issuer we accept tokens from. */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/** Allowed clock skew, in seconds, when checking `exp` / `nbf` / `iat`. */
const CLOCK_SKEW_S = 30;

/** How long a fetched JWKS is reused before being refreshed, in ms. */
const JWKS_TTL_MS = 10 * 60 * 1000;

/** Floor between two JWKS refreshes triggered by an unknown `kid`, in ms. */
const JWKS_MIN_REFRESH_MS = 60 * 1000;

/** Ceiling on the JWKS response body, to bound a hostile/broken endpoint. */
const JWKS_MAX_BYTES = 256 * 1024;

/**
 * The subset of GitHub's OIDC claims papyri reads. GitHub sends many more
 * (`actor`, `run_id`, `sha`, …); they are carried through in `raw` for
 * logging but never authorized on.
 */
export interface GithubOidcClaims {
  iss: string;
  aud: string;
  sub: string;
  /** "owner/repo", as GitHub spells it (original case). */
  repository: string;
  repository_owner: string;
  /**
   * Numeric id of the owning user/org, as a string. Stable across renames, so
   * it is what pins a publisher to an identity rather than to a name that can
   * be released and re-registered by someone else.
   */
  repository_owner_id: string;
  /**
   * Fully-qualified reference of the workflow file containing the running job,
   * e.g. `octo/repo/.github/workflows/docs.yml@refs/heads/main`. For a job
   * running in a reusable workflow this names the *reusable* workflow, which
   * is why it (and not `workflow_ref`) is what we authorize on.
   */
  job_workflow_ref: string;
  /** The entry workflow — informational only. */
  workflow_ref?: string;
  /** Git ref of the triggering run, e.g. `refs/heads/main`. */
  ref?: string;
  /** Deployment environment, present only when the job declares one. */
  environment?: string;
  exp: number;
  iat?: number;
  nbf?: number;
  /** Every claim as received, for logging. */
  raw: Record<string, unknown>;
}

export type OidcVerifyResult =
  | { ok: true; claims: GithubOidcClaims }
  | { ok: false; error: string };

/**
 * Cheap shape test used by the upload endpoint to tell an OIDC token apart
 * from a papyri personal upload token before doing any work. A JWT is three
 * base64url segments separated by dots; papyri's own tokens are
 * `papyri_pat_<hex>` and never match.
 */
export function looksLikeJwt(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

/**
 * The audience this deployment requires in an OIDC token, and the value
 * `papyri upload` asks GitHub to mint the token for (served by
 * `GET /api/oidc/audience`).
 *
 * Priority:
 *   1. `PAPYRI_OIDC_AUDIENCE` — explicit, wins everywhere.
 *   2. `PAPYRI_SITE` — the deployment's canonical external origin.
 *   3. the origin of the incoming request — local-dev fallback only.
 *
 * The fallback is deliberately last: the request origin comes from a
 * client-controlled `Host` header, so a deployment that relied on it would
 * accept a token minted for *any* audience from a caller who can set `Host`,
 * defeating the point of audience binding. A real deployment sets one of the
 * env vars; `audienceIsDerived` reports when neither was.
 */
export function getOidcAudience(requestUrl?: string | URL): string {
  const explicit = process.env.PAPYRI_OIDC_AUDIENCE?.trim();
  if (explicit) return explicit;
  const site = process.env.PAPYRI_SITE?.trim();
  if (site) {
    try {
      return new URL(site).origin;
    } catch {
      return site;
    }
  }
  if (requestUrl) return new URL(requestUrl).origin;
  return GITHUB_OIDC_ISSUER; // unreachable in practice; never matches a real token
}

/** True when the audience is only being inferred from the request host. */
export function audienceIsDerived(): boolean {
  return !process.env.PAPYRI_OIDC_AUDIENCE?.trim() && !process.env.PAPYRI_SITE?.trim();
}

// ---------------------------------------------------------------------------
// Claim shapes
// ---------------------------------------------------------------------------

/** Directory every GitHub Actions workflow file lives in. */
export const WORKFLOW_DIR = ".github/workflows/";

/**
 * `owner/repo`, GitHub's charset for both halves. `.` and `..` are excluded as
 * whole segments: they are not real GitHub names and would read as traversal
 * anywhere a repository string is echoed into a path.
 */
const REPOSITORY_RE = /^(?!\.\.?\/)[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function isValidRepository(value: unknown): value is string {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) return false;
  return !value.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * Normalize a workflow reference to the `.github/workflows/<file>` form stored
 * in `oidc_publishers`. Accepts either that path or a bare file name (what a
 * user reads off their repo), and rejects anything else — a path segment, a
 * ref suffix, or a name that isn't a workflow file. Returns null when invalid.
 */
export function normalizeWorkflowRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const file = trimmed.startsWith(WORKFLOW_DIR) ? trimmed.slice(WORKFLOW_DIR.length) : trimmed;
  if (!/^[A-Za-z0-9._-]+\.(ya?ml)$/.test(file)) return null;
  return WORKFLOW_DIR + file;
}

/**
 * Extract the workflow path from a `job_workflow_ref` claim
 * (`owner/repo/.github/workflows/docs.yml@refs/heads/main` →
 * `.github/workflows/docs.yml`), together with the repository that *owns* the
 * workflow file. For a reusable workflow that repository differs from the
 * `repository` claim, and it is the owning one a publisher must match: it
 * names the code that actually runs.
 */
export function parseJobWorkflowRef(
  jobWorkflowRef: string
): { repository: string; workflowRef: string } | null {
  const at = jobWorkflowRef.lastIndexOf("@");
  const withoutRef = at === -1 ? jobWorkflowRef : jobWorkflowRef.slice(0, at);
  const marker = withoutRef.indexOf("/" + WORKFLOW_DIR);
  if (marker === -1) return null;
  const repository = withoutRef.slice(0, marker);
  const workflowRef = normalizeWorkflowRef(withoutRef.slice(marker + 1));
  if (!isValidRepository(repository) || !workflowRef) return null;
  return { repository, workflowRef };
}

// ---------------------------------------------------------------------------
// JWKS handling
// ---------------------------------------------------------------------------

/** A JSON Web Key as published by GitHub (RSA signing keys only). */
interface Jwk {
  // Node's `createPublicKey({ format: "jwk" })` takes a key with an index
  // signature; declaring one here also keeps the DOM's `JsonWebKey` (which
  // Astro pulls in) from being picked over Node's.
  [field: string]: unknown;
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface JwksCache {
  keys: Jwk[];
  fetchedAt: number;
}

let jwksCache: JwksCache | null = null;
let jwksInFlight: Promise<Jwk[]> | null = null;

/** Test seam: swap the fetch used for JWKS/discovery. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Drop the cached JWKS (tests, and after a key rotation). */
export function resetJwksCache(): void {
  jwksCache = null;
  jwksInFlight = null;
}

async function fetchJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const resp = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`GET ${url} → HTTP ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength > JWKS_MAX_BYTES) {
    throw new Error(`GET ${url} → response too large (${buf.byteLength} bytes)`);
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

/**
 * Fetch GitHub's signing keys, via OIDC discovery so a `jwks_uri` change is
 * picked up automatically. Concurrent callers share one in-flight request.
 */
async function fetchJwks(fetchImpl: FetchLike): Promise<Jwk[]> {
  if (jwksInFlight) return jwksInFlight;
  jwksInFlight = (async () => {
    const config = (await fetchJson(
      fetchImpl,
      `${GITHUB_OIDC_ISSUER}/.well-known/openid-configuration`
    )) as { jwks_uri?: unknown; issuer?: unknown };
    if (config.issuer !== GITHUB_OIDC_ISSUER) {
      throw new Error(`unexpected issuer in OIDC discovery document: ${String(config.issuer)}`);
    }
    if (typeof config.jwks_uri !== "string") {
      throw new Error("OIDC discovery document has no jwks_uri");
    }
    // The discovery document is fetched from the issuer over TLS, but its
    // jwks_uri is still data from the network: pin it to the issuer's origin
    // so a compromised/served-wrong document cannot point key resolution at a
    // host of someone else's choosing.
    if (new URL(config.jwks_uri).origin !== new URL(GITHUB_OIDC_ISSUER).origin) {
      throw new Error(`jwks_uri is not on the issuer origin: ${config.jwks_uri}`);
    }
    const jwks = (await fetchJson(fetchImpl, config.jwks_uri)) as { keys?: unknown };
    if (!Array.isArray(jwks.keys)) throw new Error("JWKS has no keys array");
    const keys = jwks.keys as Jwk[];
    jwksCache = { keys, fetchedAt: Date.now() };
    return keys;
  })();
  try {
    return await jwksInFlight;
  } finally {
    jwksInFlight = null;
  }
}

/**
 * Resolve `kid` to a published key. Serves from cache when fresh; an unknown
 * `kid` triggers at most one refresh per `JWKS_MIN_REFRESH_MS` so a stream of
 * tokens with bogus kids cannot turn into a stream of outbound requests.
 */
async function getSigningKey(kid: string, fetchImpl: FetchLike): Promise<Jwk | null> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh) {
    const hit = jwksCache?.keys.find((k) => k.kid === kid);
    if (hit) return hit;
    // Unknown kid against a fresh cache: GitHub may have rotated keys.
    if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_MIN_REFRESH_MS) return null;
  }
  const keys = await fetchJwks(fetchImpl);
  return keys.find((k) => k.kid === kid) ?? null;
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

function b64urlToBuffer(segment: string): Buffer {
  return Buffer.from(segment, "base64url");
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(b64urlToBuffer(segment).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("segment is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(claims: Record<string, unknown>, name: string): string | null {
  const v = claims[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Does `aud` (string or array, per RFC 7519) contain `expected`? */
function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.some((a) => typeof a === "string" && a === expected);
  return false;
}

export interface VerifyOptions {
  /** Audience the token must carry (see `getOidcAudience`). */
  audience: string;
  /** Override the fetch used for discovery/JWKS (tests). */
  fetchImpl?: FetchLike;
  /** Override "now", in seconds since the epoch (tests). */
  now?: number;
}

/**
 * Verify a GitHub Actions OIDC token and return its claims. Never throws:
 * every failure (malformed, bad signature, wrong audience, expired, network
 * error reaching the JWKS) comes back as `{ ok: false, error }` with a message
 * safe to hand to the caller — none of them reveal anything the caller did not
 * already supply.
 */
export async function verifyGithubOidcToken(
  token: string,
  { audience, fetchImpl = fetch, now = Math.floor(Date.now() / 1000) }: VerifyOptions
): Promise<OidcVerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "malformed token: expected three segments" };
  const [headerSeg, payloadSeg, signatureSeg] = parts;

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJsonSegment(headerSeg);
    claims = decodeJsonSegment(payloadSeg);
  } catch (err) {
    return { ok: false, error: `malformed token: ${err}` };
  }

  // Algorithm is pinned, not negotiated: RS256 is what GitHub issues, and
  // anything else (notably `none` or an HMAC alg) is rejected outright.
  if (header.alg !== "RS256") {
    return { ok: false, error: `unsupported token algorithm: ${String(header.alg)}` };
  }
  const kid = requireString(header, "kid");
  if (!kid) return { ok: false, error: "token header has no kid" };

  if (claims.iss !== GITHUB_OIDC_ISSUER) {
    return { ok: false, error: `unexpected token issuer: ${String(claims.iss)}` };
  }
  if (!audienceMatches(claims.aud, audience)) {
    return {
      ok: false,
      error:
        `token audience does not match this deployment (expected "${audience}"). ` +
        "Request the ID token with that audience.",
    };
  }

  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (exp === null) return { ok: false, error: "token has no exp claim" };
  if (now >= exp + CLOCK_SKEW_S) return { ok: false, error: "token has expired" };
  if (typeof claims.nbf === "number" && now + CLOCK_SKEW_S < claims.nbf) {
    return { ok: false, error: "token is not valid yet" };
  }
  if (typeof claims.iat === "number" && now + CLOCK_SKEW_S < claims.iat) {
    return { ok: false, error: "token was issued in the future" };
  }

  let jwk: Jwk | null;
  try {
    jwk = await getSigningKey(kid, fetchImpl);
  } catch (err) {
    console.warn(`[oidc] could not fetch GitHub JWKS: ${String(err)}`);
    return { ok: false, error: "could not fetch GitHub's signing keys" };
  }
  if (!jwk) return { ok: false, error: `unknown signing key: ${kid}` };
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) {
    return { ok: false, error: `unsupported signing key type: ${String(jwk.kty)}` };
  }
  if (jwk.alg && jwk.alg !== "RS256") {
    return { ok: false, error: `signing key is not an RS256 key: ${jwk.alg}` };
  }

  let signatureValid: boolean;
  try {
    const key = createPublicKey({
      key: jwk,
      format: "jwk",
    });
    signatureValid = cryptoVerify(
      "sha256",
      Buffer.from(`${headerSeg}.${payloadSeg}`, "ascii"),
      { key, padding: cryptoConstants.RSA_PKCS1_PADDING },
      b64urlToBuffer(signatureSeg)
    );
  } catch (err) {
    return { ok: false, error: `signature verification failed: ${err}` };
  }
  if (!signatureValid) return { ok: false, error: "invalid token signature" };

  // Only now that the signature holds are the claims worth reading.
  const sub = requireString(claims, "sub");
  const repository = requireString(claims, "repository");
  const repositoryOwner = requireString(claims, "repository_owner");
  const repositoryOwnerId = requireString(claims, "repository_owner_id");
  const jobWorkflowRef = requireString(claims, "job_workflow_ref");
  if (!sub || !repository || !repositoryOwner || !repositoryOwnerId || !jobWorkflowRef) {
    return { ok: false, error: "token is missing the repository/workflow claims papyri needs" };
  }

  return {
    ok: true,
    claims: {
      iss: GITHUB_OIDC_ISSUER,
      aud: audience,
      sub,
      repository,
      repository_owner: repositoryOwner,
      repository_owner_id: repositoryOwnerId,
      job_workflow_ref: jobWorkflowRef,
      workflow_ref: requireString(claims, "workflow_ref") ?? undefined,
      ref: requireString(claims, "ref") ?? undefined,
      environment: requireString(claims, "environment") ?? undefined,
      exp,
      iat: typeof claims.iat === "number" ? claims.iat : undefined,
      nbf: typeof claims.nbf === "number" ? claims.nbf : undefined,
      raw: claims,
    },
  };
}
