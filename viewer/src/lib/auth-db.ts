/**
 * Authentication store — users + sessions.
 *
 * This is authoritative state, deliberately kept in a SEPARATE SQLite file
 * from the graph store (`papyri.db`). The graph store is a derived cache that
 * `POST /api/reingest` and the admin "clear graphstore" action rebuild from
 * the raw archive (see PLAN.md "Storage invariant"); user accounts and login
 * sessions must survive those operations, so they live in their own database.
 *
 * Location: `PAPYRI_AUTH_DB`, defaulting to `~/.papyri/auth.db`.
 *
 * Schema (created on open, idempotent):
 *   users    — id, username (unique), password_hash, created_at
 *   sessions — token (random), user_id, created_at, expires_at
 *
 * Passwords are hashed with Argon2id (`@node-rs/argon2`, the OWASP-recommended
 * password hash) using its built-in per-hash random salt; the encoded
 * `$argon2id$…` string carries its own parameters and is verified in constant
 * time. Sessions are opaque random tokens stored server-side with an explicit
 * expiry, so a session can be revoked (logout, user delete) and is rejected
 * once expired — unlike the previous unsigned, never-verified
 * `base64(user:timestamp)` cookie.
 */
import { randomBytes } from "node:crypto";
// Type-only; erased at compile time. Both this and `better-sqlite3` ship native
// bindings, so the concrete modules are loaded lazily via dynamic import (see
// `argon2()` / `openAuthDb()`) rather than statically bundled by Vite.
import type * as Argon2 from "@node-rs/argon2";
import type BetterSqlite3 from "better-sqlite3";

/** Cookie name carrying the session token. */
export const SESSION_COOKIE = "papyri_session_token";

/** Session lifetime in seconds (7 days). */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

// `@node-rs/argon2` carries a native binding; load it lazily so Vite leaves it
// external instead of trying to bundle the `.node` file.
let _argon2: Promise<typeof Argon2> | null = null;
function argon2(): Promise<typeof Argon2> {
  if (!_argon2) _argon2 = import(/* @vite-ignore */ "@node-rs/argon2");
  return _argon2;
}

// A valid Argon2 hash of a random string, used as a constant-time decoy when
// the requested username does not exist so login timing does not reveal account
// existence. Computed once, lazily.
let _decoyHash: Promise<string> | null = null;
function decoyHash(): Promise<string> {
  if (!_decoyHash) _decoyHash = hashPassword(randomBytes(16).toString("hex"));
  return _decoyHash;
}

/** Row shape stored in `users` (including the secret hash). */
interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
}

/** Public user view — never carries the password hash. */
export interface PublicUser {
  id: number;
  username: string;
  created_at: number;
}

export interface SessionRow {
  token: string;
  user_id: number;
  created_at: number;
  expires_at: number;
}

/** Hash a plaintext password into an encoded Argon2id string. */
export async function hashPassword(password: string): Promise<string> {
  return (await argon2()).hash(password);
}

/**
 * Constant-time verification of a plaintext password against a stored Argon2
 * hash. Returns false (rather than throwing) on a malformed stored hash.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    return await (await argon2()).verify(stored, password);
  } catch {
    return false;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Username rule: keeps it to a sane, loggable, URL-safe-ish set. */
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isValidUsername(name: unknown): name is string {
  return typeof name === "string" && USERNAME_RE.test(name);
}

/**
 * Demo admin credentials seeded only for local development (see
 * `demoSeedActive`). Never used when real `PAPYRI_USERNAME`/`PAPYRI_PASSWORD`
 * credentials are set, and never in a production build unless explicitly
 * forced with `PAPYRI_DEV_SEED=1`.
 */
export const DEMO_USERNAME = "admin";
export const DEMO_PASSWORD = "password";

/** Parse a boolean-ish env var; returns undefined when unset/unrecognised. */
function envFlag(v: string | undefined): boolean | undefined {
  if (!v) return undefined;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  return undefined;
}

