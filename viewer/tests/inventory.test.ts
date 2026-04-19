import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

// Build a minimal but valid Sphinx v2 inventory payload. Header is four
// plaintext lines followed by the zlib-compressed entry stream.
function buildInventory(
  project: string,
  version: string,
  entries: Array<[string, string, number, string, string]>,
): Buffer {
  const header =
    "# Sphinx inventory version 2\n" +
    `# Project: ${project}\n` +
    `# Version: ${version}\n` +
    "# The remainder of this file is compressed using zlib.\n";
  const body = entries.map((e) => e.join(" ")).join("\n") + "\n";
  return Buffer.concat([Buffer.from(header, "utf8"), deflateSync(body)]);
}

// `inventory.ts` caches the loaded map; re-import fresh per test.
const freshInv = async () => {
  vi.resetModules();
  return await import("../src/lib/inventory.ts");
};

describe("parseInventory", () => {
  it("decodes header + entries from a v2 inventory", async () => {
    const { parseInventory } = await freshInv();
    const buf = buildInventory("numpy", "2.0.0", [
      ["numpy.linspace", "py:function", 1, "reference/generated/numpy.linspace.html", "-"],
      ["numpy.ndarray", "py:class", 1, "reference/generated/numpy.ndarray.html", "-"],
    ]);
    const parsed = parseInventory(buf);
    expect(parsed.project).toBe("numpy");
    expect(parsed.version).toBe("2.0.0");
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      name: "numpy.linspace",
      domain: "py",
      role: "function",
      priority: 1,
      uri: "reference/generated/numpy.linspace.html",
      displayName: "numpy.linspace",
    });
  });

  it("expands `$` suffix in uri to the entry name", async () => {
    const { parseInventory } = await freshInv();
    const buf = buildInventory("python", "3", [
      ["os.path", "py:module", 0, "library/os.path.html#module-$", "-"],
    ]);
    const parsed = parseInventory(buf);
    expect(parsed.entries[0]?.uri).toBe("library/os.path.html#module-os.path");
  });

  it("keeps explicit display names instead of expanding `-`", async () => {
    const { parseInventory } = await freshInv();
    const buf = buildInventory("x", "1", [
      ["foo.bar", "py:function", 1, "api.html#foo.bar", "the bar function"],
    ]);
    const parsed = parseInventory(buf);
    expect(parsed.entries[0]?.displayName).toBe("the bar function");
  });

  it("skips comments and blank lines inside the compressed body", async () => {
    const { parseInventory } = await freshInv();
    const body =
      "# a comment\n" +
      "\n" +
      "foo py:function 1 api.html#foo -\n";
    const header =
      "# Sphinx inventory version 2\n# Project: x\n# Version: 1\n" +
      "# The remainder of this file is compressed using zlib.\n";
    const buf = Buffer.concat([Buffer.from(header, "utf8"), deflateSync(body)]);
    const parsed = parseInventory(buf);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.name).toBe("foo");
  });

  it("rejects a non-v2 header", async () => {
    const { parseInventory } = await freshInv();
    const buf = Buffer.concat([
      Buffer.from(
        "# Sphinx inventory version 1\n# Project: x\n# Version: 1\n# ...\n",
        "utf8",
      ),
      deflateSync(""),
    ]);
    expect(() => parseInventory(buf)).toThrow(/unsupported header/);
  });
});

describe("lookupIntersphinx (cache-driven)", () => {
  let dir: string;
  const origDir = process.env.PAPYRI_INVENTORY_DIR;

  async function seedCache(
    project: string,
    baseUrl: string,
    entries: Array<[string, string, number, string, string]>,
  ) {
    await writeFile(join(dir, `${project}.inv`), buildInventory(project, "1", entries));
    // Update manifest (replace the whole thing for simplicity in tests).
    const manifestPath = join(dir, "registry.json");
    let manifest: Record<string, { url: string }> = {};
    try {
      const fs = await import("node:fs/promises");
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch {
      // fine: first seed
    }
    manifest[project] = { url: baseUrl };
    await writeFile(manifestPath, JSON.stringify(manifest));
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-viewer-inv-"));
    process.env.PAPYRI_INVENTORY_DIR = dir;
  });
  afterEach(async () => {
    if (origDir === undefined) delete process.env.PAPYRI_INVENTORY_DIR;
    else process.env.PAPYRI_INVENTORY_DIR = origDir;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when the cache is empty", async () => {
    const { lookupIntersphinx } = await freshInv();
    expect(lookupIntersphinx("numpy", "numpy.linspace")).toBeNull();
  });

  it("ignores .inv files that aren't in registry.json", async () => {
    // Inventory on disk, no manifest entry for it.
    await writeFile(
      join(dir, "mystery.inv"),
      buildInventory("mystery", "1", [["x.y", "py:function", 1, "y.html", "-"]]),
    );
    await writeFile(join(dir, "registry.json"), "{}");
    const { lookupIntersphinx } = await freshInv();
    expect(lookupIntersphinx("mystery", "x.y")).toBeNull();
  });

  it("resolves a registered project to a full URL", async () => {
    await seedCache("numpy", "https://numpy.org/doc/stable/", [
      ["numpy.linspace", "py:function", 1, "reference/generated/numpy.linspace.html", "-"],
    ]);
    const { lookupIntersphinx } = await freshInv();
    const hit = lookupIntersphinx("numpy", "numpy.linspace");
    expect(hit?.url).toBe(
      "https://numpy.org/doc/stable/reference/generated/numpy.linspace.html",
    );
    expect(hit?.displayName).toBe("numpy.linspace");
  });

  it("appends a missing trailing slash on manifest URLs", async () => {
    await seedCache("x", "https://example.test/docs", [
      ["x.y", "py:function", 1, "y.html", "-"],
    ]);
    // Manually rewrite manifest to strip the trailing slash on the URL.
    await writeFile(
      join(dir, "registry.json"),
      JSON.stringify({ x: { url: "https://example.test/docs" } }),
    );
    const { lookupIntersphinx } = await freshInv();
    expect(lookupIntersphinx("x", "x.y")?.url).toBe(
      "https://example.test/docs/y.html",
    );
  });

  it("matches colon-form paths against dotted inventory names", async () => {
    await seedCache("numpy", "https://numpy.org/doc/stable/", [
      ["numpy.fft.fft", "py:function", 1, "generated/numpy.fft.fft.html", "-"],
    ]);
    const { lookupIntersphinx } = await freshInv();
    // RefInfo.path can carry a colon; normalize to dots on fallback.
    expect(lookupIntersphinx("numpy", "numpy.fft:fft")).not.toBeNull();
  });

  it("prefers higher-priority entries when names collide", async () => {
    await seedCache("numpy", "https://numpy.org/doc/stable/", [
      ["numpy.fft", "py:module", -1, "hidden.html", "-"],
      ["numpy.fft", "py:module", 1, "visible.html", "-"],
    ]);
    const { lookupIntersphinx } = await freshInv();
    expect(lookupIntersphinx("numpy", "numpy.fft")?.uri).toBe("visible.html");
  });
});
