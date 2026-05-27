import type { APIRoute } from "astro";

export const POST: APIRoute = async () => {
  // Set-Cookie must be set directly on the Response — relying on Astro's
  // cookies.delete() with a raw new Response() can silently drop the header.
  return new Response(JSON.stringify({ success: true, message: "Logged out" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": "papyri_session_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    },
  });
};
