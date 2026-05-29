import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  AuthDb,
  hashPassword,
  verifyPassword,
  isValidUsername,
  isValidProjectName,
  demoSeedActive,
  generateUploadToken,
  hashUploadToken,
  UPLOAD_TOKEN_PREFIX,
  DEMO_USERNAME,
  DEMO_PASSWORD,
  SESSION_TTL_SECONDS,
} from "../src/lib/auth-db.ts";

function makeAuth(): AuthDb {
  return new AuthDb(new Database(":memory:"));
}

describe("password hashing", () => {
  it("produces an Argon2id-encoded hash", async () => {
    expect(await hashPassword("password123")).toMatch(/^\$argon2id\$/);
  });

  it("round-trips a correct password", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const h = await hashPassword("hunter2hunter2");
    expect(await verifyPassword("Hunter2hunter2", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });

  it("produces a distinct salt per call", async () => {
    expect(await hashPassword("samepassword")).not.toBe(await hashPassword("samepassword"));
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "$argon2id$garbage")).toBe(false);
  });
});

describe("isValidUsername", () => {
  it("accepts sane names", () => {
    expect(isValidUsername("alice")).toBe(true);
    expect(isValidUsername("a.b_c-1")).toBe(true);
  });

  it("rejects empty, leading punctuation, and odd characters", () => {
    expect(isValidUsername("")).toBe(false);
    expect(isValidUsername(".hidden")).toBe(false);
    expect(isValidUsername("has space")).toBe(false);
    expect(isValidUsername("drop;table")).toBe(false);
    expect(isValidUsername(123)).toBe(false);
  });
});

describe("isValidProjectName", () => {
  it("accepts package-like names", () => {
    expect(isValidProjectName("numpy")).toBe(true);
    expect(isValidProjectName("scikit-learn")).toBe(true);
    expect(isValidProjectName("a.b_c-1")).toBe(true);
  });

  it("rejects path separators, traversal, and odd input", () => {
    expect(isValidProjectName("")).toBe(false);
    expect(isValidProjectName("..")).toBe(false);
    expect(isValidProjectName("a/b")).toBe(false);
    expect(isValidProjectName("../etc")).toBe(false);
    expect(isValidProjectName(123)).toBe(false);
  });
});

