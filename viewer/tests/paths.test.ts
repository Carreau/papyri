import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { ingestDb, isSafeSegment } from "../src/lib/paths.ts";

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

describe("isSafeSegment", () => {
  it("accepts plain package name", () => {
    expect(isSafeSegment("numpy")).toBe(true);
  });

  it("accepts plain version", () => {
    expect(isSafeSegment("2.3.5")).toBe(true);
  });

  it("accepts PEP 440 local version with +", () => {
    expect(isSafeSegment("1.18.0.dev0+git20260420.763dbc8")).toBe(true);
  });

  it("accepts version with pre-release and local", () => {
    expect(isSafeSegment("1.0.0a1+local")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isSafeSegment("")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isSafeSegment("../etc/passwd")).toBe(false);
  });

  it("rejects string starting with dot", () => {
    expect(isSafeSegment(".hidden")).toBe(false);
  });

  it("rejects string with slash", () => {
    expect(isSafeSegment("foo/bar")).toBe(false);
  });

  it("rejects string with shell metacharacter", () => {
    expect(isSafeSegment("foo;bar")).toBe(false);
  });
});
