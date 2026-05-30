// GET /api/auth/passkey/register-options
//
// Generates WebAuthn registration options for the signed-in user. The returned
// challenge is stored server-side (5-minute TTL) and consumed by
// register-verify.ts. Auth required — guests cannot register passkeys.

import type { APIRoute } from "astro";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { getAuthDb, SESSION_COOKIE } from "../../../../lib/auth-db.ts";
import { getRpConfig } from "../../../../lib/passkey.ts";
import { respond } from "../../../../lib/api-utils.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies }) => {
  const token = cookies.get(SESSION_COOKIE)?.value;
  const auth = await getAuthDb();
  const user = token ? auth.resolveSession(token) : null;
  if (!user) return respond({ error: "authentication required" }, 401);

  const { rpID, rpName } = getRpConfig(request);
  const existing = auth.listPasskeyCredentials(user.id);

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    userID: new TextEncoder().encode(String(user.id)),
    userDisplayName: user.username,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    // Exclude credentials the user already registered so they can't add the
    // same authenticator twice.
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      type: "public-key" as const,
    })),
  });

  auth.storePasskeyChallenge(options.challenge, "register", user.id);

  return respond(options);
};
