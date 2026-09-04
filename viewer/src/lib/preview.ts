/**
 * PR previews — per-pull-request documentation namespaces.
 *
 * A preview is a throwaway, fully isolated copy of the storage triple
 * (`BlobStore` + `GraphDb` + `RawStore`) living under its own directory:
 *
 *   <preview-root>/<owner>/<repo>/pr<N>/
 *     papyri.db          SQLite graph DB (same migrations as the main store)
 *     <pkg>/<ver>/...    blobs
 *     _raw/<pkg>/<ver>.papyri.gz
 *
 * Isolation is the whole point: a preview never writes into the main graph, so
 * it can never pollute cross-package backrefs or the global search index, and
 * dropping it when the PR merges is one `rm -rf` plus one registry row delete.
 * The trade-off, accepted deliberately: a preview only cross-links within
 * itself — refs into other packages render unresolved.
 *
 * The preview identity comes from the GitHub OIDC claim (`repository` and the
 * PR number parsed out of `ref`), never from client-supplied input, so an
 * uploader can only ever write into the namespace of its own pull request.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Identity of one preview namespace: a pull request on a GitHub repository. */
export interface PreviewRef {
  owner: string;
  repo: string;
  pr: number;
}

// GitHub's own limits: owners are alphanumeric with single hyphens (39 chars
// max), repository names allow `.`, `_` and `-`. Both are matched strictly —
// these values become filesystem path segments.
const OWNER_RE = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Maximum PR number accepted. Guards against absurd values in a claim. */
const MAX_PR = 10_000_000;

/**
 * Validate and normalise a preview reference. Owner/repo are lower-cased so
 * `Owner/Repo#3` and `owner/repo#3` name one namespace (GitHub treats them as
 * the same repository) instead of two directories.
 *
 * Returns null when any component is malformed.
 */
export function makePreviewRef(
  owner: string,
  repo: string,
  pr: number | string
): PreviewRef | null {
  const prNum = typeof pr === "number" ? pr : /^\d{1,8}$/.test(pr) ? Number(pr) : NaN;
  if (!Number.isInteger(prNum) || prNum <= 0 || prNum > MAX_PR) return null;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  // `.` and `..` are legal GitHub repo names by REPO_RE but lethal as path
  // segments; reject them outright rather than relying on the join guard.
  if (repo === "." || repo === "..") return null;
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase(), pr: prNum };
}

/** Stable string identity, e.g. `owner/repo#42`. Used as a registry key. */
export function previewId(ref: PreviewRef): string {
  return `${ref.owner}/${ref.repo}#${ref.pr}`;
}

/** Parse the `owner/repo#42` form back into a ref. Null when malformed. */
export function parsePreviewId(id: string): PreviewRef | null {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id);
  if (!m) return null;
  return makePreviewRef(m[1]!, m[2]!, m[3]!);
}

/** URL prefix every page of a preview is served under (no trailing slash). */
export function previewBase(ref: PreviewRef): string {
  return `/preview/${ref.owner}/${ref.repo}/${ref.pr}`;
}

/**
 * Split a preview URL off a pathname.
 *
 * `/preview/<owner>/<repo>/<pr>/project/numpy/2.3.5/` becomes
 * `{ ref, rest: "/project/numpy/2.3.5/" }`. The rest is what the viewer's
 * normal route tree sees after the middleware rewrite, so preview pages and
 * main-store pages run exactly the same code.
 *
 * Returns null when the path is not a preview path or names an invalid ref.
 */
export function parsePreviewPath(pathname: string): { ref: PreviewRef; rest: string } | null {
  if (!pathname.startsWith("/preview/")) return null;
  const parts = pathname.slice("/preview/".length).split("/");
  if (parts.length < 3) return null;
  const [owner, repo, pr, ...rest] = parts as [string, string, string, ...string[]];
  const ref = makePreviewRef(owner, repo, pr);
  if (!ref) return null;
  return { ref, rest: "/" + rest.join("/") };
}

/** Root directory holding every preview namespace. */
export function previewRoot(): string {
  return process.env.PAPYRI_PREVIEW_DIR ?? join(homedir(), ".papyri", "previews");
}

/**
 * Storage directory for one preview. Every component was validated by
 * `makePreviewRef`, so this cannot escape `previewRoot()`.
 */
export function previewDir(ref: PreviewRef): string {
  return join(previewRoot(), ref.owner, ref.repo, `pr${ref.pr}`);
}

/**
 * Default lifetime of a preview namespace. Every push to every PR of every
 * enrolled repository uploads a bundle, so previews must expire on their own;
 * an explicit drop on merge/close is the fast path, not the only one.
 */
export const PREVIEW_TTL_DAYS = 30;
