// Papyri upload API — Cloudflare Worker.
//
// Routes:
//   POST /upload/<pkg>/<ver>
//     Authorization: Bearer <token>
//     Content-Type: application/zip
//     Body: ZIP of the bundle directory (same tree as ~/.papyri/data/<pkg>_<ver>/)
//
// Responses:
//   200 — accepted, ingest pipeline triggered
//   400 — missing pkg/ver or body
//   401 — missing/invalid Authorization header
//   403 — token not authorised for this package
//   409 — bundle already exists (add ?overwrite=1 to replace)
//   413 — body exceeds MAX_BUNDLE_BYTES
//   500 — internal error
import { validateToken, type Env } from "./auth.ts";
import { triggerIngest } from "./trigger.ts";

const MAX_BUNDLE_BYTES = 200 * 1024 * 1024; // 200 MB

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // Upload endpoint: POST /upload/<pkg>/<ver>
    const uploadMatch = url.pathname.match(
      /^\/upload\/([^/]+)\/([^/]+)\/?$/,
    );
    if (request.method === "POST" && uploadMatch) {
      return handleUpload(request, env, uploadMatch[1]!, uploadMatch[2]!);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleUpload(
  request: Request,
  env: Env,
  pkg: string,
  ver: string,
): Promise<Response> {
  // --- Authenticate ---
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return new Response("Missing Authorization header", { status: 401 });
  }
  const token = auth.slice(7).trim();
  if (!token) {
    return new Response("Empty token", { status: 401 });
  }

  const authorised = await validateToken(token, pkg, env);
  if (!authorised) {
    return new Response("Token not authorised for this package", {
      status: 403,
    });
  }

  // --- Check for existing bundle unless ?overwrite=1 ---
  const overwrite = new URL(request.url).searchParams.get("overwrite") === "1";
  const r2Key = `bundles/${pkg}/${ver}.zip`;
  if (!overwrite) {
    const existing = await env.BUNDLE_STORE.head(r2Key).catch(() => null);
    if (existing) {
      return new Response(
        `Bundle ${pkg}@${ver} already exists. Use ?overwrite=1 to replace.`,
        { status: 409 },
      );
    }
  }

  // --- Read body (streaming with size cap) ---
  if (!request.body) {
    return new Response("Request body is required", { status: 400 });
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BUNDLE_BYTES) {
    return new Response("Bundle too large", { status: 413 });
  }

  let body: ArrayBuffer;
  try {
    body = await request.arrayBuffer();
  } catch {
    return new Response("Failed to read request body", { status: 400 });
  }
  if (body.byteLength > MAX_BUNDLE_BYTES) {
    return new Response("Bundle too large", { status: 413 });
  }
  if (body.byteLength === 0) {
    return new Response("Empty body", { status: 400 });
  }

  // --- Store raw bundle ZIP in R2 ---
  try {
    await env.BUNDLE_STORE.put(r2Key, body, {
      httpMetadata: { contentType: "application/zip" },
      customMetadata: { pkg, ver, uploadedAt: new Date().toISOString() },
    });
  } catch (err) {
    console.error("R2 put failed", err);
    return new Response("Storage error", { status: 500 });
  }

  // --- Trigger ingest pipeline ---
  try {
    await triggerIngest(pkg, ver, env);
  } catch (err) {
    // Log but don't fail the request — the bundle is safely in R2 and the
    // operator can re-trigger the workflow manually.
    console.error("Ingest trigger failed", err);
    return new Response(
      JSON.stringify({
        ok: true,
        warning: "Bundle stored but ingest trigger failed. Re-trigger manually.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true, pkg, ver }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
