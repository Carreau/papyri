// Guards on the bundle-asset route. These bytes are uploader-supplied, so
// the extension allow-list and the segment validation are security controls,
// not conveniences. Both reject before the blob store is touched, which is
// what makes them testable without a backend.
import { describe, it, expect } from "vitest";
import { GET } from "../src/pages/assets/project/[pkg]/[ver]/[...asset].ts";

type Params = Record<string, string | undefined>;

function get(params: Params): Promise<Response> {
  // The route only reads `params`; the rest of the APIContext is unused.
  return Promise.resolve(
    GET({ params } as unknown as Parameters<typeof GET>[0])
  ) as Promise<Response>;
}

describe("asset route allow-list", () => {
  for (const ext of ["html", "htm", "js", "css", "json", "txt", "pdf", "exe", "wasm"]) {
    it(`refuses to serve .${ext}`, async () => {
      const res = await get({ pkg: "numpy", ver: "2.3.5", asset: `payload.${ext}` });
      expect(res.status).toBe(404);
    });
  }

  it("refuses an extensionless asset", async () => {
    const res = await get({ pkg: "numpy", ver: "2.3.5", asset: "payload" });
    expect(res.status).toBe(404);
  });

  it("refuses a double extension whose tail is not allowed", async () => {
    const res = await get({ pkg: "numpy", ver: "2.3.5", asset: "fig.png.html" });
    expect(res.status).toBe(404);
  });
});

describe("asset route segment validation", () => {
  it("rejects a traversal attempt in pkg with 400, not a 500", async () => {
    const res = await get({ pkg: "../../etc", ver: "1.0", asset: "x.png" });
    expect(res.status).toBe(400);
  });

  it("rejects a traversal attempt in ver with 400", async () => {
    const res = await get({ pkg: "numpy", ver: "../..", asset: "x.png" });
    expect(res.status).toBe(400);
  });

  it("404s on missing params", async () => {
    const res = await get({ pkg: "numpy", ver: "2.3.5", asset: undefined });
    expect(res.status).toBe(404);
  });
});
