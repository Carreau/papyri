// SSR endpoint: receive a `.papyri` artifact via HTTP PUT and ingest it
// into the cross-link graph store.
//
// The client (`papyri upload`) produces a `.papyri` artifact via
// `papyri pack` and streams it here. The artifact is a gzipped canonical-CBOR
// `Bundle` Node (tag 4070) that carries the entire DocBundle as typed fields.
// We gunzip + cbor-decode it, then hand the in-memory Bundle to the ingest
// pipeline directly — no temporary directory, no fs round-trip.
//
// Backend selection happens in `lib/backends.ts`: same {blobStore, graphDb}
// pair that the read-side pages use (filesystem + better-sqlite3).
//
// Expected client command:
//   papyri pack ~/.papyri/data/numpy_2.3.5
//   curl -X PUT http://localhost:4321/api/bundle \
//        -H "Content-Type: application/gzip" \
//        --data-binary @numpy-2.3.5.papyri
//
// (or just `papyri upload <bundle_dir-or-.papyri>` which does both steps.)
//
// Response contract:
//   The success path returns 200 with Content-Type application/x-ndjson:
//   a streaming sequence of one JSON object per line. The client must read
//   the body to determine outcome — the final line is either `{"event":
//   "done", "pkg":..., "version":...}` or `{"event":"error","error":...}`.
//   The stream gives the client live progress on long ingests.
//
//   Pre-stream errors that we can resolve before hitting the wire still
//   come back as buffered JSON with the appropriate status code:
//     401  { ok: false, error }   — missing/invalid bearer token
//     400  { ok: false, error }   — missing body or bad Bundle metadata
//     422  { ok: false, error }   — gunzip / cbor decode failed
//     500  { ok: false, error }   — backend setup failed
//   Once the ingest stream opens we return 200 unconditionally; any
//   downstream failure is reported as an `error` event in the body.

import type { APIRoute } from "astro";
import { timingSafeEqual } from "node:crypto";
import { Ingester, decode, type TypedNode } from "papyri-ingest";
import { isSafeSegment } from "../../lib/paths.ts";
import { getBackends, getUploadToken } from "../../lib/backends.ts";
import { respond, sha256Hex } from "../../lib/api-utils.ts";
import { getAuthDb } from "../../lib/auth-db.ts";
import { scopeAllows, type PublisherScope } from "../../lib/auth-db.ts";
import {
  makePreviewRef,
  previewBase,
  previewId,
  previewRefFromClaims,
  type PreviewRef,
} from "../../lib/preview.ts";
import { linkForBundle } from "../../lib/links.ts";
import { sweepExpiredPreviews, touchPreview } from "../../lib/preview-store.ts";
import {
  audienceIsDerived,
  getOidcAudience,
  looksLikeJwt,
  verifyGithubOidcToken,
} from "../../lib/github-oidc.ts";

export const prerender = false;

// Who is making an upload request, established before any project-scope check.
//   - global: presented the deployment-wide PAPYRI_UPLOAD_TOKEN (CI / admin
//     escape hatch). May upload any project.
//   - user:   presented a personal upload token resolving to an account. May
//     upload the projects that account is a member of (admins: any). When the
//     token is scoped to a single project, `scopedProject` names it and the
//     token may upload only that project.
//   - oidc:   presented a GitHub Actions OIDC token whose claims match a
//     registered trusted publisher. May upload exactly the project that
//     publisher names — no account, no stored secret (see github-oidc.ts).
//     Where it may write is decided by the run, not by the request: a
//     pull_request run publishes into that pull request's preview namespace,
//     any other event into the published store, and the publisher's `scope`
//     says which of the two it was trusted for.
//   - open:   no token required and none presented, on a fresh install with no
//     users — the local-dev "everything open" mode.
type UploadPrincipal =
  | { kind: "global" }
  | { kind: "open" }
  | { kind: "user"; userId: number; isAdmin: boolean; scopedProject: string | null }
  | {
      kind: "oidc";
      project: string;
      repository: string;
      workflowRef: string;
      scope: PublisherScope;
      /** Preview this run owns, or null when the run is not a pull request. */
      preview: PreviewRef | null;
    };

