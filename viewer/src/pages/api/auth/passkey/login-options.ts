// POST /api/auth/passkey/login-options
//
// Generates WebAuthn authentication options. No session required — this is
// the unauthenticated entry point for passkey login.
//
// `allowCredentials` is empty so any discoverable credential stored on the
// authenticator is accepted (passkey / resident-key flow).

import type { APIRoute } from "astro";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { getAuthDb } from "../../../../lib/auth-db.ts";
import { getRpConfig } from "../../../../lib/passkey.ts";
import { respond } from "../../../../lib/api-utils.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const { rpID } = getRpConfig(request);
  const auth = await getAuthDb();

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    allowCredentials: [],
  });

  auth.storePasskeyChallenge(options.challenge, "authenticate", null);

  return respond(options);
};
