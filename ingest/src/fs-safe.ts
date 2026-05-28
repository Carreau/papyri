/**
 * Filesystem path-safety guard for the store backends.
 *
 * The store backends join bundle-derived strings (module/version/kind/path for
 * blobs, pkg/ver for raw archives) into on-disk paths. Those strings come from
 * a decoded `.papyri` artifact — or, on the read side, straight from request
 * params — so a component containing `..` or an absolute segment would let a
 * crafted bundle (or request) read/write outside the store root. `safeJoin`
 * resolves the final path and refuses any result that escapes the root.
 */
import { join, resolve, sep } from "node:path";

export function safeJoin(root: string, ...segments: string[]): string {
  const full = join(root, ...segments);
  const base = resolve(root);
  const resolved = resolve(full);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error(`refusing path that escapes store root: ${segments.join("/")}`);
  }
  return full;
}
