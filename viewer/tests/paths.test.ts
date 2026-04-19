import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { ingestDb } from "../src/lib/paths.ts";

describe("paths", () => {
  let orig: NodeJS.ProcessEnv;
  beforeEach(() => {
    orig = { ...process.env };
    delete process.env.PAPYRI_INGEST_DB;
  });
  afterEach(() => {
    process.env = orig;
  });

  it("ingestDb defaults to ~/.papyri/ingest/papyri.db", () => {
    expect(ingestDb()).toBe(join(homedir(), ".papyri", "ingest", "papyri.db"));
  });

  it("ingestDb respects PAPYRI_INGEST_DB", () => {
    process.env.PAPYRI_INGEST_DB = "/tmp/custom.db";
    expect(ingestDb()).toBe("/tmp/custom.db");
  });
});
