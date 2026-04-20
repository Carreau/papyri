// Per-bundle search manifest endpoint. Served dynamically in SSR mode.
import type { APIRoute } from "astro";
import { listModules } from "../../../lib/ir-reader.ts";

export const GET: APIRoute = async ({ params }) => {
  const { pkg, ver } = params;
  try {
    const qualnames = await listModules(pkg!, ver!);
    return new Response(JSON.stringify({ qualnames }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ qualnames: [] }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
};
