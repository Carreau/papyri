import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createSign, randomUUID, type KeyObject } from "node:crypto";
import {
  GITHUB_OIDC_ISSUER,
  verifyGithubOidcToken,
  looksLikeJwt,
  isValidRepository,
  normalizeWorkflowRef,
  parseJobWorkflowRef,
  getOidcAudience,
  audienceIsDerived,
  resetJwksCache,
  type FetchLike,
} from "../src/lib/github-oidc.ts";

const AUDIENCE = "https://docs.example.org";

// A signing key that stands in for GitHub's: the JWKS the fake fetch serves is
// derived from it, so a token signed here verifies exactly as a real one does.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";

function b64url(value: object | Buffer): string {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return buf.toString("base64url");
}

function sign(
  payload: Record<string, unknown>,
  {
    kid = KID,
    alg = "RS256",
    key = privateKey,
  }: { kid?: string; alg?: string; key?: KeyObject } = {}
): string {
  const head = b64url({ alg, kid, typ: "JWT" });
  const body = b64url(payload);
  const signer = createSign("sha256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(signer.sign(key))}`;
}

const now = Math.floor(Date.now() / 1000);

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: GITHUB_OIDC_ISSUER,
    aud: AUDIENCE,
    sub: "repo:octo/papyri-docs:ref:refs/heads/main",
    repository: "octo/papyri-docs",
    repository_owner: "octo",
    repository_owner_id: "12345",
    job_workflow_ref: "octo/papyri-docs/.github/workflows/docs.yml@refs/heads/main",
    workflow_ref: "octo/papyri-docs/.github/workflows/docs.yml@refs/heads/main",
    ref: "refs/heads/main",
    iat: now - 10,
    nbf: now - 10,
    exp: now + 600,
    ...overrides,
  };
}

/** Serves the discovery document and JWKS from the test key. */
function makeFetch(keys?: unknown[]): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const jwk = publicKey.export({ format: "jwk" });
  const impl: FetchLike = async (url) => {
    calls.push(url);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer: GITHUB_OIDC_ISSUER,
          jwks_uri: `${GITHUB_OIDC_ISSUER}/.well-known/jwks`,
        })
      );
    }
    if (url.endsWith("/.well-known/jwks")) {
      return new Response(
        JSON.stringify({ keys: keys ?? [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] })
      );
    }
    return new Response("not found", { status: 404 });
  };
  return Object.assign(impl, { calls });
}

beforeEach(() => {
  resetJwksCache();
});

describe("looksLikeJwt", () => {
  it("accepts a three-segment base64url token", () => {
    expect(looksLikeJwt(sign(claims()))).toBe(true);
  });

  it("rejects a papyri personal upload token", () => {
    expect(looksLikeJwt("papyri_pat_deadbeef")).toBe(false);
    expect(looksLikeJwt("")).toBe(false);
    expect(looksLikeJwt("a.b")).toBe(false);
  });
});

describe("claim shape helpers", () => {
  it("validates owner/repo", () => {
    expect(isValidRepository("numpy/numpy")).toBe(true);
    expect(isValidRepository("numpy")).toBe(false);
    expect(isValidRepository("a/b/c")).toBe(false);
    expect(isValidRepository("../etc")).toBe(false);
  });

  it("normalizes a workflow file to its repository path", () => {
    expect(normalizeWorkflowRef("docs.yml")).toBe(".github/workflows/docs.yml");
    expect(normalizeWorkflowRef(".github/workflows/docs.yaml")).toBe(".github/workflows/docs.yaml");
    expect(normalizeWorkflowRef("../docs.yml")).toBeNull();
    expect(normalizeWorkflowRef("docs.yml@refs/heads/main")).toBeNull();
    expect(normalizeWorkflowRef("docs")).toBeNull();
  });

  it("splits job_workflow_ref into repository and workflow", () => {
    expect(parseJobWorkflowRef("octo/repo/.github/workflows/docs.yml@refs/heads/main")).toEqual({
      repository: "octo/repo",
      workflowRef: ".github/workflows/docs.yml",
    });
    // A tag ref containing no "@" still parses.
    expect(parseJobWorkflowRef("octo/repo/.github/workflows/docs.yml")).toEqual({
      repository: "octo/repo",
      workflowRef: ".github/workflows/docs.yml",
    });
    expect(parseJobWorkflowRef("octo/repo@refs/heads/main")).toBeNull();
  });
});

describe("getOidcAudience", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("prefers PAPYRI_OIDC_AUDIENCE", () => {
    process.env.PAPYRI_OIDC_AUDIENCE = "papyri";
    process.env.PAPYRI_SITE = "https://docs.example.org";
    expect(getOidcAudience("https://other.example/api/bundle")).toBe("papyri");
    expect(audienceIsDerived()).toBe(false);
  });

  it("falls back to the PAPYRI_SITE origin", () => {
    delete process.env.PAPYRI_OIDC_AUDIENCE;
    process.env.PAPYRI_SITE = "https://docs.example.org/base/";
    expect(getOidcAudience("https://other.example/api/bundle")).toBe("https://docs.example.org");
    expect(audienceIsDerived()).toBe(false);
  });

  it("falls back to the request origin, flagged as derived", () => {
    delete process.env.PAPYRI_OIDC_AUDIENCE;
    delete process.env.PAPYRI_SITE;
    expect(getOidcAudience("https://other.example/api/bundle")).toBe("https://other.example");
    expect(audienceIsDerived()).toBe(true);
  });
});

