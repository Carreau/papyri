import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir, ingestDb } from "../src/lib/paths.ts";

describe("paths", () => {
  let orig: NodeJS.ProcessEnv;
  beforeEach(() => {
    orig = { ...process.env };
    delete process.env.PAPYRI_DATA_DIR;
    delete process.env.PAPYRI_INGEST_DB;
  });
  afterEach(() => {
    process.env = orig;
  });

  it("dataDir defaults to ~/.papyri/data", () => {
    expect(dataDir()).toBe(join(homedir(), ".papyri", "data"));
  });

  it("dataDir respects PAPYRI_DATA_DIR", () => {
    process.env.PAPYRI_DATA_DIR = "/tmp/custom/data";
    expect(dataDir()).toBe("/tmp/custom/data");
  });

  it("ingestDb defaults to ~/.papyri/ingest/papyri.db", () => {
    expect(ingestDb()).toBe(join(homedir(), ".papyri", "ingest", "papyri.db"));
  });

  it("ingestDb respects PAPYRI_INGEST_DB", () => {
    process.env.PAPYRI_INGEST_DB = "/tmp/custom.db";
    expect(ingestDb()).toBe("/tmp/custom.db");
  });
});
