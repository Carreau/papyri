// SSR endpoint: graph DB table stats for the admin panel.
//
// Returns the list of tables in the graph DB and the row count of each. Used
// by the admin page to surface what's currently stored so the operator can
// decide whether to clear the graphstore before a re-ingest.
//
// Method: GET. No auth — counts are not sensitive, and the admin page is
// already reachable without auth in local dev.

import type { APIRoute } from "astro";
import { getBackends } from "../../lib/backends.ts";
import { respond } from "../../lib/api-utils.ts";

export const prerender = false;

// Hard-coded against the known schema (see ingest/migrations/*.sql).
const TABLES = ["nodes", "links", "bundles"] as const;

export const GET: APIRoute = async () => {
  try {
    const { graphDb } = await getBackends();
    const tables: Array<{ name: string; rows: number }> = [];
    for (const name of TABLES) {
      const row = await graphDb.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`);
      tables.push({ name, rows: row?.n ?? 0 });
    }
    return respond({ ok: true, tables });
  } catch (err) {
    return respond({ ok: false, error: String(err) }, 500);
  }
};
