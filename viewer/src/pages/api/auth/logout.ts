import type { APIRoute } from "astro";
import { getAuthDb, SESSION_COOKIE } from "../../../lib/auth-db.ts";

export const prerender = false;

export const POST: APIRoute = async ({ cookies }) => {
  // Revoke the session server-side so the token is dead even if the cookie
  // lingers anywhere, then clear the cookie.
  const token = cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    const auth = await getAuthDb();
    auth.deleteSession(token);
  }

  // Set-Cookie must be set directly on the Response — relying on Astro's
  // cookies.delete() with a raw new Response() can silently drop the header.
  return new Response(JSON.stringify({ success: true, message: "Logged out" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    },
  });
};