/** Constant-time string compare that tolerates length differences. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const UNAUTHORIZED = () =>
  respond({ ok: false, error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });

/**
 * Authenticate an upload request to a principal, WITHOUT yet checking which
 * project it targets. Returns a 401 Response when the caller cannot be
 * authenticated. Auth policy (see PLAN.md "per-user authorization scopes"):
 *
 *   - A bearer that matches PAPYRI_UPLOAD_TOKEN (timing-safe) → global.
 *   - A JWT-shaped bearer verified as a GitHub Actions OIDC
 *     token covered by a registered publisher                  → oidc.
 *   - A bearer that resolves as a personal upload token        → user.
 *   - A bearer that matches neither                            → 401.
 *   - No bearer, PAPYRI_UPLOAD_TOKEN set                       → 401.
 *   - No bearer, no global token, and zero users (fresh local
 *     install)                                                 → open.
 *   - No bearer, no global token, but users exist (a real
 *     deployment) → 401: production must use a per-user token.
 */
async function authenticateUpload(request: Request): Promise<UploadPrincipal | Response> {
  const globalToken = await getUploadToken();
  const header = request.headers.get("Authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  if (bearer) {
    if (globalToken && timingSafeEqualStr(bearer, globalToken)) {
      return { kind: "global" };
    }
    // A JWT-shaped bearer is a GitHub Actions OIDC token, never a papyri
    // token (those are opaque `papyri_pat_…` strings), so it is safe to branch
    // on shape before any DB lookup: verify GitHub's signature, then map the
    // claims to a registered trusted publisher.
    if (looksLikeJwt(bearer)) return authenticateOidc(bearer, request);
    const resolved = (await getAuthDb()).resolveUploadToken(bearer);
    if (resolved)
      return {
        kind: "user",
        userId: resolved.user.id,
        isAdmin: resolved.user.is_admin,
        scopedProject: resolved.projectName,
      };
    return UNAUTHORIZED();
  }

  // No bearer presented.
  if (globalToken) return UNAUTHORIZED();
  // Local-dev convenience: only open when the deployment has no accounts at
  // all. Once any user exists, uploads require a per-user token.
  if ((await getAuthDb()).userCount() === 0) return { kind: "open" };
  return UNAUTHORIZED();
}

/** Why a verified OIDC token still does not authorize an upload. */
const OIDC_REJECTION: Record<string, string> = {
  "bad-claims": "the token's job_workflow_ref claim is not a workflow reference papyri understands",
  "reusable-workflow":
    "the publishing job runs in a reusable workflow from another repository; " +
    "papyri only trusts workflows stored in the repository itself",
  "no-match":
    "no papyri project trusts this repository + workflow. Register it under the " +
    "project's trusted publishers first",
  "environment-mismatch":
    "the trusted publisher for this workflow requires a GitHub Environment the job did not declare",
  "owner-mismatch":
    "this repository's owner id differs from the one recorded when the publisher was first used",
};

/**
 * Authenticate a GitHub Actions OIDC token: verify GitHub's signature and the
 * generic JWT claims, then match repository/workflow/environment against the
 * `oidc_publishers` table. A 401 covers "not a token we can trust at all"; a
 * verified token that no publisher covers gets a 403 naming the reason, since
 * that is a configuration problem the caller can act on.
 */
