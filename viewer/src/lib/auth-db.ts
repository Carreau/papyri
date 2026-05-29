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
 * Passwords are hashed with scrypt (node:crypto, no extra dependency) using a
 * per-user random salt; verification is constant-time. Sessions are opaque
 * random tokens stored server-side with an explicit expiry, so a session can
 * be revoked (logout, user delete) and is rejected once expired — unlike the
 * previous unsigned, never-verified `base64(user:timestamp)` cookie.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
// Type-only; erased at compile time. The concrete module is loaded lazily in
// `getAuthDb()` via dynamic import, matching `backends.ts`.
import type BetterSqlite3 from "better-sqlite3";

/** Cookie name carrying the session token. */
export const SESSION_COOKIE = "papyri_session_token";

/** Session lifetime in seconds (7 days). */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const SCRYPT_KEYLEN = 64;
// A valid scrypt hash for an empty-ish password, used as a constant-time decoy
// when the requested username does not exist so login timing does not reveal
// account existence. Computed once at module load.
const DECOY_HASH = hashPassword(randomBytes(16).toString("hex"));

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

/** Hash a plaintext password as `scrypt$<saltHex>$<derivedHex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Constant-time verification of a plaintext password against a stored hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  if (expected.length === 0) return false;
  const derived = scryptSync(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
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
  createUser(username: string, password: string): PublicUser {
    if (!isValidUsername(username)) {
      throw new Error("invalid username");
    }
    if (typeof password !== "string" || password.length < 8) {
      throw new Error("password must be at least 8 characters");
    }
    const created_at = nowSeconds();
    const info = this.db
      .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run(username, hashPassword(password), created_at);
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
   * Verify a login. Returns the matching user row on success, else null.
   * Always performs a scrypt comparison (against a decoy hash when the user
   * is unknown) so timing does not reveal whether the username exists.
   */
  verifyLogin(username: string, password: string): UserRow | null {
    const user = this.db
      .prepare("SELECT id, username, password_hash, created_at FROM users WHERE username = ?")
      .get(username) as UserRow | undefined;
    if (!user) {
      verifyPassword(password, DECOY_HASH);
      return null;
    }
    if (!verifyPassword(password, user.password_hash)) return null;
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
   * One-time bootstrap: if there are no users yet and both PAPYRI_USERNAME
   * and PAPYRI_PASSWORD are set, create that admin. With no users and no env
   * credentials the store stays empty and every login fails closed (a warning
   * is logged so the operator knows why).
   */
  seedFromEnv(): void {
    if (this.userCount() > 0) return;
    const username = process.env.PAPYRI_USERNAME;
    const password = process.env.PAPYRI_PASSWORD;
    if (username && password) {
      try {
        this.createUser(username, password);
        console.log(`[auth] seeded initial admin user "${username}" from environment`);
      } catch (err) {
        console.warn(`[auth] failed to seed admin from environment: ${String(err)}`);
      }
    } else {
      console.warn(
        "[auth] no users exist and PAPYRI_USERNAME/PAPYRI_PASSWORD are unset — " +
          "all logins will fail until a user is created"
      );
    }
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
  auth.seedFromEnv();
  auth.pruneExpiredSessions();
  return auth;
}

/** Process-wide shared auth store. */
export async function getAuthDb(): Promise<AuthDb> {
  if (!_cached) _cached = openAuthDb();
  return _cached;
}
