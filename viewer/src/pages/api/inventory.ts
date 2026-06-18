// SSR endpoint: load / list external (intersphinx) inventories.
//
// External linking lets papyri bundles link *to* projects that do NOT
// publish a DocBundle (numpy, the Python stdlib, …). An admin registers such
// a project by pointing this endpoint at its Sphinx `objects.inv`; the viewer
// then resolves otherwise-unresolved cross-package refs to real external URLs
// at render time (see viewer/src/lib/xref.ts).
//
// POST /api/inventory
//   body: { "name": "numpy", "base_url": "https://numpy.org/doc/stable/",
//           "inventory_url"?: "<url to objects.inv>" }
//   Fetches + parses objects.inv, replaces the project's stored objects.
//   Response: { ok, project, version, count }.
//
// GET /api/inventory
//   Lists registered external projects with object counts.
//
// Auth: an admin action — authorized by the session-cookie middleware (the
// route is not in middleware.ts's PUBLIC_PREFIXES, so only a logged-in admin
// can reach it).

import type { APIRoute } from "astro";
import { isIPv4, isIPv6 } from "node:net";
import { parseObjectsInv, registerProject, storeInventory, unloadProject } from "papyri-ingest";
import { getBackends } from "../../lib/backends.ts";
import { respond } from "../../lib/api-utils.ts";

export const prerender = false;

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._\-+]*$/;

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Check if a URL is safe to fetch from (not targeting private/loopback/reserved addresses).
 * Rejects localhost, RFC 1918 private ranges, loopback, link-local, and IPv6 reserved ranges.
 */
export function isSafeUrl(rawUrl: string): boolean {
  // Parse and validate protocol.
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return false;
    }
  } catch {
    return false;
  }

  const hostname = new URL(rawUrl).hostname;
  if (!hostname) {
    return false;
  }

  // Reject localhost (case-insensitive).
  if (hostname.toLowerCase() === "localhost") {
    return false;
  }

  // Strip IPv6 brackets for IP detection checks (hostname may be "[::1]").
  let hostForIpCheck = hostname;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostForIpCheck = hostname.slice(1, -1);
  }

  // Check if it's an IPv4 literal.
  if (isIPv4(hostForIpCheck)) {
    const parts = hostForIpCheck.split(".").map((p) => parseInt(p, 10));
    if (parts.length !== 4) {
      return false; // Malformed, reject.
    }

    const [a, b] = parts;

    // Loopback: 127.x.x.x
    if (a === 127) {
      return false;
    }

    // Private: 10.x.x.x
    if (a === 10) {
      return false;
    }

    // Private: 172.16.x.x – 172.31.x.x
    if (a === 172 && b >= 16 && b <= 31) {
      return false;
    }

    // Private: 192.168.x.x
    if (a === 192 && b === 168) {
      return false;
    }

    // Link-local / cloud metadata: 169.254.x.x
    if (a === 169 && b === 254) {
      return false;
    }

    // 0.0.0.0
    if (a === 0 && b === 0) {
      return false;
    }

    return true;
  }

  // Check if it's an IPv6 literal.
  if (isIPv6(hostForIpCheck)) {
    // Loopback: ::1
    if (hostForIpCheck === "::1") {
      return false;
    }

    // Normalize to lowercase for prefix checks.
    const lower = hostForIpCheck.toLowerCase();

    // Unique Local Addresses (ULA): fc00::/7 and fd00::/8
    if (lower.startsWith("fc") || lower.startsWith("fd")) {
      return false;
    }

    // Link-local: fe80::/10
    if (lower.startsWith("fe80")) {
      return false;
    }

    return true;
  }

  // Not a literal IP — assume it's a hostname and allow (DNS rebinding is out of scope).
  return true;
}

