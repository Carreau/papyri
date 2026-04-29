import type { APIRoute } from "astro";

const PAPYRI_USERNAME = process.env.PAPYRI_USERNAME || "admin";
const PAPYRI_PASSWORD = process.env.PAPYRI_PASSWORD || "password";
const SESSION_TOKEN = "papyri_session_token";

export const POST: APIRoute = async ({ request, cookies }) => {
  const data = await request.json();
  const { username, password } = data;

  if (username === PAPYRI_USERNAME && password === PAPYRI_PASSWORD) {
    const token = Buffer.from(`${username}:${Date.now()}`).toString("base64");
    cookies.set(SESSION_TOKEN, token, {
      httpOnly: true,
      sameSite: "strict",
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
