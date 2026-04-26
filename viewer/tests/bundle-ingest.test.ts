import { describe, it, expect } from "vitest";
import { isSafeSegment } from "../src/lib/paths.ts";

describe("isSafeSegment", () => {
  it("accepts plain package names", () => {
    expect(isSafeSegment("numpy")).toBe(true);
    expect(isSafeSegment("papyri")).toBe(true);
    expect(isSafeSegment("scipy")).toBe(true);
  });

  it("accepts names with dots, dashes, and underscores", () => {
    expect(isSafeSegment("my-package")).toBe(true);
    expect(isSafeSegment("my_package")).toBe(true);
    expect(isSafeSegment("0.0.8")).toBe(true);
    expect(isSafeSegment("2.3.5")).toBe(true);
    expect(isSafeSegment("1.0.0.post1")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isSafeSegment("")).toBe(false);
  });

  it("rejects path traversal sequences", () => {
    expect(isSafeSegment("..")).toBe(false);
    expect(isSafeSegment("../etc/passwd")).toBe(false);
    expect(isSafeSegment("foo/bar")).toBe(false);
  });

  it("rejects leading dots", () => {
    expect(isSafeSegment(".hidden")).toBe(false);
    expect(isSafeSegment(".ingest-tmp-abc")).toBe(false);
  });

  it("rejects shell-special and whitespace characters", () => {
    expect(isSafeSegment("foo;bar")).toBe(false);
    expect(isSafeSegment("foo bar")).toBe(false);
    expect(isSafeSegment("foo$bar")).toBe(false);
    expect(isSafeSegment("foo`bar")).toBe(false);
    expect(isSafeSegment("foo\nbar")).toBe(false);
  });
});
