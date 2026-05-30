// POST /api/auth/passkey/login-verify
//
// Verifies an authenticator assertion and issues a session cookie on success.
// No prior session required — this completes the passkey login flow.

import type { APIRoute } from "astro";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { getAuthDb, SESSION_COOKIE, SESSION_TTL_SECONDS } from "../../../../lib/auth-db.ts";
import { getRpConfig } from "../../../../lib/passkey.ts";
import { respond } from "../../../../lib/api-utils.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: { response?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  if (!body.response || typeof body.response !== "object") {
    return respond({ ok: false, error: "response is required" }, 400);
  }

  const resp = body.response as {
    id?: string;
    rawId?: string;
    clientDataJSON?: string;
  };

  if (!resp.clientDataJSON) return respond({ ok: false, error: "missing clientDataJSON" }, 400);

  let parsedChallenge: string;
  try {
    const decoded = JSON.parse(Buffer.from(resp.clientDataJSON, "base64url").toString("utf8")) as {
      challenge?: string;
    };
    if (!decoded.challenge) throw new Error("no challenge");
    parsedChallenge = decoded.challenge;
  } catch {
    return respond({ ok: false, error: "malformed clientDataJSON" }, 400);
  }

  const auth = await getAuthDb();

  const stored = auth.consumePasskeyChallenge(parsedChallenge, "authenticate");
  if (!stored) return respond({ ok: false, error: "invalid or expired challenge" }, 400);

  const credentialId = resp.id ?? resp.rawId;
  if (!credentialId) return respond({ ok: false, error: "missing credential id" }, 400);

  const record = auth.getPasskeyCredentialByCredentialId(credentialId);
  if (!record) return respond({ ok: false, error: "unknown credential" }, 400);

  const { rpID, expectedOrigin } = getRpConfig(request);

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: parsedChallenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: record.credential.credential_id,
        publicKey: new Uint8Array(record.credential.public_key),
        counter: record.credential.counter,
        transports: (record.credential.transports ?? undefined) as
          | Parameters<typeof verifyAuthenticationResponse>[0]["credential"]["transports"]
          | undefined,
      },
      requireUserVerification: false,
    });
  } catch (err) {
    return respond({ ok: false, error: String(err) }, 400);
  }

  if (!verification.verified) {
    return respond({ ok: false, error: "verification failed" }, 400);
  }

  const { newCounter, credentialBackedUp } = verification.authenticationInfo;
  auth.updatePasskeyCounter(record.credential.credential_id, newCounter, credentialBackedUp);

  const { token } = auth.createSession(record.user.id);
  cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });

  return respond({ ok: true });
};