/**
 * Whether the demo admin (`DEMO_USERNAME`/`DEMO_PASSWORD`) should be seeded
 * when the store is empty. Policy:
 *   - Real `PAPYRI_USERNAME`+`PAPYRI_PASSWORD` set → never (they take priority).
 *   - Else `PAPYRI_DEV_SEED` set → honour it explicitly (`1`/`0`).
 *   - Else default to dev mode: on under `pnpm dev`, off in a production build.
 *
 * `import.meta.env.DEV` is statically replaced by Vite at build time (`false`
 * in the Node server bundle, `true` under `astro dev`), so a built deployment
 * fails closed unless `PAPYRI_DEV_SEED=1` is set deliberately.
 */
export function demoSeedActive(): boolean {
  if (process.env.PAPYRI_USERNAME && process.env.PAPYRI_PASSWORD) return false;
  const flag = envFlag(process.env.PAPYRI_DEV_SEED);
  if (flag !== undefined) return flag;
  return import.meta.env.DEV === true;
}

/**
 * Thin wrapper over a better-sqlite3 handle holding the auth schema. All
 * methods are synchronous (better-sqlite3 is sync); the app obtains a shared
 * instance via the async `getAuthDb()` singleton, while tests construct one
 * directly from an in-memory `Database`.
 */
