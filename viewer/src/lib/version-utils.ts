import { compareVersionsDesc, listIngestedPackages, type IngestedPackage } from "./ir-reader.ts";
import type { GraphDb } from "papyri-ingest";

export type VersionStatus =
  | { kind: "latest" }
  | { kind: "old"; latestVersion: string }
  | { kind: "dev"; latestVersion: string | null }
  | { kind: "pre"; latestVersion: string | null };

const DEV_RE = /\.dev\d*$/i;
const PRE_RE = /(a|alpha|b|beta|rc)\d*$/i;

export function classifyVersionString(ver: string): "dev" | "pre" | "release" {
  if (DEV_RE.test(ver)) return "dev";
  if (PRE_RE.test(ver)) return "pre";
  return "release";
}

/**
 * Determine the version status of `ver` for `pkg` relative to the ingested
 * bundle list. Returns `latest` when the version is the newest stable release;
 * `old` with the latest stable version otherwise; `dev`/`pre` for development
 * or pre-release versions (with the latest stable version if one exists).
 */
export async function getVersionStatus(
  graphDb: GraphDb,
  pkg: string,
  ver: string
): Promise<VersionStatus> {
  let packages: IngestedPackage[];
  try {
    packages = await listIngestedPackages(graphDb);
  } catch {
    return { kind: "latest" };
  }

  const info = packages.find((p) => p.pkg === pkg);
  if (!info) return { kind: "latest" };

  const kind = classifyVersionString(ver);

  // Latest stable: first version that is a plain release, or fall back to the
  // first version overall if there are no stable releases.
  const latestStable =
    info.versions.find((v) => classifyVersionString(v) === "release") ?? info.latest;

  if (kind === "dev") return { kind: "dev", latestVersion: latestStable ?? null };
  if (kind === "pre") return { kind: "pre", latestVersion: latestStable ?? null };

  // Stable release — is it the latest?
  const stableVersions = info.versions.filter((v) => classifyVersionString(v) === "release");
  if (stableVersions.length === 0) return { kind: "latest" };
  stableVersions.sort(compareVersionsDesc);
  if (stableVersions[0] === ver) return { kind: "latest" };
  return { kind: "old", latestVersion: stableVersions[0]! };
}
