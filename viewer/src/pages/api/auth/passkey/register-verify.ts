// POST /api/auth/passkey/register-verify
//
// Body: { response: RegistrationResponseJSON, name?: string }
//   `response` is the raw authenticator output from the browser.
//   `name` is an optional human label ("MacBook Touch ID", "YubiKey 5C").
//
// Verifies the registration, consumes the stored challenge, and persists the
// new credential. Auth required.

import type { APIRoute } from "astro";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { getAuthDb, SESSION_COOKIE } from "../../../../lib/auth-db.ts";
import { getRpConfig } from "../../../../lib/passkey.ts";
import { respond } from "../../../../lib/api-utils.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  const token = cookies.get(SESSION_COOKIE)?.value;
  const auth = await getAuthDb();
  const user = token ? auth.resolveSession(token) : null;
  if (!user) return respond({ ok: false, error: "authentication required" }, 401);

  let body: { response?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  if (!body.response || typeof body.response !== "object") {
    return respond({ ok: false, error: "response is required" }, 400);
  }

  // The response carries the challenge that was presented to the authenticator.
  const clientData = (body.response as { clientDataJSON?: string }).clientDataJSON;
  if (!clientData) return respond({ ok: false, error: "missing clientDataJSON" }, 400);

  let parsedChallenge: string;
  try {
    const decoded = JSON.parse(Buffer.from(clientData, "base64url").toString("utf8")) as {
      challenge?: string;
    };
    if (!decoded.challenge) throw new Error("no challenge");
    parsedChallenge = decoded.challenge;
  } catch {
    return respond({ ok: false, error: "malformed clientDataJSON" }, 400);
  }

  const stored = auth.consumePasskeyChallenge(parsedChallenge, "register");
  if (!stored || stored.userId !== user.id) {
    return respond({ ok: false, error: "invalid or expired challenge" }, 400);
  }

  const { rpID, expectedOrigin } = getRpConfig(request);

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: parsedChallenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    return respond({ ok: false, error: String(err) }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return respond({ ok: false, error: "verification failed" }, 400);
  }

  const {
    credential: { id: credentialID, publicKey, counter, transports },
    credentialBackedUp,
  } = verification.registrationInfo;

  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;

  try {
    auth.createPasskeyCredential(
      user.id,
      credentialID,
      publicKey,
      counter,
      credentialBackedUp,
      transports ?? null,
      name
    );
  } catch {
    // credential_id UNIQUE constraint — authenticator already registered
    return respond({ ok: false, error: "credential already registered" }, 409);
  }

  return respond({ ok: true });
};