describe("upload token helpers", () => {
  it("mints prefixed tokens that hash deterministically", () => {
    const t = generateUploadToken();
    expect(t.startsWith(UPLOAD_TOKEN_PREFIX)).toBe(true);
    expect(generateUploadToken()).not.toBe(t);
    expect(hashUploadToken(t)).toBe(hashUploadToken(t));
    expect(hashUploadToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("AuthDb users", () => {
  let auth: AuthDb;
  beforeEach(() => {
    auth = makeAuth();
  });
  afterEach(() => auth.close());

  it("starts empty", () => {
    expect(auth.userCount()).toBe(0);
    expect(auth.listUsers()).toEqual([]);
  });

  it("creates and lists users without exposing the hash", async () => {
    const u = await auth.createUser("alice", "password123");
    expect(u.username).toBe("alice");
    expect(u.is_admin).toBe(false);
    const listed = auth.listUsers();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("password_hash");
    expect(listed[0].is_admin).toBe(false);
  });

  it("creates an admin user when requested and exposes the flag", async () => {
    const u = await auth.createUser("root", "password123", true);
    expect(u.is_admin).toBe(true);
    expect(auth.getUser(u.id)?.is_admin).toBe(true);
    const { token } = auth.createSession(u.id);
    expect(auth.resolveSession(token)?.is_admin).toBe(true);
  });

  it("rejects short passwords and duplicate / invalid usernames", async () => {
    await expect(auth.createUser("bob", "short")).rejects.toThrow();
    await expect(auth.createUser("bad name", "password123")).rejects.toThrow();
    await auth.createUser("carol", "password123");
    await expect(auth.createUser("carol", "password123")).rejects.toThrow();
  });

  it("verifies login only with correct credentials", async () => {
    await auth.createUser("dave", "password123");
    expect((await auth.verifyLogin("dave", "password123"))?.username).toBe("dave");
    expect(await auth.verifyLogin("dave", "wrongpass1")).toBeNull();
    expect(await auth.verifyLogin("nobody", "password123")).toBeNull();
  });

  it("deletes users and cascades their sessions", async () => {
    const u = await auth.createUser("erin", "password123");
    const { token } = auth.createSession(u.id);
    expect(auth.resolveSession(token)?.username).toBe("erin");
    expect(auth.deleteUser(u.id)).toBe(true);
    expect(auth.resolveSession(token)).toBeNull();
    expect(auth.deleteUser(u.id)).toBe(false);
  });
});

describe("AuthDb changePassword", () => {
  let auth: AuthDb;
  beforeEach(() => {
    auth = makeAuth();
  });
  afterEach(() => auth.close());

  it("changes the password when the current one is correct", async () => {
    const u = await auth.createUser("mallory", "password123");
    expect(await auth.changePassword(u.id, "password123", "newpassword456")).toEqual({ ok: true });
    expect(await auth.verifyLogin("mallory", "password123")).toBeNull();
    expect((await auth.verifyLogin("mallory", "newpassword456"))?.id).toBe(u.id);
  });

  it("rejects a wrong current password and leaves the old one intact", async () => {
    const u = await auth.createUser("niaj", "password123");
    expect(await auth.changePassword(u.id, "wrongpass1", "newpassword456")).toEqual({
      ok: false,
      reason: "wrong-current",
    });
    expect((await auth.verifyLogin("niaj", "password123"))?.id).toBe(u.id);
  });

  it("rejects a too-short new password", async () => {
    const u = await auth.createUser("olivia", "password123");
    expect(await auth.changePassword(u.id, "password123", "short")).toEqual({
      ok: false,
      reason: "weak-new",
    });
    expect((await auth.verifyLogin("olivia", "password123"))?.id).toBe(u.id);
  });

  it("reports no-user for an unknown id", async () => {
    expect(await auth.changePassword(9999, "password123", "newpassword456")).toEqual({
      ok: false,
      reason: "no-user",
    });
  });
});

describe("AuthDb deleteOtherSessions", () => {
  let auth: AuthDb;
  beforeEach(() => {
    auth = makeAuth();
  });
  afterEach(() => auth.close());

  it("revokes a user's other sessions but keeps the current one", async () => {
    const u = await auth.createUser("peggy", "password123");
    const keep = auth.createSession(u.id).token;
    const other1 = auth.createSession(u.id).token;
    const other2 = auth.createSession(u.id).token;
    expect(auth.deleteOtherSessions(u.id, keep)).toBe(2);
    expect(auth.resolveSession(keep)?.id).toBe(u.id);
    expect(auth.resolveSession(other1)).toBeNull();
    expect(auth.resolveSession(other2)).toBeNull();
  });

  it("does not touch another user's sessions", async () => {
    const a = await auth.createUser("quentin", "password123");
    const b = await auth.createUser("rupert", "password123");
    const aKeep = auth.createSession(a.id).token;
    const bToken = auth.createSession(b.id).token;
    expect(auth.deleteOtherSessions(a.id, aKeep)).toBe(0);
    expect(auth.resolveSession(bToken)?.id).toBe(b.id);
  });
});

describe("AuthDb sessions", () => {
  let auth: AuthDb;
  beforeEach(() => {
    auth = makeAuth();
  });
  afterEach(() => {
    auth.close();
    vi.useRealTimers();
  });

  it("resolves a fresh session to its user", async () => {
    const u = await auth.createUser("frank", "password123");
    const { token, createdAt, expiresAt } = auth.createSession(u.id);
    expect(expiresAt - createdAt).toBe(SESSION_TTL_SECONDS);
    expect(auth.resolveSession(token)?.id).toBe(u.id);
  });

  it("rejects and removes an expired session", async () => {
    const u = await auth.createUser("grace", "password123");
    const { token } = auth.createSession(u.id, 1);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2000);
    expect(auth.resolveSession(token)).toBeNull();
    // Expired row is purged on access.
    expect(auth.resolveSession(token)).toBeNull();
  });

  it("revokes a session on logout (deleteSession)", async () => {
    const u = await auth.createUser("heidi", "password123");
    const { token } = auth.createSession(u.id);
    auth.deleteSession(token);
    expect(auth.resolveSession(token)).toBeNull();
  });

  it("prunes expired sessions in bulk", async () => {
    const u = await auth.createUser("ivan", "password123");
    auth.createSession(u.id, 1);
    auth.createSession(u.id, SESSION_TTL_SECONDS);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2000);
    expect(auth.pruneExpiredSessions()).toBe(1);
  });

  it("rejects an unknown token", () => {
    expect(auth.resolveSession("deadbeef")).toBeNull();
  });
});

describe("seed", () => {
  const saved = {
    u: process.env.PAPYRI_USERNAME,
    p: process.env.PAPYRI_PASSWORD,
    d: process.env.PAPYRI_DEV_SEED,
  };
  afterEach(() => {
    process.env.PAPYRI_USERNAME = saved.u;
    process.env.PAPYRI_PASSWORD = saved.p;
    process.env.PAPYRI_DEV_SEED = saved.d;
    vi.restoreAllMocks();
  });

  it("seeds an admin from env when empty", async () => {
    process.env.PAPYRI_USERNAME = "rootadmin";
    process.env.PAPYRI_PASSWORD = "password123";
    const auth = makeAuth();
    await auth.seed();
    const seeded = await auth.verifyLogin("rootadmin", "password123");
    expect(seeded?.username).toBe("rootadmin");
    // The bootstrapped account must be an admin, or nobody can manage the site.
    expect(auth.getUser(seeded!.id)?.is_admin).toBe(true);
    auth.close();
  });

  it("env admin takes priority over the demo seed", async () => {
    process.env.PAPYRI_USERNAME = "rootadmin";
    process.env.PAPYRI_PASSWORD = "password123";
    const auth = makeAuth();
    await auth.seed({ allowDemoSeed: true });
    expect(auth.userCount()).toBe(1);
    expect(await auth.verifyLogin(DEMO_USERNAME, DEMO_PASSWORD)).toBeNull();
    auth.close();
  });

  it("fails closed (no user) when env is unset and demo disabled", async () => {
    delete process.env.PAPYRI_USERNAME;
    delete process.env.PAPYRI_PASSWORD;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth = makeAuth();
    await auth.seed();
    expect(auth.userCount()).toBe(0);
    auth.close();
  });

  it("seeds the demo admin when allowDemoSeed is set", async () => {
    delete process.env.PAPYRI_USERNAME;
    delete process.env.PAPYRI_PASSWORD;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth = makeAuth();
    await auth.seed({ allowDemoSeed: true });
    expect((await auth.verifyLogin(DEMO_USERNAME, DEMO_PASSWORD))?.username).toBe(DEMO_USERNAME);
    auth.close();
  });

  it("does not re-seed when users already exist", async () => {
    process.env.PAPYRI_USERNAME = "rootadmin";
    process.env.PAPYRI_PASSWORD = "password123";
    const auth = makeAuth();
    await auth.createUser("existing", "password123");
    await auth.seed();
    expect(auth.userCount()).toBe(1);
    expect(await auth.verifyLogin("rootadmin", "password123")).toBeNull();
    auth.close();
  });
});

describe("AuthDb admin roles", () => {
  let auth: AuthDb;
  beforeEach(() => {
    auth = makeAuth();
  });
  afterEach(() => auth.close());

  it("promotes and demotes users", async () => {
    const a = await auth.createUser("alice", "password123", true);
    const b = await auth.createUser("bob", "password123");
    expect(auth.adminCount()).toBe(1);
    expect(auth.setAdmin(b.id, true)).toEqual({ ok: true });
    expect(auth.adminCount()).toBe(2);
    expect(auth.setAdmin(b.id, false)).toEqual({ ok: true });
    expect(auth.getUser(b.id)?.is_admin).toBe(false);
    expect(auth.getUser(a.id)?.is_admin).toBe(true);
  });

  it("refuses to demote the last admin", async () => {
    const a = await auth.createUser("alice", "password123", true);
    await auth.createUser("bob", "password123");
    expect(auth.setAdmin(a.id, false)).toEqual({ ok: false, reason: "last-admin" });
    expect(auth.adminCount()).toBe(1);
  });

  it("reports no-user for an unknown id", () => {
    expect(auth.setAdmin(9999, true)).toEqual({ ok: false, reason: "no-user" });
  });
});

describe("AuthDb projects and membership", () => {
  let auth: AuthDb;
  beforeEach(() => {
    auth = makeAuth();
  });
  afterEach(() => auth.close());

  it("creates, lists, looks up, and deletes projects", () => {
    const p = auth.createProject("numpy");
    expect(p.name).toBe("numpy");
    expect(auth.listProjects().map((x) => x.name)).toEqual(["numpy"]);
    expect(auth.getProjectByName("numpy")?.id).toBe(p.id);
    expect(auth.getProjectByName("scipy")).toBeNull();
    expect(() => auth.createProject("numpy")).toThrow();
    expect(() => auth.createProject("../etc")).toThrow();
    expect(auth.deleteProject(p.id)).toBe(true);
    expect(auth.listProjects()).toEqual([]);
  });

  it("assigns and removes members (idempotently) and lists both directions", async () => {
    const p = auth.createProject("numpy");
    const u = await auth.createUser("alice", "password123");
    auth.addMember(p.id, u.id);
    auth.addMember(p.id, u.id); // idempotent
    expect(auth.listMembers(p.id).map((m) => m.username)).toEqual(["alice"]);
    expect(auth.listUserProjects(u.id)).toEqual(["numpy"]);
    expect(auth.removeMember(p.id, u.id)).toBe(true);
    expect(auth.listMembers(p.id)).toEqual([]);
    expect(auth.removeMember(p.id, u.id)).toBe(false);
  });

  it("authorizes uploads only for members, and admins for everything", async () => {
    const np = auth.createProject("numpy");
    auth.createProject("scipy");
    const member = await auth.createUser("alice", "password123");
    const admin = await auth.createUser("root", "password123", true);
    auth.addMember(np.id, member.id);

    expect(auth.canUserUploadProject(member.id, "numpy")).toBe(true);
    expect(auth.canUserUploadProject(member.id, "scipy")).toBe(false);
    expect(auth.canUserUploadProject(member.id, "unknown")).toBe(false);
    // Admin may upload any project, even one with no project row at all.
    expect(auth.canUserUploadProject(admin.id, "scipy")).toBe(true);
    expect(auth.canUserUploadProject(admin.id, "brand-new")).toBe(true);
    expect(auth.canUserUploadProject(9999, "numpy")).toBe(false);
  });

  it("cascades memberships when a project or user is deleted", async () => {
    const p = auth.createProject("numpy");
    const u = await auth.createUser("alice", "password123");
    auth.addMember(p.id, u.id);
    auth.deleteProject(p.id);
    expect(auth.listUserProjects(u.id)).toEqual([]);

    const p2 = auth.createProject("scipy");
    auth.addMember(p2.id, u.id);
    auth.deleteUser(u.id);
    expect(auth.listMembers(p2.id)).toEqual([]);
  });
});

describe("AuthDb upload tokens", () => {
  let auth: AuthDb;
  beforeEach(() => {
    auth = makeAuth();
  });
  afterEach(() => {
    auth.close();
    vi.useRealTimers();
  });

  it("mints a token, resolves it to its owner, and stamps last_used_at", async () => {
    const u = await auth.createUser("alice", "password123");
    const { token, secret } = auth.createUploadToken(u.id, "ci");
    expect(token.name).toBe("ci");
    expect(token.last_used_at).toBeNull();
    expect(secret.startsWith(UPLOAD_TOKEN_PREFIX)).toBe(true);

    const resolved = auth.resolveUploadToken(secret);
    expect(resolved?.user.id).toBe(u.id);
    // An unscoped token resolves with a null project.
    expect(resolved?.projectName).toBeNull();
    expect(token.project_id).toBeNull();
    expect(token.project_name).toBeNull();
    // last_used_at is stamped on resolve.
    expect(auth.listUploadTokens(u.id)[0].last_used_at).not.toBeNull();
  });

  it("scopes a token to a single project and reflects it on resolve and list", async () => {
    const u = await auth.createUser("alice", "password123");
    const numpy = auth.createProject("numpy");
    const { token, secret } = auth.createUploadToken(u.id, "ci", null, numpy.id);
    expect(token.project_id).toBe(numpy.id);
    expect(token.project_name).toBe("numpy");

    const resolved = auth.resolveUploadToken(secret);
    expect(resolved?.user.id).toBe(u.id);
    expect(resolved?.projectName).toBe("numpy");

    expect(auth.listUploadTokens(u.id)[0].project_name).toBe("numpy");
  });

  it("cascades a scoped token when its project is deleted", async () => {
    const u = await auth.createUser("alice", "password123");
    const scipy = auth.createProject("scipy");
    const { secret } = auth.createUploadToken(u.id, "ci", null, scipy.id);
    expect(auth.deleteProject(scipy.id)).toBe(true);
    // The token is gone (FK ON DELETE CASCADE), so it no longer resolves.
    expect(auth.resolveUploadToken(secret)).toBeNull();
    expect(auth.listUploadTokens(u.id)).toEqual([]);
  });

  it("rejects unknown, malformed, and revoked tokens", async () => {
    const u = await auth.createUser("alice", "password123");
    const { token, secret } = auth.createUploadToken(u.id);
    expect(auth.resolveUploadToken("not-a-papyri-token")).toBeNull();
    expect(auth.resolveUploadToken(UPLOAD_TOKEN_PREFIX + "deadbeef")).toBeNull();
    expect(auth.revokeUploadToken(token.id, u.id)).toBe(true);
    expect(auth.resolveUploadToken(secret)).toBeNull();
    expect(auth.revokeUploadToken(token.id, u.id)).toBe(false);
  });

  it("does not let one user revoke another's token", async () => {
    const a = await auth.createUser("alice", "password123");
    const b = await auth.createUser("bob", "password123");
    const { token } = auth.createUploadToken(a.id);
    expect(auth.revokeUploadToken(token.id, b.id)).toBe(false);
    expect(auth.listUploadTokens(a.id)).toHaveLength(1);
  });

  it("rejects and purges an expired token", async () => {
    const u = await auth.createUser("alice", "password123");
    const { secret } = auth.createUploadToken(u.id, "short-lived", 1);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2000);
    expect(auth.resolveUploadToken(secret)).toBeNull();
    expect(auth.listUploadTokens(u.id)).toEqual([]);
  });

  it("cascades tokens when the user is deleted", async () => {
    const u = await auth.createUser("alice", "password123");
    const { secret } = auth.createUploadToken(u.id);
    auth.deleteUser(u.id);
    expect(auth.resolveUploadToken(secret)).toBeNull();
  });
});

describe("demoSeedActive policy", () => {
  const saved = {
    u: process.env.PAPYRI_USERNAME,
    p: process.env.PAPYRI_PASSWORD,
    d: process.env.PAPYRI_DEV_SEED,
  };
  afterEach(() => {
    process.env.PAPYRI_USERNAME = saved.u;
    process.env.PAPYRI_PASSWORD = saved.p;
    process.env.PAPYRI_DEV_SEED = saved.d;
  });

  it("is off when real env credentials are configured", () => {
    process.env.PAPYRI_USERNAME = "rootadmin";
    process.env.PAPYRI_PASSWORD = "password123";
    process.env.PAPYRI_DEV_SEED = "1";
    expect(demoSeedActive()).toBe(false);
  });

  it("honours an explicit PAPYRI_DEV_SEED flag", () => {
    delete process.env.PAPYRI_USERNAME;
    delete process.env.PAPYRI_PASSWORD;
    process.env.PAPYRI_DEV_SEED = "0";
    expect(demoSeedActive()).toBe(false);
    process.env.PAPYRI_DEV_SEED = "1";
    expect(demoSeedActive()).toBe(true);
  });

  it("defaults to dev mode when no flag is set", () => {
    delete process.env.PAPYRI_USERNAME;
    delete process.env.PAPYRI_PASSWORD;
    delete process.env.PAPYRI_DEV_SEED;
    // Vitest runs under Vite, so import.meta.env.DEV is true here.
    expect(demoSeedActive()).toBe(true);
  });
});
