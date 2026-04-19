import { describe, it, expect } from "vitest";
import { filterQualnames } from "../src/lib/search.ts";

describe("filterQualnames", () => {
  const QNs = [
    "numpy.linalg:svd",
    "numpy.linalg:eig",
    "numpy:array",
    "numpy.fft:fft",
    "numpy.random:rand",
  ];

  it("is case-insensitive substring match", () => {
    const hits = filterQualnames(QNs, "LINALG");
    expect(hits.map((h) => h.qualname)).toEqual([
      "numpy.linalg:svd",
      "numpy.linalg:eig",
    ]);
  });

  it("returns an empty array for a blank query", () => {
    expect(filterQualnames(QNs, "")).toEqual([]);
    expect(filterQualnames(QNs, "   ")).toEqual([]);
  });

  it("respects the limit", () => {
    const hits = filterQualnames(QNs, "numpy", 2);
    expect(hits).toHaveLength(2);
  });

  it("returns [] when nothing matches", () => {
    expect(filterQualnames(QNs, "no-such-thing")).toEqual([]);
  });

  it("preserves source order", () => {
    // 'a' appears in all inputs except "numpy.fft:fft".
    const hits = filterQualnames(QNs, "a");
    expect(hits.map((h) => h.qualname)).toEqual([
      "numpy.linalg:svd",
      "numpy.linalg:eig",
      "numpy:array",
      "numpy.random:rand",
    ]);
  });
});
