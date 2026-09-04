import { describe, it, expect, beforeEach } from "vitest";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  GITHUB_ISSUER,
  looksLikeJwt,
  OidcError,
  previewRefFromClaims,
  primeJwksCache,
  resetJwksCache,
  verifyGithubOidcToken,
  workflowFile,
  type GithubOidcClaims,
} from "../src/lib/oidc.ts";

const KID = "test-key-1";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwk(key: KeyObject, kid: string) {
  return { ...key.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
}

function b64u(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Mint a token the way GitHub would, signed with the test key. */
function mintToken(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key = privateKey
): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: "RS256", typ: "JWT", kid: KID, ...header });
  const body = b64u({
    iss: GITHUB_ISSUER,
    aud: "papyri",
    iat: now,
    nbf: now,
    exp: now + 300,
    repository: "numpy/numpy",
    repository_owner: "numpy",
    workflow_ref: "numpy/numpy/.github/workflows/docs.yml@refs/pull/42/merge",
    event_name: "pull_request",
    ref: "refs/pull/42/merge",
    ...claims,
  });
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  const sig = signer.sign(key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

describe("token shape detection", () => {
  it("tells a JWT apart from a papyri personal token", () => {
    expect(looksLikeJwt(mintToken())).toBe(true);
    expect(looksLikeJwt("papyri_pat_deadbeef")).toBe(false);
    expect(looksLikeJwt("")).toBe(false);
  });
});

describe("verifyGithubOidcToken", () => {
  beforeEach(() => {
    resetJwksCache();
    primeJwksCache([jwk(publicKey, KID)]);
  });

  it("accepts a well-formed token and returns its claims", async () => {
    const claims = await verifyGithubOidcToken(mintToken(), "papyri");
    expect(claims.repository).toBe("numpy/numpy");
    expect(claims.event_name).toBe("pull_request");
  });

  it("rejects a token signed by another key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(verifyGithubOidcToken(mintToken({}, {}, other.privateKey))).rejects.toThrow(
      OidcError
    );
  });

  it("rejects a tampered payload", async () => {
    const [h, , s] = mintToken().split(".");
    const forged = b64u({ iss: GITHUB_ISSUER, aud: "papyri", repository: "evil/evil" });
    await expect(verifyGithubOidcToken(`${h}.${forged}.${s}`)).rejects.toThrow(
      /signature verification failed/
    );
  });

  it("rejects an unknown signing key", async () => {
    await expect(verifyGithubOidcToken(mintToken({}, { kid: "rotated-away" }))).rejects.toThrow(
      /unknown key/
    );
  });

  it("rejects `alg: none` and other algorithms", async () => {
    await expect(verifyGithubOidcToken(mintToken({}, { alg: "none" }))).rejects.toThrow(
      /unsupported token algorithm/
    );
  });

  it("rejects a wrong audience", async () => {
    await expect(verifyGithubOidcToken(mintToken({ aud: "pypi" }), "papyri")).rejects.toThrow(
      /audience/
    );
  });

  it("rejects a wrong issuer", async () => {
    await expect(verifyGithubOidcToken(mintToken({ iss: "https://evil.example" }))).rejects.toThrow(
      /issuer/
    );
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expect(verifyGithubOidcToken(mintToken({ exp: past }))).rejects.toThrow(/expired/);
  });

  it("rejects a token that is not valid yet", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    await expect(verifyGithubOidcToken(mintToken({ nbf: future }))).rejects.toThrow(/future/);
  });

  it("rejects a token missing an identity claim", async () => {
    await expect(verifyGithubOidcToken(mintToken({ repository: undefined }))).rejects.toThrow(
      /missing the repository claim/
    );
  });

  it("rejects a malformed token without hitting the network", async () => {
    await expect(verifyGithubOidcToken("not.a.jwt")).rejects.toThrow(/malformed token/);
    await expect(verifyGithubOidcToken("onlyonesegment")).rejects.toThrow(/malformed token/);
  });
});

describe("claims → workload identity", () => {
  const base: GithubOidcClaims = {
    iss: GITHUB_ISSUER,
    aud: "papyri",
    exp: 0,
    repository: "numpy/numpy",
    repository_owner: "numpy",
    workflow_ref: "numpy/numpy/.github/workflows/docs.yml@refs/pull/42/merge",
    event_name: "pull_request",
    ref: "refs/pull/42/merge",
  };

  it("extracts the workflow file", () => {
    expect(workflowFile(base)).toBe(".github/workflows/docs.yml");
    // A claim shape we don't recognise narrows to "" rather than guessing.
    expect(workflowFile({ ...base, workflow_ref: "somethingelse" })).toBe("");
  });

  it("derives the preview from the pull-request ref", () => {
    expect(previewRefFromClaims(base)).toEqual({ owner: "numpy", repo: "numpy", pr: 42 });
    expect(previewRefFromClaims({ ...base, ref: "refs/pull/42/head" })).toEqual({
      owner: "numpy",
      repo: "numpy",
      pr: 42,
    });
  });

  it("refuses events that own no preview", () => {
    expect(previewRefFromClaims({ ...base, event_name: "push", ref: "refs/heads/main" })).toBeNull();
    // pull_request_target runs with base-repo permissions on untrusted code.
    expect(previewRefFromClaims({ ...base, event_name: "pull_request_target" })).toBeNull();
    expect(previewRefFromClaims({ ...base, ref: "refs/heads/main" })).toBeNull();
  });
});
