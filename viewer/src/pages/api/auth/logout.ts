import type { APIRoute } from "astro";

export const POST: APIRoute = async ({ cookies }) => {
  cookies.delete("papyri_session_token", { path: "/" });

  return new Response(JSON.stringify({ success: true, message: "Logged out" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
