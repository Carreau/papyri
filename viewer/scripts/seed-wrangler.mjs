#!/usr/bin/env node
// Seed the local wrangler D1 + R2 simulation from the on-disk papyri ingest
// store. One-shot bootstrap — running it twice is fine, the second run
// overwrites the local D1 schema and re-uploads every blob.
//
// Usage (from viewer/):
//   pnpm exec node scripts/seed-wrangler.mjs
//
// Inputs:
//   $PAPYRI_INGEST_DIR (default ~/.papyri/ingest) — the same directory
//   `papyri ingest` writes to. Must contain a `papyri.db` SQLite file and
//   one or more `<pkg>/<ver>/` blob trees.
//
// Side effects:
//   - Creates / replaces the schema in the local D1 database bound as
//     `GRAPH_DB` in wrangler.toml, then bulk-inserts every row from
//     `papyri.db` `nodes` + `links` tables.
//   - PUTs every file under `<ingest>/<pkg>/<ver>/` into the local R2
//     bucket bound as `BLOBS` (key = the path relative to the ingest
//     root).
//
// This script does not talk to the remote Cloudflare API. It only writes
// to miniflare's local persistence under `.wrangler/state/v3/` via
// `wrangler d1 execute --local` and `wrangler r2 object put --local`.
// Pass `--remote` to target the real bindings instead.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const REMOTE = args.includes("--remote");
const QUIET = args.includes("--quiet");

const INGEST_DIR = process.env.PAPYRI_INGEST_DIR ?? join(homedir(), ".papyri", "ingest");
const DB_PATH = process.env.PAPYRI_INGEST_DB ?? join(INGEST_DIR, "papyri.db");
const D1_BINDING = "papyri-viewer-graph"; // database_name in wrangler.toml
const R2_BINDING = "papyri-viewer-blobs"; // bucket_name in wrangler.toml

// Run wrangler from the viewer/ directory so it picks up wrangler.toml. The
// script lives in viewer/scripts/, so the parent of __dirname is the right
// cwd.
const VIEWER_DIR = resolve(new URL("..", import.meta.url).pathname);

function log(...msg) {
  if (!QUIET) console.log(...msg);
}

function die(msg) {
  console.error(`seed-wrangler: ${msg}`);
  process.exit(1);
}

function checkInputs() {
  let st;
  try {
    st = statSync(INGEST_DIR);
  } catch {
    die(
      `ingest dir not found: ${INGEST_DIR}\n  Run 'papyri ingest' first or set PAPYRI_INGEST_DIR.`
    );
  }
  if (!st.isDirectory()) die(`ingest dir is not a directory: ${INGEST_DIR}`);
  try {
    statSync(DB_PATH);
  } catch {
    die(`graph DB not found: ${DB_PATH}`);
  }
  // Bail out early if wrangler isn't on PATH; spawning it later just gives
  // a confusing ENOENT.
  const probe = spawnSync("wrangler", ["--version"], { stdio: "ignore" });
  if (probe.error) {
    die(
      "wrangler CLI not found on PATH.\n" +
        "  Install with: pnpm add -D wrangler   (run from viewer/)\n" +
        "  Or globally:  npm install -g wrangler"
    );
  }
}

// ---------------------------------------------------------------------------
// D1: schema + bulk insert from papyri.db
// ---------------------------------------------------------------------------

// Mirrors ingest/src/graphstore.ts. D1 ignores most SQLite pragmas and
// supports a subset of features; this schema is the safe intersection.
// `digest BLOB` stays — D1 supports BLOB literals via X'...' hex.
const D1_SCHEMA = `
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS nodes;
CREATE TABLE nodes(
    id         INTEGER PRIMARY KEY,
    package    TEXT NOT NULL,
    version    TEXT NOT NULL,
    category   TEXT NOT NULL,
    identifier TEXT NOT NULL,
    has_blob   INTEGER NOT NULL DEFAULT 0,
    digest     BLOB,
    UNIQUE(package, version, category, identifier)
);
CREATE TABLE links(
    source INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    dest   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    PRIMARY KEY (source, dest)
);
CREATE INDEX idx_links_dest ON links(dest);
CREATE INDEX idx_nodes_pkg_cat_ident ON nodes(package, category, identifier);
`.trim();

