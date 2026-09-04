import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { AuthDb } from "../src/lib/auth-db.ts";
import {
  makePreviewRef,
  parsePreviewId,
  parsePreviewPath,
  previewBase,
  previewDir,
  previewId,
  previewRoot,
} from "../src/lib/preview.ts";
import { linkForBundle, linkForQualname, viewerRoute } from "../src/lib/links.ts";
import { previewContext, runInRequestContext } from "../src/lib/request-context.ts";
import { urlBase } from "../src/lib/url-base.ts";

const REF = makePreviewRef("numpy", "numpy", 42)!;

describe("preview identity", () => {
  it("normalises owner/repo case so one PR is one namespace", () => {
    expect(previewId(makePreviewRef("NumPy", "NumPy", 7)!)).toBe("numpy/numpy#7");
    expect(previewId(makePreviewRef("numpy", "numpy", "7")!)).toBe("numpy/numpy#7");
  });

  it("rejects components that are not a real owner/repo/PR", () => {
    expect(makePreviewRef("..", "numpy", 1)).toBeNull();
    expect(makePreviewRef("numpy", "..", 1)).toBeNull();
    expect(makePreviewRef("numpy", ".", 1)).toBeNull();
    expect(makePreviewRef("num/py", "numpy", 1)).toBeNull();
    expect(makePreviewRef("numpy", "num/py", 1)).toBeNull();
    expect(makePreviewRef("numpy", "numpy", 0)).toBeNull();
    expect(makePreviewRef("numpy", "numpy", -3)).toBeNull();
    expect(makePreviewRef("numpy", "numpy", "1e3")).toBeNull();
    expect(makePreviewRef("", "numpy", 1)).toBeNull();
  });

  it("round-trips through the id form", () => {
    expect(parsePreviewId(previewId(REF))).toEqual(REF);
    expect(parsePreviewId("numpy/numpy")).toBeNull();
    expect(parsePreviewId("numpy/numpy#no")).toBeNull();
  });

  it("keeps every storage directory under the preview root", () => {
    const dir = previewDir(REF);
    expect(dir.startsWith(previewRoot())).toBe(true);
    expect(dir.endsWith("/numpy/numpy/pr42")).toBe(true);
  });
});

describe("preview URL parsing", () => {
  it("splits the namespace prefix off the route", () => {
    expect(parsePreviewPath("/preview/numpy/numpy/42/project/numpy/2.3.5/")).toEqual({
      ref: REF,
      rest: "/project/numpy/2.3.5/",
    });
  });

  it("maps the preview root to the site root", () => {
    expect(parsePreviewPath("/preview/numpy/numpy/42/")).toEqual({ ref: REF, rest: "/" });
  });

  it("refuses malformed and non-preview paths", () => {
    expect(parsePreviewPath("/project/numpy/2.3.5/")).toBeNull();
    expect(parsePreviewPath("/preview/numpy/numpy")).toBeNull();
    expect(parsePreviewPath("/preview/numpy/numpy/notanumber/")).toBeNull();
    expect(parsePreviewPath("/preview/../../etc/passwd")).toBeNull();
  });
});

describe("link building inside a preview", () => {
  it("leaves URLs alone outside a preview", () => {
    expect(urlBase()).toBe("");
    expect(linkForBundle("numpy", "2.3.5")).toBe("/project/numpy/2.3.5/");
  });

  it("prefixes every URL with the preview base", async () => {
    await runInRequestContext(previewContext(REF), async () => {
      expect(urlBase()).toBe("/preview/numpy/numpy/42");
      expect(linkForBundle("numpy", "2.3.5")).toBe("/preview/numpy/numpy/42/project/numpy/2.3.5/");
      expect(linkForQualname("numpy", "2.3.5", "numpy:sum")).toBe(
        "/preview/numpy/numpy/42/project/numpy/2.3.5/numpy$sum/"
      );
      expect(viewerRoute("home")).toBe("/preview/numpy/numpy/42/");
    });
  });

  it("does not leak the base to a later request", () => {
    expect(previewBase(REF)).toBe("/preview/numpy/numpy/42");
    expect(linkForBundle("numpy", "2.3.5")).toBe("/project/numpy/2.3.5/");
  });
});

