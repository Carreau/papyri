import type { APIRoute } from "astro";
import { getAuthDb, SESSION_COOKIE, SESSION_TTL_SECONDS } from "../../../lib/auth-db.ts";
import { respond } from "../../../lib/api-utils.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  let data: { username?: unknown; password?: unknown };
  try {
    data = await request.json();
  } catch {
    return respond({ success: false, message: "Invalid request body" }, 400);
  }

  const { username, password } = data;
  if (typeof username !== "string" || typeof password !== "string") {
    return respond({ success: false, message: "Username and password are required" }, 400);
  }

  const auth = await getAuthDb();
  const user = await auth.verifyLogin(username, password);
  if (!user) {
    // Fail closed: unknown user, wrong password, or no users configured at all
    // all return the same generic 401 (verifyLogin is constant-time).
    return respond({ success: false, message: "Invalid credentials" }, 401);
  }

  const { token } = auth.createSession(user.id);
  cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });

  return respond({ success: true, message: "Login successful" });
};
