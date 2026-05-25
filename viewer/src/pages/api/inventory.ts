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
import { parseObjectsInv, storeInventory } from "papyri-ingest";
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

export const POST: APIRoute = async ({ request }) => {
  let body: { name?: unknown; base_url?: unknown; inventory_url?: unknown };
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
  const invUrl =
    typeof body.inventory_url === "string" && body.inventory_url
      ? body.inventory_url
      : new URL("objects.inv", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/").toString();
  if (!isHttpUrl(invUrl)) {
    return respond({ ok: false, error: "inventory_url must be an http(s) URL" }, 400);
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
