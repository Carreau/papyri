// SSR endpoint: runtime + bindings probe.
//
// Exists primarily to prove that the Cloudflare Workers build boots
// under `wrangler dev` (M9.1). Reports which adapter is serving the
// request and whether the D1 / R2 bindings are present. Cheap enough
// to leave on in production as a liveness probe.
//
// Response shape:
//   { adapter: "cloudflare" | "node",
//     graphDb: boolean,    // env.GRAPH_DB binding is wired
//     blobs:   boolean }   // env.BLOBS binding is wired
//
// Notes:
// - Astro v6 + @astrojs/cloudflare removed `Astro.locals.runtime.env`;
//   the env is now sourced from `import { env } from "cloudflare:workers"`.
//   That import only resolves inside the Workers runtime — we use a
//   dynamic, /* @vite-ignore */-marked import so the Node SSR build
//   doesn't try to resolve it at bundle time.
// - We only check binding presence here, never call into them. M9.2
//   wires the bindings into actual data paths.

import type { APIRoute } from "astro";

export const prerender = false;

interface RuntimeEnv {
  GRAPH_DB?: unknown;
  BLOBS?: unknown;
}

async function loadCfEnv(): Promise<RuntimeEnv | null> {
  try {
    // Vite's static analysis would otherwise fail under the Node adapter,
    // where the `cloudflare:workers` virtual module doesn't exist.
    const mod = (await import(/* @vite-ignore */ "cloudflare:workers")) as {
      env?: RuntimeEnv;
    };
    return mod.env ?? null;
  } catch {
    return null;
  }
}

export const GET: APIRoute = async () => {
  const env = await loadCfEnv();
  const adapter = env ? "cloudflare" : "node";
  const body = JSON.stringify({
    adapter,
    graphDb: !!env?.GRAPH_DB,
    blobs: !!env?.BLOBS,
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
};
