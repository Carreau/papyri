import type { APIRoute } from "astro";
import { isSecureRequest } from "../../../../lib/surface.ts";

export const POST: APIRoute = async ({ request }) => {
  // Set-Cookie must be set directly on the Response — relying on Astro's
  // cookies.delete() with a raw new Response() can silently drop the header.
  // Mirror the Secure flag from login.ts so the browser clears the right
  // cookie (a Set-Cookie with a different Secure flag is a separate cookie).
  const secure = isSecureRequest(request) ? "Secure; " : "";
  return new Response(JSON.stringify({ success: true, message: "Logged out" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `papyri_session_token=; Path=/; HttpOnly; ${secure}SameSite=Strict; Max-Age=0`,
    },
  });
};
