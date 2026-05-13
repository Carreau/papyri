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
