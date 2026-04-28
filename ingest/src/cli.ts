#!/usr/bin/env node
/**
 * papyri-ingest CLI
 *
 * Usage:
 *   papyri-ingest <bundle-dir> [--check] [--ingest-dir <path>]
 *
 * <bundle-dir>   Path to a gen bundle produced by `papyri gen`
 *                (e.g. ~/.papyri/data/numpy_2.3.5).
 *
 * Options:
 *   --check        Skip qualnames that don't pass a basic identifier validity
 *                  check (mirrors papyri ingest --check).
 *   --ingest-dir   Override the ingest store directory. Defaults to
 *                  PAPYRI_INGEST_DIR env var or ~/.papyri/ingest.
 *   --help, -h     Print this help message.
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { Ingester } from "./ingest.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    check: { type: "boolean", default: false },
    "ingest-dir": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  console.log(
    [
      "papyri-ingest — ingest a papyri gen bundle into the cross-link graph store",
      "",
      "Usage:",
      "  papyri-ingest <bundle-dir> [--check] [--ingest-dir <path>]",
      "",
      "Arguments:",
      "  <bundle-dir>   Path to a gen bundle produced by `papyri gen`.",
      "",
      "Options:",
      "  --check        Skip qualnames that fail a basic identifier check.",
      "  --ingest-dir   Override the ingest store directory.",
      "                 Default: PAPYRI_INGEST_DIR or ~/.papyri/ingest",
      "  -h, --help     Show this help.",
    ].join("\n"),
  );
  process.exit(0);
}

const bundleArg = positionals[0];
if (!bundleArg) {
  console.error("error: <bundle-dir> is required");
  process.exit(1);
}

const bundlePath = resolve(bundleArg);

if (!existsSync(bundlePath)) {
  console.error(`error: bundle directory does not exist: ${bundlePath}`);
  process.exit(1);
}

if (!statSync(bundlePath).isDirectory()) {
  console.error(`error: not a directory: ${bundlePath}`);
  process.exit(1);
}

const ingestDir = values["ingest-dir"];
const check = values.check ?? false;

const ingester = new Ingester({ ingestDir, check });

const start = performance.now();
try {
  await ingester.ingest(bundlePath, { check });
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
} finally {
  await ingester.close();
}

const elapsed = ((performance.now() - start) / 1000).toFixed(2);
console.log(`Ingesting done in ${elapsed}s`);