export class AuthDb {
  constructor(private readonly db: BetterSqlite3.Database) {
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY,
        username      TEXT    NOT NULL UNIQUE,
        password_hash TEXT    NOT NULL,
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT    PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
    `);
  }

  userCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return row.n;
  }

  /** Create a user; throws if the username already exists or is invalid. */
  async createUser(username: string, password: string): Promise<PublicUser> {
    if (!isValidUsername(username)) {
      throw new Error("invalid username");
    }
    if (typeof password !== "string" || password.length < 8) {
      throw new Error("password must be at least 8 characters");
    }
    const created_at = nowSeconds();
    const passwordHash = await hashPassword(password);
    const info = this.db
      .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run(username, passwordHash, created_at);
    return { id: Number(info.lastInsertRowid), username, created_at };
  }

  listUsers(): PublicUser[] {
    return this.db
      .prepare("SELECT id, username, created_at FROM users ORDER BY username")
      .all() as PublicUser[];
  }

  deleteUser(id: number): boolean {
    // Sessions cascade via the FK; foreign_keys pragma is enabled in the ctor.
    const info = this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return info.changes > 0;
  }

  /**
   * Change a user's own password. Verifies the current password first so a
   * hijacked but still-active session cannot silently re-key the account, then
   * re-hashes and stores the new one. Returns a tagged result so the caller can
   * surface the precise reason without leaking it through exception strings.
   * The minimum-length rule mirrors `createUser`.
   */
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string
  ): Promise<{ ok: true } | { ok: false; reason: "no-user" | "wrong-current" | "weak-new" }> {
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return { ok: false, reason: "weak-new" };
    }
    const row = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as
      | { password_hash: string }
      | undefined;
    if (!row) return { ok: false, reason: "no-user" };
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      return { ok: false, reason: "wrong-current" };
    }
    const passwordHash = await hashPassword(newPassword);
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
    return { ok: true };
  }

  /**
   * Revoke every session for `userId` except `keepToken`; returns the number
   * removed. Used after a password change so any other (possibly leaked)
   * sessions are forced to re-authenticate while the caller's stays alive.
   */
  deleteOtherSessions(userId: number, keepToken: string): number {
    const info = this.db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?")
      .run(userId, keepToken);
    return info.changes;
  }

  /**
   * Verify a login. Returns the matching user row on success, else null.
   * Always performs a scrypt comparison (against a decoy hash when the user
   * is unknown) so timing does not reveal whether the username exists.
   */
  async verifyLogin(username: string, password: string): Promise<UserRow | null> {
    const user = this.db
      .prepare("SELECT id, username, password_hash, created_at FROM users WHERE username = ?")
      .get(username) as UserRow | undefined;
    if (!user) {
      // Compare against a decoy hash so an unknown username costs the same as a
      // wrong password — login timing must not reveal account existence.
      await verifyPassword(password, await decoyHash());
      return null;
    }
    if (!(await verifyPassword(password, user.password_hash))) return null;
    return user;
  }

  /** Mint a new session for `userId`, returning its token and expiry. */
  createSession(
    userId: number,
    ttlSeconds: number = SESSION_TTL_SECONDS
  ): { token: string; createdAt: number; expiresAt: number } {
    const token = randomBytes(32).toString("hex");
    const createdAt = nowSeconds();
    const expiresAt = createdAt + ttlSeconds;
    this.db
      .prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(token, userId, createdAt, expiresAt);
    return { token, createdAt, expiresAt };
  }

  /**
   * Resolve a session token to its user, enforcing expiry. An expired token
   * is deleted and treated as invalid. Returns null when the token is
   * unknown, expired, or its user no longer exists.
   */
  resolveSession(token: string): PublicUser | null {
    const session = this.db
      .prepare("SELECT token, user_id, created_at, expires_at FROM sessions WHERE token = ?")
      .get(token) as SessionRow | undefined;
    if (!session) return null;
    if (session.expires_at <= nowSeconds()) {
      this.deleteSession(token);
      return null;
    }
    const user = this.db
      .prepare("SELECT id, username, created_at FROM users WHERE id = ?")
      .get(session.user_id) as PublicUser | undefined;
    return user ?? null;
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  /** Delete all expired sessions; returns the number removed. */
  pruneExpiredSessions(): number {
    const info = this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowSeconds());
    return info.changes;
  }

  /**
   * One-time bootstrap, run when the store has no users. Priority:
   *   1. `PAPYRI_USERNAME` + `PAPYRI_PASSWORD` set → seed that admin (any env).
   *   2. `allowDemoSeed` true → seed the well-known dev demo admin, logged
   *      loudly. Intended for local `pnpm dev` only (see `demoSeedActive`).
   *   3. otherwise → leave empty; every login fails closed (warning logged).
   *
   * `allowDemoSeed` is an explicit argument (not read from the environment
   * here) so the policy lives in one place (`demoSeedActive`) and tests stay
   * deterministic.
   */
  async seed({ allowDemoSeed = false }: { allowDemoSeed?: boolean } = {}): Promise<void> {
    if (this.userCount() > 0) return;
    const username = process.env.PAPYRI_USERNAME;
    const password = process.env.PAPYRI_PASSWORD;
    if (username && password) {
      try {
        await this.createUser(username, password);
        console.log(`[auth] seeded initial admin user "${username}" from environment`);
      } catch (err) {
        console.warn(`[auth] failed to seed admin from environment: ${String(err)}`);
      }
      return;
    }
    if (allowDemoSeed) {
      try {
        await this.createUser(DEMO_USERNAME, DEMO_PASSWORD);
        console.warn(
          `[auth] DEV demo admin seeded: "${DEMO_USERNAME}" / "${DEMO_PASSWORD}" — ` +
            "local development only. Set PAPYRI_USERNAME/PAPYRI_PASSWORD for a real " +
            "admin, or PAPYRI_DEV_SEED=0 to disable this."
        );
      } catch (err) {
        console.warn(`[auth] failed to seed demo admin: ${String(err)}`);
      }
      return;
    }
    console.warn(
      "[auth] no users exist and PAPYRI_USERNAME/PAPYRI_PASSWORD are unset — " +
        "all logins will fail until a user is created (set PAPYRI_DEV_SEED=1 to " +
        "seed a demo admin for local development)"
    );
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Shared singleton (app use)
// ---------------------------------------------------------------------------

let _cached: Promise<AuthDb> | null = null;

async function openAuthDb(): Promise<AuthDb> {
  const fs = await import(/* @vite-ignore */ "node:fs");
  const path = await import(/* @vite-ignore */ "node:path");
  const os = await import(/* @vite-ignore */ "node:os");
  const sqliteMod = (await import(/* @vite-ignore */ "better-sqlite3")) as {
    default: typeof BetterSqlite3;
  };
  const Database = sqliteMod.default;

  const dbPath = process.env.PAPYRI_AUTH_DB ?? path.join(os.homedir(), ".papyri", "auth.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath) as BetterSqlite3.Database;
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  const auth = new AuthDb(db);
  await auth.seed({ allowDemoSeed: demoSeedActive() });
  auth.pruneExpiredSessions();
  return auth;
}

/** Process-wide shared auth store. */
export async function getAuthDb(): Promise<AuthDb> {
  if (!_cached) _cached = openAuthDb();
  return _cached;
}