async function authenticateOidc(
  token: string,
  request: Request
): Promise<UploadPrincipal | Response> {
  const audience = getOidcAudience(request.url);
  if (audienceIsDerived()) {
    console.warn(
      "[oidc] neither PAPYRI_OIDC_AUDIENCE nor PAPYRI_SITE is set — falling back to the " +
        "request origin as the OIDC audience. Set one of them in any real deployment."
    );
  }
  const verified = await verifyGithubOidcToken(token, { audience });
  if (!verified.ok) {
    return respond({ ok: false, error: `OIDC token rejected: ${verified.error}` }, 401, {
      "WWW-Authenticate": "Bearer",
    });
  }
  const { claims } = verified;
  const match = (await getAuthDb()).resolveOidcPublisher(claims);
  if (!match.ok) {
    console.warn(
      `[oidc] refused ${claims.repository} (${claims.job_workflow_ref}): ${match.reason}`
    );
    return respond(
      { ok: false, error: `OIDC token not authorized: ${OIDC_REJECTION[match.reason]}` },
      403
    );
  }
  return {
    kind: "oidc",
    project: match.publisher.project_name,
    repository: claims.repository,
    workflowRef: match.publisher.workflow_ref,
    scope: match.publisher.scope,
    // Derived from the claims, never from the request: a pull_request run owns
    // exactly one preview namespace and cannot address another.
    preview: previewRefFromClaims(claims),
  };
}

/**
 * Authorize an already-authenticated principal to upload `project` (the
 * bundle's module name). Returns a 403 Response when not permitted, or null to
 * proceed.
 */
async function authorizeUploadProject(
  principal: UploadPrincipal,
  project: string
): Promise<Response | null> {
  if (principal.kind === "global" || principal.kind === "open") return null;
  // A trusted publisher authorizes exactly the project it was registered for.
  if (principal.kind === "oidc") {
    if (principal.project === project) return null;
    return respond(
      {
        ok: false,
        error:
          `${principal.repository} (${principal.workflowRef}) is a trusted publisher for ` +
          `project "${principal.project}", not "${project}"`,
      },
      403
    );
  }
  // A project-scoped token may upload only that one project — this narrows the
  // user's standing authority and applies even to admins.
  if (principal.scopedProject !== null && principal.scopedProject !== project) {
    return respond(
      {
        ok: false,
        error: `this token is scoped to project "${principal.scopedProject}", not "${project}"`,
      },
      403
    );
  }
  if (principal.isAdmin) return null;
  if ((await getAuthDb()).canUserUploadProject(principal.userId, project)) return null;
  return respond({ ok: false, error: `not authorized to upload project "${project}"` }, 403);
}

/**
 * Which namespace this upload targets: the main store (null) or a PR preview.
 *
 * An OIDC principal always writes where its claims say — a pull_request run
 * into that pull request's preview, any other event into the published store;
 * the query string cannot move it. The deployment-wide token may name a preview
 * explicitly (`?preview=owner/repo%2342`), which is how a preview is exercised
 * locally without minting GitHub tokens. Per-user tokens cannot: previews are
 * the CI path.
 */
