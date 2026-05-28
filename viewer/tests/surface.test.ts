import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  decideRoute,
  getSurface,
  getSurfaceForHost,
  isLocalHost,
  isSecureRequest,
  originForHost,
  routeRequiresSession,
  routeSurface,
  splitEnabled,
} from "../src/lib/surface.ts";

describe("surface env", () => {
  let orig: NodeJS.ProcessEnv;
  beforeEach(() => {
    orig = { ...process.env };
    delete process.env.PAPYRI_DOCS_HOST;
    delete process.env.PAPYRI_ADMIN_HOST;
  });
  afterEach(() => {
    process.env = orig;
  });

  it("splitEnabled is false with no env vars", () => {
    expect(splitEnabled()).toBe(false);
  });

  it("splitEnabled turns on with either var set", () => {
    process.env.PAPYRI_DOCS_HOST = "docs.example.com";
    expect(splitEnabled()).toBe(true);
    delete process.env.PAPYRI_DOCS_HOST;
    process.env.PAPYRI_ADMIN_HOST = "admin.example.com";
    expect(splitEnabled()).toBe(true);
  });

  it("blank env vars do not enable the split", () => {
    process.env.PAPYRI_DOCS_HOST = "   ";
    process.env.PAPYRI_ADMIN_HOST = "";
    expect(splitEnabled()).toBe(false);
  });

  it("getSurfaceForHost returns docs when split is off", () => {
    expect(getSurfaceForHost("anything")).toBe("docs");
    expect(getSurfaceForHost(null)).toBe("docs");
  });

  it("getSurfaceForHost matches the admin host", () => {
    process.env.PAPYRI_DOCS_HOST = "docs.example.com";
    process.env.PAPYRI_ADMIN_HOST = "admin.example.com";
    expect(getSurfaceForHost("admin.example.com")).toBe("admin");
    expect(getSurfaceForHost("docs.example.com")).toBe("docs");
    expect(getSurfaceForHost("ADMIN.EXAMPLE.COM")).toBe("admin");
  });

  it("unknown host defaults to docs (admin stays hidden)", () => {
    process.env.PAPYRI_ADMIN_HOST = "admin.example.com";
    expect(getSurfaceForHost("evil.example.com")).toBe("docs");
    expect(getSurfaceForHost(null)).toBe("docs");
  });

  it("getSurface reads X-Forwarded-Host first, then Host", () => {
    process.env.PAPYRI_ADMIN_HOST = "admin.example.com";
    const r1 = new Request("http://internal/", { headers: { host: "internal" } });
    expect(getSurface(r1)).toBe("docs");
    const r2 = new Request("http://internal/", {
      headers: { host: "internal", "x-forwarded-host": "admin.example.com" },
    });
    expect(getSurface(r2)).toBe("admin");
  });
});

describe("routeSurface", () => {
  it("classifies every /admin/* path as admin", () => {
    for (const p of [
      "/admin",
      "/admin/",
      "/admin/login",
      "/admin/nodes",
      "/admin/nodes/paragraph",
      "/admin/ir-stats",
    ]) {
      expect(routeSurface(p)).toBe("admin");
    }
  });

  it("classifies every /api/admin/* path as admin", () => {
    for (const p of [
      "/api/admin/bundle",
      "/api/admin/clear",
      "/api/admin/clear-raw",
      "/api/admin/reingest",
      "/api/admin/inventory",
      "/api/admin/stats",
      "/api/admin/nodes.json",
      "/api/admin/ir-stats.json",
      "/api/admin/auth/login",
      "/api/admin/auth/logout",
    ]) {
      expect(routeSurface(p)).toBe("admin");
    }
  });

  it("classifies everything else as docs", () => {
    for (const p of [
      "/",
      "/project/numpy/2.0.0/",
      "/project/numpy/2.0.0/docs/whatsnew/",
      "/text-search/",
      "/api/bundles.json",
      "/api/search.json",
      "/api/text-search.json",
      "/api/health.json",
      "/api/numpy/2.0.0/nodes.json",
      "/api/numpy/2.0.0/raw.json",
      "/assets/project/numpy/2.0.0/img.png",
    ]) {
      expect(routeSurface(p)).toBe("docs");
    }
  });
});

describe("routeRequiresSession", () => {
  it("admin-no-session prefixes bypass the cookie check", () => {
    for (const p of [
      "/admin/login",
      "/admin/login/",
      "/api/admin/auth/login",
      "/api/admin/auth/logout",
      "/api/admin/bundle",
      "/api/admin/bundle?hash=abc",
    ]) {
      // Strip query so the test mirrors how middleware checks pathname only.
      const pathname = p.split("?")[0];
      expect(routeRequiresSession(pathname)).toBe(false);
    }
  });

  it("other /admin/* and /api/admin/* paths need a session", () => {
    for (const p of [
      "/admin",
      "/admin/",
      "/admin/nodes",
      "/admin/ir-stats",
      "/api/admin/clear",
      "/api/admin/clear-raw",
      "/api/admin/reingest",
      "/api/admin/inventory",
      "/api/admin/stats",
      "/api/admin/nodes.json",
      "/api/admin/ir-stats.json",
    ]) {
      expect(routeRequiresSession(p)).toBe(true);
    }
  });

  it("docs routes never need a session", () => {
    for (const p of ["/", "/project/numpy/2.0.0/", "/api/bundles.json", "/text-search/"]) {
      expect(routeRequiresSession(p)).toBe(false);
    }
  });
});

