import type { AstroGlobal } from "astro";

export function isAuthenticated(astro: AstroGlobal): boolean {
  const sessionToken = astro.cookies.get("papyri_session_token");
  return !!sessionToken?.value;
}