function sqlString(s) {
  return "'" + s.replace(/'/g, "''") + "'";
}

function sqlBlob(buf) {
  if (buf == null) return "NULL";
  // SQLite/D1 hex literal.
  return "X'" + Buffer.from(buf).toString("hex") + "'";
}

function buildD1Sql() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const nodes = db
      .prepare("SELECT id, package, version, category, identifier, has_blob, digest FROM nodes")
      .all();
    const links = db.prepare("SELECT source, dest FROM links").all();
    log(`  papyri.db: ${nodes.length} nodes, ${links.length} links`);

    const lines = [D1_SCHEMA];

    // Insert nodes in batches. D1's CLI accepts large files but extremely
    // long single statements can OOM the SQL parser on the remote side; a
    // few hundred rows per VALUES clause is comfortably under the limit.
    const NODE_BATCH = 200;
    for (let i = 0; i < nodes.length; i += NODE_BATCH) {
      const slice = nodes.slice(i, i + NODE_BATCH);
      const values = slice
        .map(
          (n) =>
            `(${n.id}, ${sqlString(n.package)}, ${sqlString(n.version)}, ` +
            `${sqlString(n.category)}, ${sqlString(n.identifier)}, ${n.has_blob ? 1 : 0}, ` +
            `${sqlBlob(n.digest)})`
        )
        .join(", ");
      lines.push(
        `INSERT INTO nodes(id, package, version, category, identifier, has_blob, digest) VALUES ${values};`
      );
    }

    const LINK_BATCH = 500;
    for (let i = 0; i < links.length; i += LINK_BATCH) {
      const slice = links.slice(i, i + LINK_BATCH);
      const values = slice.map((l) => `(${l.source}, ${l.dest})`).join(", ");
      lines.push(`INSERT INTO links(source, dest) VALUES ${values};`);
    }

    return lines.join("\n");
  } finally {
    db.close();
  }
}

function seedD1() {
  log("Building D1 SQL from papyri.db...");
  const sql = buildD1Sql();
  const tmp = mkdtempSync(join(tmpdir(), "papyri-d1-"));
  const sqlFile = join(tmp, "seed.sql");
  writeFileSync(sqlFile, sql, "utf8");
  log(`  wrote ${sql.length.toLocaleString()} bytes of SQL to ${sqlFile}`);

  const wranglerArgs = [
    "d1",
    "execute",
    D1_BINDING,
    REMOTE ? "--remote" : "--local",
    "--file",
    sqlFile,
    // Avoid wrangler's interactive "are you sure?" prompt.
    "--yes",
  ];
  log(`Running: wrangler ${wranglerArgs.join(" ")}`);
  const res = spawnSync("wrangler", wranglerArgs, {
    cwd: VIEWER_DIR,
    stdio: "inherit",
  });
  rmSync(tmp, { recursive: true, force: true });
  if (res.status !== 0) die(`wrangler d1 execute failed (exit ${res.status})`);
  log("D1 seeded.");
}

// ---------------------------------------------------------------------------
// R2: PUT every blob under <ingest>/<pkg>/<ver>/.
// ---------------------------------------------------------------------------

function listBlobs() {
  const out = [];
  // Use `recursive: true` (Node 18.17+) to avoid hand-rolling the walk.
  const ents = readdirSync(INGEST_DIR, { withFileTypes: true, recursive: true });
  for (const e of ents) {
    if (!e.isFile()) continue;
    // `e.parentPath` is the absolute parent dir (Node 20.12+). Fall back to
    // `e.path` for older Node.
    const parent = e.parentPath ?? e.path;
    const full = join(parent, e.name);
    const rel = relative(INGEST_DIR, full);
    // Skip the SQLite graph DB and its WAL/SHM siblings; those are seeded
    // into D1, not R2.
    const base = e.name;
    if (base === "papyri.db" || base === "papyri.db-wal" || base === "papyri.db-shm") {
      continue;
    }
    // Skip any in-flight ingest staging dirs (`.ingest-tmp-*`) created by
    // the PUT /api/bundle endpoint.
    if (rel.split(sep)[0]?.startsWith(".ingest-tmp-")) continue;
    // Normalise to forward slashes for the R2 key.
    out.push({ full, key: rel.split(sep).join("/") });
  }
  return out;
}

function seedR2() {
  const blobs = listBlobs();
  log(`Uploading ${blobs.length} blob(s) to R2 bucket '${R2_BINDING}'...`);
  let uploaded = 0;
  for (const b of blobs) {
    const wranglerArgs = [
      "r2",
      "object",
      "put",
      `${R2_BINDING}/${b.key}`,
      REMOTE ? "--remote" : "--local",
      "--file",
      b.full,
    ];
    const res = spawnSync("wrangler", wranglerArgs, {
      cwd: VIEWER_DIR,
      // Quiet wrangler down — one line per file is too noisy for a few
      // thousand files. Errors still surface via the exit code.
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (res.status !== 0) die(`wrangler r2 object put failed for ${b.key} (exit ${res.status})`);
    uploaded++;
    if (uploaded % 100 === 0) log(`  ${uploaded}/${blobs.length}`);
  }
  log(`R2 seeded: ${uploaded} object(s).`);
}

// ---------------------------------------------------------------------------

function main() {
  log(`PAPYRI_INGEST_DIR = ${INGEST_DIR}`);
  log(`PAPYRI_INGEST_DB  = ${DB_PATH}`);
  log(`Target            = ${REMOTE ? "REMOTE Cloudflare bindings" : "local miniflare state"}`);
  if (REMOTE) {
    log("WARNING: --remote will write to your Cloudflare account.");
  }
  checkInputs();
  seedD1();
  seedR2();
  log("Done.");
}

main();