describe("preview registry", () => {
  let auth: AuthDb;

  beforeEach(() => {
    auth = new AuthDb(new Database(":memory:"));
  });
  afterEach(() => auth.close());

  it("records, renews and drops a preview", () => {
    auth.recordPreview("numpy/numpy#42", "numpy", "numpy", 42, 3600);
    const first = auth.getPreview("numpy/numpy#42");
    expect(first?.pr).toBe(42);

    auth.recordPreview("numpy/numpy#42", "numpy", "numpy", 42, 7200);
    const renewed = auth.getPreview("numpy/numpy#42");
    // One row, expiry pushed out.
    expect(auth.listPreviews()).toHaveLength(1);
    expect(renewed!.expires_at).toBeGreaterThan(first!.expires_at);

    expect(auth.deletePreview("numpy/numpy#42")).toBe(true);
    expect(auth.deletePreview("numpy/numpy#42")).toBe(false);
    expect(auth.getPreview("numpy/numpy#42")).toBeNull();
  });

  it("lists only previews past their TTL", () => {
    auth.recordPreview("a/a#1", "a", "a", 1, -10);
    auth.recordPreview("b/b#2", "b", "b", 2, 3600);
    expect(auth.listExpiredPreviews().map((p) => p.id)).toEqual(["a/a#1"]);
  });
});

describe("trusted publishers", () => {
  let auth: AuthDb;

  beforeEach(() => {
    auth = new AuthDb(new Database(":memory:"));
    auth.createProject("numpy");
    auth.createProject("scipy");
  });
  afterEach(() => auth.close());

  it("maps a repository to the projects it may publish", () => {
    const numpy = auth.getProjectByName("numpy")!;
    auth.addOidcPublisher(numpy.id, "numpy/numpy");
    expect(auth.projectsForRepository("numpy/numpy", ".github/workflows/docs.yml")).toEqual([
      "numpy",
    ]);
    expect(auth.projectsForRepository("evil/numpy", ".github/workflows/docs.yml")).toEqual([]);
  });

  it("matches the repository case-insensitively", () => {
    const numpy = auth.getProjectByName("numpy")!;
    auth.addOidcPublisher(numpy.id, "NumPy/NumPy");
    expect(auth.projectsForRepository("numpy/numpy", "any.yml")).toEqual(["numpy"]);
  });

  it("narrows to one workflow file when one is registered", () => {
    const scipy = auth.getProjectByName("scipy")!;
    auth.addOidcPublisher(scipy.id, "scipy/scipy", ".github/workflows/docs.yml");
    expect(auth.projectsForRepository("scipy/scipy", ".github/workflows/docs.yml")).toEqual([
      "scipy",
    ]);
    expect(auth.projectsForRepository("scipy/scipy", ".github/workflows/other.yml")).toEqual([]);
  });

  it("is idempotent and removable", () => {
    const numpy = auth.getProjectByName("numpy")!;
    auth.addOidcPublisher(numpy.id, "numpy/numpy");
    auth.addOidcPublisher(numpy.id, "numpy/numpy");
    expect(auth.listOidcPublishers()).toHaveLength(1);
    const [row] = auth.listOidcPublishers();
    expect(row!.project).toBe("numpy");
    expect(auth.deleteOidcPublisher(row!.id)).toBe(true);
    expect(auth.listOidcPublishers()).toHaveLength(0);
  });

  it("drops publishers with their project", () => {
    const numpy = auth.getProjectByName("numpy")!;
    auth.addOidcPublisher(numpy.id, "numpy/numpy");
    auth.deleteProject(numpy.id);
    expect(auth.listOidcPublishers()).toHaveLength(0);
  });
});
