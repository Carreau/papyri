import type { APIRoute } from "astro";
import { isSecureRequest } from "../../../lib/surface.ts";

const PAPYRI_USERNAME = process.env.PAPYRI_USERNAME || "admin";
const PAPYRI_PASSWORD = process.env.PAPYRI_PASSWORD || "password";
const SESSION_TOKEN = "papyri_session_token";

export const POST: APIRoute = async ({ request, cookies }) => {
  const data = await request.json();
  const { username, password } = data;

  if (username === PAPYRI_USERNAME && password === PAPYRI_PASSWORD) {
    const token = Buffer.from(`${username}:${Date.now()}`).toString("base64");

    // Keep the cookie host-only: NO Domain attribute. With the admin/docs
    // domain split this is the load-bearing line — if we ever added a
    // shared parent Domain (e.g. `Domain=example.com`), bundle-injected
    // XSS on the docs subdomain could read this cookie. Default scope
    // (host-only) means only the admin host receives it.
    //
    // `Secure` follows the request transport: HTTPS -> set it (prod),
    // HTTP -> leave it off (local two-port dev would otherwise have its
    // cookie silently dropped by the browser).
    cookies.set(SESSION_TOKEN, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: isSecureRequest(request),
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: "/",
    });

    return new Response(JSON.stringify({ success: true, message: "Login successful" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ success: false, message: "Invalid credentials" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
};
