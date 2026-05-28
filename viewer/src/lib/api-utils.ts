// Shared utilities for SSR API endpoints.
//
// Centralises the JSON response constructor so every endpoint produces the
// same Content-Type header and callers don't hand-roll `new Response(...)`.

/**
 * Build a JSON API response.  Merges `extra` headers (e.g. WWW-Authenticate)
 * after the Content-Type default so callers can override when necessary.
 */
export function respond(
  body: object,
  status: number = 200,
  extra?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

/**
 * Hex-encoded SHA-256 of `bytes`. Uses Web Crypto (`crypto.subtle`), a portable
 * Web API with no backend-specific dependency. Matches
 * `hashlib.sha256(...).hexdigest()` on the `papyri upload` client side.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