describe("verifyGithubOidcToken", () => {
  it("accepts a well-formed token and returns its claims", async () => {
    const fetchImpl = makeFetch();
    const result = await verifyGithubOidcToken(sign(claims()), {
      audience: AUDIENCE,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.repository).toBe("octo/papyri-docs");
    expect(result.claims.repository_owner_id).toBe("12345");
    expect(result.claims.job_workflow_ref).toBe(
      "octo/papyri-docs/.github/workflows/docs.yml@refs/heads/main"
    );
    expect(result.claims.environment).toBeUndefined();
  });

  it("caches the JWKS across verifications", async () => {
    const fetchImpl = makeFetch();
    await verifyGithubOidcToken(sign(claims()), { audience: AUDIENCE, fetchImpl });
    const before = fetchImpl.calls.length;
    await verifyGithubOidcToken(sign(claims()), { audience: AUDIENCE, fetchImpl });
    expect(fetchImpl.calls.length).toBe(before);
  });

  it("rejects a tampered payload", async () => {
    const fetchImpl = makeFetch();
    const token = sign(claims());
    const [head, , sig] = token.split(".");
    const forged = `${head}.${b64url(claims({ repository: "evil/repo" }))}.${sig}`;
    const result = await verifyGithubOidcToken(forged, { audience: AUDIENCE, fetchImpl });
    expect(result).toEqual({ ok: false, error: "invalid token signature" });
  });

  it("rejects a token signed by another key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const result = await verifyGithubOidcToken(sign(claims(), { key: other.privateKey }), {
      audience: AUDIENCE,
      fetchImpl: makeFetch(),
    });
    expect(result).toEqual({ ok: false, error: "invalid token signature" });
  });

  it("rejects alg: none", async () => {
    const head = b64url({ alg: "none", kid: KID, typ: "JWT" });
    const token = `${head}.${b64url(claims())}.`;
    const result = await verifyGithubOidcToken(token, {
      audience: AUDIENCE,
      fetchImpl: makeFetch(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unsupported token algorithm|three segments/);
  });

  it("rejects a token minted for another audience", async () => {
    const result = await verifyGithubOidcToken(sign(claims({ aud: "https://evil.example" })), {
      audience: AUDIENCE,
      fetchImpl: makeFetch(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/audience/);
  });

  it("rejects a token from another issuer", async () => {
    const result = await verifyGithubOidcToken(sign(claims({ iss: "https://evil.example" })), {
      audience: AUDIENCE,
      fetchImpl: makeFetch(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/issuer/);
  });

  it("rejects an expired token", async () => {
    const result = await verifyGithubOidcToken(sign(claims({ exp: now - 3600 })), {
      audience: AUDIENCE,
      fetchImpl: makeFetch(),
    });
    expect(result).toEqual({ ok: false, error: "token has expired" });
  });

  it("rejects a token not yet valid", async () => {
    const result = await verifyGithubOidcToken(sign(claims({ nbf: now + 3600 })), {
      audience: AUDIENCE,
      fetchImpl: makeFetch(),
    });
    expect(result).toEqual({ ok: false, error: "token is not valid yet" });
  });

  it("rejects an unknown key id", async () => {
    const result = await verifyGithubOidcToken(sign(claims(), { kid: "rotated-away" }), {
      audience: AUDIENCE,
      fetchImpl: makeFetch(),
    });
    expect(result).toEqual({ ok: false, error: "unknown signing key: rotated-away" });
  });

  it("rejects a token missing the claims papyri authorizes on", async () => {
    const withoutRepo = claims();
    delete withoutRepo.repository;
    const result = await verifyGithubOidcToken(sign(withoutRepo), {
      audience: AUDIENCE,
      fetchImpl: makeFetch(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/missing the repository\/workflow claims/);
  });

  it("refuses a jwks_uri pointing off the issuer origin", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({ issuer: GITHUB_OIDC_ISSUER, jwks_uri: "https://evil.example/jwks" })
        );
      }
      return new Response("not found", { status: 404 });
    };
    const result = await verifyGithubOidcToken(sign(claims()), { audience: AUDIENCE, fetchImpl });
    expect(result).toEqual({ ok: false, error: "could not fetch GitHub's signing keys" });
  });

  it("reports a JWKS fetch failure without leaking internals", async () => {
    const fetchImpl: FetchLike = async () => new Response("boom", { status: 500 });
    const result = await verifyGithubOidcToken(sign(claims()), { audience: AUDIENCE, fetchImpl });
    expect(result).toEqual({ ok: false, error: "could not fetch GitHub's signing keys" });
  });

  it("refuses an absurdly large token before doing any work", async () => {
    const fetchImpl = makeFetch();
    const huge = `${"a".repeat(20_000)}.${"b".repeat(10)}.${"c".repeat(10)}`;
    const result = await verifyGithubOidcToken(huge, { audience: AUDIENCE, fetchImpl });
    expect(result).toEqual({ ok: false, error: "token too large" });
    expect(fetchImpl.calls).toEqual([]);
  });

  it("carries the event that triggered the run, so preview scoping can read it", async () => {
    const fetchImpl = makeFetch();
    const result = await verifyGithubOidcToken(
      sign(claims({ event_name: "pull_request", ref: "refs/pull/42/merge" })),
      { audience: AUDIENCE, fetchImpl }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.event_name).toBe("pull_request");
    expect(result.claims.ref).toBe("refs/pull/42/merge");
  });

  it("rejects garbage that is not a token at all", async () => {
    const result = await verifyGithubOidcToken(randomUUID(), {
      audience: AUDIENCE,
      fetchImpl: makeFetch(),
    });
    expect(result.ok).toBe(false);
  });
});
