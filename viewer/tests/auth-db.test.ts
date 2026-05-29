import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  AuthDb,
  hashPassword,
  verifyPassword,
  isValidUsername,
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
    const listed = auth.listUsers();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("password_hash");
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

describe("seedFromEnv", () => {
  const saved = { u: process.env.PAPYRI_USERNAME, p: process.env.PAPYRI_PASSWORD };
  afterEach(() => {
    process.env.PAPYRI_USERNAME = saved.u;
    process.env.PAPYRI_PASSWORD = saved.p;
    vi.restoreAllMocks();
  });

  it("seeds an admin from env when empty", async () => {
    process.env.PAPYRI_USERNAME = "rootadmin";
    process.env.PAPYRI_PASSWORD = "password123";
    const auth = makeAuth();
    await auth.seedFromEnv();
    expect((await auth.verifyLogin("rootadmin", "password123"))?.username).toBe("rootadmin");
    auth.close();
  });

  it("fails closed (no user) when env is unset", async () => {
    delete process.env.PAPYRI_USERNAME;
    delete process.env.PAPYRI_PASSWORD;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth = makeAuth();
    await auth.seedFromEnv();
    expect(auth.userCount()).toBe(0);
    auth.close();
  });

  it("does not re-seed when users already exist", async () => {
    process.env.PAPYRI_USERNAME = "rootadmin";
    process.env.PAPYRI_PASSWORD = "password123";
    const auth = makeAuth();
    await auth.createUser("existing", "password123");
    await auth.seedFromEnv();
    expect(auth.userCount()).toBe(1);
    expect(await auth.verifyLogin("rootadmin", "password123")).toBeNull();
    auth.close();
  });
});