describe("decideRoute", () => {
  it("split off: admin path still needs session, redirects to /admin/login", () => {
    expect(
      decideRoute({ pathname: "/admin", surface: "docs", hasSession: false, splitOn: false })
    ).toEqual({ kind: "redirect", to: "/admin/login" });
    expect(
      decideRoute({ pathname: "/admin", surface: "docs", hasSession: true, splitOn: false })
    ).toEqual({ kind: "allow" });
    expect(
      decideRoute({ pathname: "/", surface: "docs", hasSession: false, splitOn: false })
    ).toEqual({ kind: "allow" });
  });

  it("split off: admin API without session is 403", () => {
    expect(
      decideRoute({
        pathname: "/api/admin/clear",
        surface: "docs",
        hasSession: false,
        splitOn: false,
      })
    ).toEqual({ kind: "deny", status: 403 });
  });

  it("split on: admin route on docs host is 404", () => {
    expect(
      decideRoute({ pathname: "/admin", surface: "docs", hasSession: true, splitOn: true })
    ).toEqual({ kind: "deny", status: 404 });
    expect(
      decideRoute({
        pathname: "/admin/login",
        surface: "docs",
        hasSession: false,
        splitOn: true,
      })
    ).toEqual({ kind: "deny", status: 404 });
    expect(
      decideRoute({
        pathname: "/api/admin/bundle",
        surface: "docs",
        hasSession: false,
        splitOn: true,
      })
    ).toEqual({ kind: "deny", status: 404 });
  });

  it("split on: docs route on admin host is 404", () => {
    expect(
      decideRoute({ pathname: "/", surface: "admin", hasSession: false, splitOn: true })
    ).toEqual({ kind: "deny", status: 404 });
    expect(
      decideRoute({
        pathname: "/project/numpy/2.0.0/",
        surface: "admin",
        hasSession: false,
        splitOn: true,
      })
    ).toEqual({ kind: "deny", status: 404 });
    expect(
      decideRoute({
        pathname: "/api/bundles.json",
        surface: "admin",
        hasSession: false,
        splitOn: true,
      })
    ).toEqual({ kind: "deny", status: 404 });
  });

  it("split on: admin route on admin host still needs session", () => {
    expect(
      decideRoute({ pathname: "/admin", surface: "admin", hasSession: false, splitOn: true })
    ).toEqual({ kind: "redirect", to: "/admin/login" });
    expect(
      decideRoute({
        pathname: "/api/admin/clear",
        surface: "admin",
        hasSession: false,
        splitOn: true,
      })
    ).toEqual({ kind: "deny", status: 403 });
    expect(
      decideRoute({ pathname: "/admin", surface: "admin", hasSession: true, splitOn: true })
    ).toEqual({ kind: "allow" });
  });

  it("split on: login + upload + auth API bypass session check on admin host", () => {
    expect(
      decideRoute({
        pathname: "/admin/login",
        surface: "admin",
        hasSession: false,
        splitOn: true,
      })
    ).toEqual({ kind: "allow" });
    expect(
      decideRoute({
        pathname: "/api/admin/bundle",
        surface: "admin",
        hasSession: false,
        splitOn: true,
      })
    ).toEqual({ kind: "allow" });
    expect(
      decideRoute({
        pathname: "/api/admin/auth/login",
        surface: "admin",
        hasSession: false,
        splitOn: true,
      })
    ).toEqual({ kind: "allow" });
  });

  it("split on: docs surface serves docs routes without session", () => {
    expect(
      decideRoute({ pathname: "/", surface: "docs", hasSession: false, splitOn: true })
    ).toEqual({ kind: "allow" });
    expect(
      decideRoute({
        pathname: "/project/numpy/2.0.0/",
        surface: "docs",
        hasSession: false,
        splitOn: true,
      })
    ).toEqual({ kind: "allow" });
    expect(
      decideRoute({ pathname: "/text-search/", surface: "docs", hasSession: false, splitOn: true })
    ).toEqual({ kind: "allow" });
  });
});

describe("isLocalHost / originForHost", () => {
  it("treats null / missing host as local (so dev gets no Secure flag)", () => {
    expect(isLocalHost(null)).toBe(true);
  });

  it("detects localhost variants", () => {
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("localhost:4321")).toBe(true);
    expect(isLocalHost("127.0.0.1")).toBe(true);
    expect(isLocalHost("127.0.0.1:8080")).toBe(true);
    expect(isLocalHost("::1")).toBe(true);
    expect(isLocalHost("admin.example.com")).toBe(false);
  });

  it("originForHost copies scheme from currentUrl when given", () => {
    expect(originForHost("docs.example.com", new URL("https://x/"))).toBe(
      "https://docs.example.com"
    );
    expect(originForHost("docs.example.com", new URL("http://x/"))).toBe(
      "http://docs.example.com"
    );
  });

  it("originForHost defaults to https for remote, http for local", () => {
    expect(originForHost("docs.example.com")).toBe("https://docs.example.com");
    expect(originForHost("localhost:4321")).toBe("http://localhost:4321");
  });
});

describe("isSecureRequest", () => {
  it("returns false for plain http URL", () => {
    expect(isSecureRequest(new Request("http://admin.local/x"))).toBe(false);
  });

  it("returns true for https URL", () => {
    expect(isSecureRequest(new Request("https://admin.example.com/x"))).toBe(true);
  });

  it("honours x-forwarded-proto over the request URL", () => {
    const r = new Request("http://internal/x", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(isSecureRequest(r)).toBe(true);
  });

  it("handles comma-separated x-forwarded-proto chains", () => {
    const r = new Request("http://internal/x", {
      headers: { "x-forwarded-proto": "https, http" },
    });
    expect(isSecureRequest(r)).toBe(true);
  });
});
