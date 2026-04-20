// Trigger the GitHub Actions ingest workflow after a successful upload.
import type { Env } from "./auth.ts";

/**
 * Dispatch the ingest workflow for `pkg`/`ver` via the GitHub Actions API.
 * Requires GITHUB_TOKEN (fine-grained PAT with Actions:write scope),
 * GITHUB_REPO (e.g. "carreau/papyri"), and GITHUB_INGEST_WORKFLOW
 * (workflow file name, e.g. "ingest.yml").
 */
export async function triggerIngest(
  pkg: string,
  ver: string,
  env: Env,
): Promise<void> {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_INGEST_WORKFLOW}/dispatches`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "papyri-upload-api",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: { pkg, ver },
    }),
  });
  if (!resp.ok && resp.status !== 204) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(
      `GitHub dispatch failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }
}