export const POST: APIRoute = async ({ request }) => {
  let body: {
    name?: unknown;
    base_url?: unknown;
    inventory_url?: unknown;
    register_only?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  const name = body.name;
  const baseUrl = body.base_url;
  if (typeof name !== "string" || !SAFE_NAME.test(name)) {
    return respond({ ok: false, error: `invalid project name: ${JSON.stringify(name)}` }, 400);
  }
  if (typeof baseUrl !== "string" || !isHttpUrl(baseUrl)) {
    return respond({ ok: false, error: "base_url must be an http(s) URL" }, 400);
  }

  // Stage the (name, base_url) pair without fetching, so the admin UI can keep
  // a reusable list and load each entry on demand instead of re-typing URLs.
  if (body.register_only === true) {
    try {
      const { graphDb } = await getBackends();
      await registerProject(graphDb, { name, baseUrl });
    } catch (err) {
      return respond({ ok: false, error: `register failed: ${err}` }, 500);
    }
    return respond({ ok: true, project: name, registered: true });
  }

  const invUrl =
    typeof body.inventory_url === "string" && body.inventory_url
      ? body.inventory_url
      : new URL("objects.inv", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/").toString();
  if (!isHttpUrl(invUrl)) {
    return respond({ ok: false, error: "inventory_url must be an http(s) URL" }, 400);
  }

  if (!isSafeUrl(invUrl)) {
    return respond(
      { ok: false, error: "Inventory URL targets a private or reserved address" },
      400
    );
  }

  let bytes: Uint8Array;
  try {
    const res = await fetch(invUrl, { headers: { "User-Agent": "papyri-viewer" } });
    if (!res.ok) {
      return respond({ ok: false, error: `fetch ${invUrl} failed: HTTP ${res.status}` }, 502);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    return respond({ ok: false, error: `fetch ${invUrl} failed: ${err}` }, 502);
  }

  let parsed: Awaited<ReturnType<typeof parseObjectsInv>>;
  try {
    parsed = await parseObjectsInv(bytes);
  } catch (err) {
    return respond({ ok: false, error: `parse failed: ${err}` }, 422);
  }

  let backends: Awaited<ReturnType<typeof getBackends>>;
  try {
    backends = await getBackends();
  } catch (err) {
    return respond({ ok: false, error: `failed to open backends: ${err}` }, 500);
  }

  let count: number;
  try {
    count = await storeInventory(backends.graphDb, {
      name,
      baseUrl,
      version: parsed.version,
      objects: parsed.objects,
    });
  } catch (err) {
    return respond({ ok: false, error: `store failed: ${err}` }, 500);
  }

  return respond({ ok: true, project: name, version: parsed.version, count });
};

// DELETE /api/inventory
//   body: { "name": "numpy", "objects_only"?: true }
//   Default: drops the project and all its objects. With objects_only=true,
//   *unloads* — clears the objects but keeps the (name, base_url) row so it can
//   be re-loaded without re-typing. Either way cross-package refs into it
//   revert to unresolved. Same admin auth as POST/GET.
export const DELETE: APIRoute = async ({ request }) => {
  let body: { name?: unknown; objects_only?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }
  const name = body.name;
  if (typeof name !== "string" || !SAFE_NAME.test(name)) {
    return respond({ ok: false, error: `invalid project name: ${JSON.stringify(name)}` }, 400);
  }

  let backends: Awaited<ReturnType<typeof getBackends>>;
  try {
    backends = await getBackends();
  } catch (err) {
    return respond({ ok: false, error: `failed to open backends: ${err}` }, 500);
  }

  if (body.objects_only === true) {
    try {
      await unloadProject(backends.graphDb, { name });
    } catch (err) {
      return respond({ ok: false, error: `unload failed: ${err}` }, 500);
    }
    return respond({ ok: true, project: name, unloaded: true });
  }

  try {
    // Delete objects first, then the project row — explicit rather than relying
    // on ON DELETE CASCADE, which needs PRAGMA foreign_keys=ON (off by default
    // in SQLite).
    await backends.graphDb.batch([
      { sql: "DELETE FROM external_objects WHERE project=?", params: [name] },
      { sql: "DELETE FROM external_projects WHERE name=?", params: [name] },
    ]);
  } catch (err) {
    return respond({ ok: false, error: `delete failed: ${err}` }, 500);
  }

  return respond({ ok: true, project: name });
};

interface ProjectRow {
  name: string;
  base_url: string;
  version: string | null;
  fetched_at: number | null;
  objects: number;
}

export const GET: APIRoute = async () => {
  let backends: Awaited<ReturnType<typeof getBackends>>;
  try {
    backends = await getBackends();
  } catch (err) {
    return respond({ ok: false, error: `failed to open backends: ${err}` }, 500);
  }

  const rows = await backends.graphDb.all<ProjectRow>(
    "SELECT p.name, p.base_url, p.version, p.fetched_at, COUNT(o.name) AS objects " +
      "FROM external_projects p LEFT JOIN external_objects o ON o.project = p.name " +
      "GROUP BY p.name, p.base_url, p.version, p.fetched_at ORDER BY p.name"
  );
  return respond({ ok: true, projects: rows });
};
