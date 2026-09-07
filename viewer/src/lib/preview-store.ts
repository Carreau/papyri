/**
 * Lifecycle of a PR preview namespace: register, drop, evict.
 *
 * The registry row (auth DB, `previews`) is what makes a preview *browsable*;
 * the content is the directory returned by `previewDir()`. Dropping one is
 * therefore a row delete plus an `rm -rf` — no cascade through the main graph,
 * because a preview never wrote into it.
 */
import { rm, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getAuthDb } from "./auth-db.ts";
import { closePreviewBackends, getBackends } from "./backends.ts";
import {
  PREVIEW_TTL_DAYS,
  parsePreviewId,
  previewDir,
  previewId,
  previewRoot,
  type PreviewRef,
} from "./preview.ts";

/** Register a preview (or push its expiry out) after a successful upload. */
export async function touchPreview(ref: PreviewRef): Promise<void> {
  (await getAuthDb()).recordPreview(
    previewId(ref),
    ref.owner,
    ref.repo,
    ref.pr,
    PREVIEW_TTL_DAYS * 24 * 60 * 60
  );
}

/**
 * Drop a preview: close its SQLite handle, delete its directory, forget the
 * registry row. Idempotent — dropping an unknown preview is a no-op that
 * returns false.
 */
export async function dropPreview(ref: PreviewRef): Promise<boolean> {
  const existed = (await getAuthDb()).deletePreview(previewId(ref));
  await closePreviewBackends(ref);
  const dir = previewDir(ref);
  await rm(dir, { recursive: true, force: true });
  // Tidy the now-possibly-empty `<owner>/<repo>` and `<owner>` directories.
  // rmdir fails when they still hold other previews, which is the intent.
  for (const parent of [dirname(dir), dirname(dirname(dir))]) {
    if (parent === previewRoot() || !parent.startsWith(previewRoot())) break;
    try {
      await rmdir(parent);
    } catch {
      break;
    }
  }
  return existed;
}

/**
 * Drop every preview past its TTL. Cheap (an indexed query returning nothing
 * in the common case), so the upload path calls it opportunistically —
 * previews must not be able to grow storage without bound even when a PR is
 * closed without the drop step ever running.
 */
export async function sweepExpiredPreviews(): Promise<string[]> {
  const expired = (await getAuthDb()).listExpiredPreviews();
  const dropped: string[] = [];
  for (const row of expired) {
    const ref = parsePreviewId(row.id);
    if (!ref) {
      // Unparseable id: the content directory is unreachable anyway, so the
      // row is all there is to remove.
      (await getAuthDb()).deletePreview(row.id);
      continue;
    }
    await dropPreview(ref);
    dropped.push(row.id);
  }
  return dropped;
}

/** One bundle held by a preview. */
export interface PreviewBundle {
  module: string;
  version: string;
}

/** Bundles ingested into a preview, for the admin listing. */
export async function previewBundles(ref: PreviewRef): Promise<PreviewBundle[]> {
  try {
    const { graphDb } = await getBackends(ref);
    return await graphDb.all<PreviewBundle>(
      "SELECT module, version FROM bundles ORDER BY module, version"
    );
  } catch {
    // A registry row whose store is missing or unreadable: report no bundles
    // rather than failing the whole listing page.
    return [];
  }
}