function resolveTargetPreview(principal: UploadPrincipal, url: URL): PreviewRef | null | Response {
  if (principal.kind === "oidc") {
    // The event that minted the token decides the target, and the publisher's
    // scope says whether it was trusted for that target. Registering a
    // repository so contributors get preview links does not, by itself, let it
    // overwrite published documentation — and vice versa.
    const target = principal.preview ? "preview" : "release";
    if (!scopeAllows(principal.scope, target)) {
      return respond(
        {
          ok: false,
          error:
            `${principal.repository} (${principal.workflowRef}) is trusted to publish ` +
            `${principal.scope === "preview" ? "pull-request previews" : "releases"} for ` +
            `"${principal.project}", but this run would publish a ${target}. ` +
            "Widen the trusted publisher's scope if that is intended.",
        },
        403
      );
    }
    return principal.preview;
  }
  const raw = url.searchParams.get("preview");
  if (!raw) return null;
  if (principal.kind !== "global" && principal.kind !== "open") {
    return respond(
      { ok: false, error: "only the deployment upload token may target a preview explicitly" },
      403
    );
  }
  const m = /^([^/]+)\/([^/#]+)[#/](\d+)$/.exec(raw);
  const ref = m ? makePreviewRef(m[1]!, m[2]!, m[3]!) : null;
  if (!ref) {
    return respond(
      { ok: false, error: `malformed preview id ${JSON.stringify(raw)} (expected owner/repo#42)` },
      400
    );
  }
  return ref;
}

// Existence check for `papyri upload`'s dedup step. The client computes the
// SHA-256 of the .papyri artifact it is about to send and asks whether the
// server already holds that exact content for (module, version). When it
// does, the client skips the upload entirely. Failing open (any error → the
// client uploads anyway) is the responsibility of the client.
export const GET: APIRoute = async ({ request, url }) => {
  const principal = await authenticateUpload(request);
  if (principal instanceof Response) return principal;

  const module = url.searchParams.get("module");
  const version = url.searchParams.get("version");
  const hash = url.searchParams.get("hash");
  if (!module || !version) {
    return respond({ ok: false, error: "module and version query params required" }, 400);
  }
  // The dedup check leaks whether a bundle exists, so scope it like the upload:
  // a user may only probe projects they could upload.
  const authzFail = await authorizeUploadProject(principal, module);
  if (authzFail) return authzFail;

  const preview = resolveTargetPreview(principal, url);
  if (preview instanceof Response) return preview;

  let backends: Awaited<ReturnType<typeof getBackends>>;
  try {
    backends = await getBackends(preview);
  } catch (err) {
    console.error("failed to open ingest backend:", err);
    return respond({ ok: false, error: "failed to open ingest backend" }, 500);
  }

  const row = await backends.graphDb.get<{ content_hash: string | null }>(
    "SELECT content_hash FROM bundles WHERE module = ? AND version = ?",
    [module, version]
  );
  const storedHash = row?.content_hash ?? null;
  // With a hash supplied, "exists" means identical content already ingested.
  // Without one, it degrades to "is this (module, version) present at all".
  const exists = hash ? storedHash !== null && storedHash === hash : row !== null;
  return respond({ ok: true, module, version, stored_hash: storedHash, exists });
};

export const PUT: APIRoute = async ({ request, url }) => {
  // Authenticate the caller to a principal first. The project-scope check
  // happens after decoding, once we know which project (bundle.module) this
  // artifact targets.
  const principal = await authenticateUpload(request);
  if (principal instanceof Response) return principal;

  if (!request.body) {
    return respond({ ok: false, error: "request body required (.papyri artifact)" }, 400);
  }

  // A preview upload writes into its own isolated store, so nothing here can
  // touch the main graph — no backrefs, no search index, no eviction cascade.
  const preview = resolveTargetPreview(principal, url);
  if (preview instanceof Response) return preview;

  let ingester: Ingester;
  let backends: Awaited<ReturnType<typeof getBackends>>;
  try {
    backends = await getBackends(preview);
    ingester = new Ingester({ backends });
  } catch (err) {
    console.error("failed to open ingest backend:", err);
    return respond({ ok: false, error: "failed to open ingest backend" }, 500);
  }

  // Decode the artifact: gunzip → CBOR → Bundle Node. DecompressionStream
  // is a portable Web Streams API, so this is a single code path.
  // Read the compressed bytes into a buffer first so we can record the
  // on-wire size before decompressing. The raw compressed bytes are kept for
  // archiving to rawStore before ingest runs.
  let bundle: TypedNode;
  let bundleSizeBytes = 0;
  let compressedBytes: Uint8Array;
  try {
    const compressedBuffer = await request.arrayBuffer();
    bundleSizeBytes = compressedBuffer.byteLength;
    compressedBytes = new Uint8Array(compressedBuffer);
    // Use the original ArrayBuffer (not the Uint8Array view) so TypeScript
    // accepts it as a BlobPart — Blob rejects Uint8Array<ArrayBufferLike>.
    const decompressed = new Response(
      new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream("gzip"))
    );
    const cborBytes = new Uint8Array(await decompressed.arrayBuffer());
    bundle = decode<TypedNode>(cborBytes);
  } catch (err) {
    return respond({ ok: false, error: `failed to decode .papyri artifact: ${err}` }, 422);
  }

  // Path-traversal guard: validate package/version segments before they
  // become fs paths. A hostile artifact could otherwise set ".." or "/"
  // in `bundle.module` / `bundle.version` and escape the ingest namespace.
  const rawPkg = (bundle as Record<string, unknown>)["module"];
  const rawVer = (bundle as Record<string, unknown>)["version"];
  if (typeof rawPkg !== "string" || !rawPkg || !isSafeSegment(rawPkg)) {
    return respond(
      { ok: false, error: `unsafe or missing package name in Bundle: ${JSON.stringify(rawPkg)}` },
      400
    );
  }
  if (typeof rawVer !== "string" || !rawVer || !isSafeSegment(rawVer)) {
    return respond(
      { ok: false, error: `unsafe or missing version in Bundle: ${JSON.stringify(rawVer)}` },
      400
    );
  }

  // Project-scope authorization: now that we know the target project
  // (bundle.module), confirm the authenticated principal may upload it.
  const authzFail = await authorizeUploadProject(principal, rawPkg);
  if (authzFail) return authzFail;

  // Streaming response: ingest is potentially long-running. Open an NDJSON
  // stream now and emit progress events as the ingest walks the bundle; the
  // client reads line-by-line.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = async (event: Record<string, unknown>) => {
    await writer.write(encoder.encode(JSON.stringify(event) + "\n"));
  };

  // Kick the ingest off without awaiting. The response stream keeps the
  // connection alive; any throw turns into a final `error` event.
  //
  // Note: if the client disconnects mid-stream, writer.close() throws and
  // the ingest continues silently to completion. Client cancellation is NOT
  // server cancellation.
  // Timing decoration: each event is enriched with `elapsed_s` (since the
  // stream opened) and `since_last_ms` (since the previous event) so the
  // client can render live wall-time stats — the stream surfaces per-chunk
  // timings during a long ingest.
  const startedAt = Date.now();
  let prevEventAt = startedAt;
  const sendWithTiming = async (event: Record<string, unknown>) => {
    const now = Date.now();
    await send({
      ...event,
      elapsed_s: ((now - startedAt) / 1000).toFixed(2),
      since_last_ms: now - prevEventAt,
    });
    prevEventAt = now;
  };

  (async () => {
    try {
      await sendWithTiming({ event: "start", pkg: rawPkg, version: rawVer });
      // Archive the raw compressed bundle before ingest. Failure is non-fatal:
      // the ingest proceeds and the warning is surfaced in the stream. The raw
      // archive exists solely for future reingest; missing it doesn't corrupt
      // the processed store.
      try {
        await backends.rawStore.put(rawPkg, rawVer, compressedBytes);
      } catch (archiveErr) {
        await sendWithTiming({
          event: "warning",
          message: `raw archive write failed: ${archiveErr}`,
        });
      }
      // Content hash of the artifact as received — stored in the bundles row
      // so a later `papyri upload` of identical bytes can be skipped via the
      // GET existence check above.
      const contentHash = await sha256Hex(compressedBytes);
      const result = await ingester.ingestBundle(
        bundle,
        bundleSizeBytes,
        async (phase, done, total) => {
          await sendWithTiming({ event: "progress", phase, done, total });
        },
        contentHash
      );
      if (preview) {
        // Register (or renew) the namespace only once content is actually in
        // it, and take the chance to evict any preview past its TTL.
        await touchPreview(preview);
        void sweepExpiredPreviews().catch((err) =>
          console.warn("preview eviction sweep failed:", err)
        );
      }
      await sendWithTiming({
        event: "done",
        pkg: result.pkg,
        version: result.version,
        ...(preview
          ? {
              preview: previewId(preview),
              // Built from the canonical helper, then prefixed: this endpoint
              // runs outside a preview request context, so `linkForBundle`
              // returns the un-prefixed path here.
              url: new URL(
                previewBase(preview) + linkForBundle(result.pkg, result.version),
                process.env.PAPYRI_SITE ?? url.origin
              ).toString(),
            }
          : {}),
      });
    } catch (err) {
      await sendWithTiming({ event: "error", error: `ingest failed: ${err}` });
    } finally {
      try {
        await writer.close();
      } catch {
        /* writer already closed (e.g. client disconnect); nothing to do. */
      }
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      // Disable response buffering on intermediaries that honor it. The
      // server emits one line per progress event; without this some
      // proxies coalesce until the connection closes.
      "X-Accel-Buffering": "no",
    },
  });
};
