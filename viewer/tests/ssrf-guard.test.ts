import { describe, it, expect } from "vitest";
import { isSafeUrl } from "../src/pages/api/inventory.ts";

describe("isSafeUrl SSRF guard", () => {
  it("allows external URLs (https://docs.scipy.org/objects.inv)", () => {
    expect(isSafeUrl("https://docs.scipy.org/objects.inv")).toBe(true);
  });

  it("rejects localhost", () => {
    expect(isSafeUrl("http://localhost/objects.inv")).toBe(false);
  });

  it("rejects loopback (127.0.0.1)", () => {
    expect(isSafeUrl("http://127.0.0.1/objects.inv")).toBe(false);
  });

  it("rejects cloud metadata (169.254.169.254)", () => {
    expect(isSafeUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("rejects private range (192.168.1.1)", () => {
    expect(isSafeUrl("http://192.168.1.1/objects.inv")).toBe(false);
  });

  it("rejects IPv6 loopback (::1)", () => {
    expect(isSafeUrl("http://[::1]/objects.inv")).toBe(false);
  });

  it("rejects private range (10.0.0.1)", () => {
    expect(isSafeUrl("http://10.0.0.1/objects.inv")).toBe(false);
  });

  it("rejects non-http(s) protocols (ftp://)", () => {
    expect(isSafeUrl("ftp://example.com/objects.inv")).toBe(false);
  });

  it("rejects private range 172.16.0.0/12", () => {
    expect(isSafeUrl("http://172.16.0.1/objects.inv")).toBe(false);
    expect(isSafeUrl("http://172.31.255.1/objects.inv")).toBe(false);
  });

  it("rejects IPv6 ULA (fc00::)", () => {
    expect(isSafeUrl("http://[fc00::1]/objects.inv")).toBe(false);
  });

  it("rejects IPv6 ULA (fd00::)", () => {
    expect(isSafeUrl("http://[fd00::1]/objects.inv")).toBe(false);
  });

  it("rejects IPv6 link-local (fe80::)", () => {
    expect(isSafeUrl("http://[fe80::1]/objects.inv")).toBe(false);
  });

  it("rejects 0.0.0.0", () => {
    expect(isSafeUrl("http://0.0.0.0/objects.inv")).toBe(false);
  });

  it("allows 172.15.0.0 (outside private range)", () => {
    expect(isSafeUrl("http://172.15.0.1/objects.inv")).toBe(true);
  });

  it("allows 172.32.0.0 (outside private range)", () => {
    expect(isSafeUrl("http://172.32.0.1/objects.inv")).toBe(true);
  });

  it("rejects malformed URLs", () => {
    expect(isSafeUrl("not a url")).toBe(false);
  });

  it("rejects localhost with different cases", () => {
    expect(isSafeUrl("http://LOCALHOST/objects.inv")).toBe(false);
    expect(isSafeUrl("http://LocalHost/objects.inv")).toBe(false);
  });
});
