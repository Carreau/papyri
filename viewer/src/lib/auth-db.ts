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
 *   users           — id, username (unique), password_hash, is_admin, created_at,
 *                     github_username (nullable)
 *   sessions        — token (random), user_id, created_at, expires_at
 *   projects        — id, name (unique package/module name), created_at
 *   project_members — (project_id, user_id) — who may upload which project
 *   upload_tokens   — id, user_id, token_hash (unique), name, project_id,
 *                     created_at, last_used_at, expires_at — per-user personal
 *                     upload tokens
 *
 * Authorization model: a `project` is a package/module name. An admin
 * (`users.is_admin`) creates projects and assigns users to them. A user mints
 * `upload_tokens` (shown once, only the SHA-256 is stored); presenting such a
 * token to `PUT /api/bundle` authorizes uploading any project that token's
 * user is a member of (admins may upload any project). Authority is resolved
 * dynamically from current membership, so revoking a membership takes effect
 * immediately without touching the token.
 *
 * A token may optionally be scoped to a single project (`upload_tokens.project_id`):
 * when set, that token may upload only that one project (subject to the same
 * live membership check), narrowing the user's full authority. A null
 * `project_id` means "any project the user may upload" — the default.
 *
 * Passwords are hashed with Argon2id (`@node-rs/argon2`, the OWASP-recommended
 * password hash) using its built-in per-hash random salt; the encoded
 * `$argon2id$…` string carries its own parameters and is verified in constant
 * time. Sessions are opaque random tokens stored server-side with an explicit
 * expiry, so a session can be revoked (logout, user delete) and is rejected
 * once expired — unlike the previous unsigned, never-verified
 * `base64(user:timestamp)` cookie.
 */
import { randomBytes, createHash } from "node:crypto";
// Type-only; erased at compile time. Both this and `better-sqlite3` ship native
// bindings, so the concrete modules are loaded lazily via dynamic import (see
// `argon2()` / `openAuthDb()`) rather than statically bundled by Vite.
import type * as Argon2 from "@node-rs/argon2";
import type BetterSqlite3 from "better-sqlite3";

/** Cookie name carrying the session token. */
export const SESSION_COOKIE = "papyri_session_token";

/** Session lifetime in seconds (7 days). */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Prefix marking a papyri personal upload token. The `PUT /api/bundle` auth
 * path uses it to tell a per-user token apart from the global
 * `PAPYRI_UPLOAD_TOKEN` before doing a DB lookup.
 */
export const UPLOAD_TOKEN_PREFIX = "papyri_pat_";

/** Mint a fresh personal upload token (the secret shown to the user once). */
export function generateUploadToken(): string {
  return UPLOAD_TOKEN_PREFIX + randomBytes(24).toString("hex");
}

/**
 * Hash an upload token for storage / lookup. Upload tokens are high-entropy
 * random secrets, so a single fast SHA-256 (not a slow password hash) is the
 * right tool: it allows an indexed equality lookup and leaks nothing useful if
 * the table is read. Returns a lowercase hex digest.
 */
export function hashUploadToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

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
  is_admin: number;
  created_at: number;
  github_username: string | null;
}

/** Public user view — never carries the password hash. */
export interface PublicUser {
  id: number;
  username: string;
  is_admin: boolean;
  created_at: number;
  github_username: string | null;
}

export interface SessionRow {
  token: string;
  user_id: number;
  created_at: number;
  expires_at: number;
}

/** A project (a package/module name) users can be assigned upload rights on. */
export interface Project {
  id: number;
  name: string;
  created_at: number;
}

/**
 * Public view of an upload token. Never carries the secret or its hash — the
 * plaintext is returned exactly once, at creation, by `createUploadToken`.
 */
export interface PublicUploadToken {
  id: number;
  user_id: number;
  name: string | null;
  /** Project this token is scoped to, or null when it may upload any project. */
  project_id: number | null;
  /** Name of the scoped project (joined for display), or null when unscoped. */
  project_name: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

/**
 * A successfully resolved upload token: its owning user plus the project it is
 * scoped to (null = any project the user may upload). The upload endpoint uses
 * `projectName` to reject uploads that target a different project.
 */
export interface ResolvedUploadToken {
  user: PublicUser;
  projectName: string | null;
}

/** Map a raw users row (with 0/1 is_admin) to the public boolean-typed view. */
function toPublicUser(row: {
  id: number;
  username: string;
  is_admin: number;
  created_at: number;
  github_username?: string | null;
}): PublicUser {
  return {
    id: row.id,
    username: row.username,
    is_admin: !!row.is_admin,
    created_at: row.created_at,
    github_username: row.github_username ?? null,
  };
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
 * Project-name rule. A project is a package/module name, so this mirrors the
 * `isSafeSegment` constraint the upload endpoint enforces on `bundle.module`
 * (no path separators, no traversal) while staying to a sane PyPI-ish charset.
 */
const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidProjectName(name: unknown): name is string {
  return typeof name === "string" && PROJECT_NAME_RE.test(name);
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
        id              INTEGER PRIMARY KEY,
        username        TEXT    NOT NULL UNIQUE,
        password_hash   TEXT    NOT NULL,
        is_admin        INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        github_username TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT    PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id         INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_members (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS upload_tokens (
        id           INTEGER PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash   TEXT    NOT NULL UNIQUE,
        name         TEXT,
        project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
      CREATE INDEX IF NOT EXISTS idx_members_user ON project_members (user_id);
      CREATE INDEX IF NOT EXISTS idx_tokens_user ON upload_tokens (user_id);
    `);

    // Roles were added after the first deployments. If an older auth.db
    // predates the `is_admin` column, add it and promote every existing user:
    // before roles existed, any logged-in user could reach /admin, so leaving
    // them all at the default 0 would lock everyone out of the admin tools.
    const userCols = this.db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    if (!userCols.some((c) => c.name === "is_admin")) {
      this.db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
      this.db.exec("UPDATE users SET is_admin = 1");
    }

    // Per-project token scoping was added after the first deployments. An older
    // auth.db has `upload_tokens` without `project_id`; add it (nullable, so
    // existing tokens stay "any project the user may upload").
    const tokenCols = this.db.prepare("PRAGMA table_info(upload_tokens)").all() as {
      name: string;
    }[];
    if (!tokenCols.some((c) => c.name === "project_id")) {
      this.db.exec(
        "ALTER TABLE upload_tokens ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE"
      );
    }

    // GitHub username was added after early deployments.
    if (!userCols.some((c) => c.name === "github_username")) {
      this.db.exec("ALTER TABLE users ADD COLUMN github_username TEXT");
    }
  }

  adminCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").get() as {
      n: number;
    };
    return row.n;
  }

  userCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return row.n;
  }

  /** Create a user; throws if the username already exists or is invalid. */
  async createUser(username: string, password: string, isAdmin = false): Promise<PublicUser> {
    if (!isValidUsername(username)) {
      throw new Error("invalid username");
    }
    if (typeof password !== "string" || password.length < 8) {
      throw new Error("password must be at least 8 characters");
    }
    const created_at = nowSeconds();
    const passwordHash = await hashPassword(password);
    const info = this.db
      .prepare(
        "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(username, passwordHash, isAdmin ? 1 : 0, created_at);
    return {
      id: Number(info.lastInsertRowid),
      username,
      is_admin: isAdmin,
      created_at,
      github_username: null,
    };
  }

  listUsers(): PublicUser[] {
    return (
      this.db
        .prepare(
          "SELECT id, username, is_admin, created_at, github_username FROM users ORDER BY username"
        )
        .all() as Array<{
        id: number;
        username: string;
        is_admin: number;
        created_at: number;
        github_username: string | null;
      }>
    ).map(toPublicUser);
  }

  getUser(id: number): PublicUser | null {
    const row = this.db
      .prepare("SELECT id, username, is_admin, created_at, github_username FROM users WHERE id = ?")
      .get(id) as
      | {
          id: number;
          username: string;
          is_admin: number;
          created_at: number;
          github_username: string | null;
        }
      | undefined;
    return row ? toPublicUser(row) : null;
  }

  /**
   * Set or clear a user's linked GitHub username. Pass null to unlink.
   * Returns false when the user does not exist.
   */
  setGithubUsername(userId: number, githubUsername: string | null): boolean {
    const info = this.db
      .prepare("UPDATE users SET github_username = ? WHERE id = ?")
      .run(githubUsername, userId);
    return info.changes > 0;
  }

  /**
   * Grant or revoke admin on a user. Refuses to demote the last remaining
   * admin (that would lock the admin tools out, with no env fallback). Returns
   * a tagged result so the caller can surface the precise reason.
   */
  setAdmin(
    id: number,
    isAdmin: boolean
  ): { ok: true } | { ok: false; reason: "no-user" | "last-admin" } {
    const user = this.getUser(id);
    if (!user) return { ok: false, reason: "no-user" };
    if (!isAdmin && user.is_admin && this.adminCount() <= 1) {
      return { ok: false, reason: "last-admin" };
    }
    this.db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, id);
    return { ok: true };
  }

  deleteUser(id: number): boolean {
    // Sessions, memberships, and upload tokens cascade via FK; the
    // foreign_keys pragma is enabled in the ctor.
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
      .prepare(
        "SELECT id, username, password_hash, is_admin, created_at, github_username FROM users WHERE username = ?"
      )
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
    return this.getUser(session.user_id);
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
        await this.createUser(username, password, true);
        console.log(`[auth] seeded initial admin user "${username}" from environment`);
      } catch (err) {
        console.warn(`[auth] failed to seed admin from environment: ${String(err)}`);
      }
      return;
    }
    if (allowDemoSeed) {
      try {
        await this.createUser(DEMO_USERNAME, DEMO_PASSWORD, true);
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

  // -------------------------------------------------------------------------
  // Projects + membership
  // -------------------------------------------------------------------------

  /** Create a project (a package/module name); throws on duplicate/invalid. */
  createProject(name: string): Project {
    if (!isValidProjectName(name)) {
      throw new Error("invalid project name");
    }
    const created_at = nowSeconds();
    const info = this.db
      .prepare("INSERT INTO projects (name, created_at) VALUES (?, ?)")
      .run(name, created_at);
    return { id: Number(info.lastInsertRowid), name, created_at };
  }

  listProjects(): Project[] {
    return this.db
      .prepare("SELECT id, name, created_at FROM projects ORDER BY name")
      .all() as Project[];
  }

  getProjectByName(name: string): Project | null {
    const row = this.db
      .prepare("SELECT id, name, created_at FROM projects WHERE name = ?")
      .get(name) as Project | undefined;
    return row ?? null;
  }

  deleteProject(id: number): boolean {
    // Memberships cascade via the FK.
    const info = this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return info.changes > 0;
  }

  /** Assign a user to a project. Idempotent (INSERT OR IGNORE on the PK). */
  addMember(projectId: number, userId: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO project_members (project_id, user_id, created_at) VALUES (?, ?, ?)"
      )
      .run(projectId, userId, nowSeconds());
  }

  removeMember(projectId: number, userId: number): boolean {
    const info = this.db
      .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
      .run(projectId, userId);
    return info.changes > 0;
  }

  /** Users assigned to a project. */
  listMembers(projectId: number): PublicUser[] {
    return (
      this.db
        .prepare(
          "SELECT u.id, u.username, u.is_admin, u.created_at FROM project_members m " +
            "JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.username"
        )
        .all(projectId) as Array<{
        id: number;
        username: string;
        is_admin: number;
        created_at: number;
      }>
    ).map(toPublicUser);
  }

  /** Project names a user is a member of. */
  listUserProjects(userId: number): string[] {
    return (
      this.db
        .prepare(
          "SELECT p.name FROM project_members m JOIN projects p ON p.id = m.project_id " +
            "WHERE m.user_id = ? ORDER BY p.name"
        )
        .all(userId) as Array<{ name: string }>
    ).map((r) => r.name);
  }

  /**
   * Whether `userId` may upload the project `projectName`. Admins may upload
   * anything; otherwise the user must be an explicit member. Resolved live, so
   * membership changes take effect immediately for existing tokens.
   */
  canUserUploadProject(userId: number, projectName: string): boolean {
    const user = this.getUser(userId);
    if (!user) return false;
    if (user.is_admin) return true;
    const row = this.db
      .prepare(
        "SELECT 1 AS ok FROM project_members m JOIN projects p ON p.id = m.project_id " +
          "WHERE m.user_id = ? AND p.name = ?"
      )
      .get(userId, projectName) as { ok: number } | undefined;
    return row !== undefined;
  }

  // -------------------------------------------------------------------------
  // Personal upload tokens
  // -------------------------------------------------------------------------

  /**
   * Mint a personal upload token for `userId`. Returns the public record plus
   * the plaintext secret — the ONLY time the plaintext is available; only its
   * SHA-256 is persisted. `ttlSeconds` null/undefined means no expiry.
   *
   * `projectId` null/undefined leaves the token unscoped (it may upload any
   * project its user may); a non-null id scopes it to that single project. The
   * caller is responsible for checking the user may upload that project — the
   * scope only ever narrows the user's standing authority, never widens it.
   */
  createUploadToken(
    userId: number,
    name: string | null = null,
    ttlSeconds: number | null = null,
    projectId: number | null = null
  ): { token: PublicUploadToken; secret: string } {
    const secret = generateUploadToken();
    const tokenHash = hashUploadToken(secret);
    const created_at = nowSeconds();
    const expires_at = ttlSeconds != null ? created_at + ttlSeconds : null;
    const info = this.db
      .prepare(
        "INSERT INTO upload_tokens (user_id, token_hash, name, project_id, created_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(userId, tokenHash, name, projectId, created_at, expires_at);
    const project_name =
      projectId != null
        ? ((
            this.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as
              | { name: string }
              | undefined
          )?.name ?? null)
        : null;
    return {
      token: {
        id: Number(info.lastInsertRowid),
        user_id: userId,
        name,
        project_id: projectId,
        project_name,
        created_at,
        last_used_at: null,
        expires_at,
      },
      secret,
    };
  }

  /** A user's tokens (public view; never the hash). */
  listUploadTokens(userId: number): PublicUploadToken[] {
    return this.db
      .prepare(
        "SELECT t.id, t.user_id, t.name, t.project_id, p.name AS project_name, " +
          "t.created_at, t.last_used_at, t.expires_at FROM upload_tokens t " +
          "LEFT JOIN projects p ON p.id = t.project_id " +
          "WHERE t.user_id = ? ORDER BY t.created_at DESC"
      )
      .all(userId) as PublicUploadToken[];
  }

  /** Revoke a token, scoped to its owner so one user can't delete another's. */
  revokeUploadToken(id: number, userId: number): boolean {
    const info = this.db
      .prepare("DELETE FROM upload_tokens WHERE id = ? AND user_id = ?")
      .run(id, userId);
    return info.changes > 0;
  }

  /**
   * Resolve a plaintext upload token to its owning user and project scope,
   * enforcing expiry, and stamp `last_used_at`. Returns null when the token is
   * unknown, expired, or its user has been removed. `projectName` is null for
   * an unscoped token (any project the user may upload).
   */
  resolveUploadToken(secret: string): ResolvedUploadToken | null {
    if (typeof secret !== "string" || !secret.startsWith(UPLOAD_TOKEN_PREFIX)) return null;
    const tokenHash = hashUploadToken(secret);
    const row = this.db
      .prepare(
        "SELECT t.id, t.user_id, t.expires_at, p.name AS project_name FROM upload_tokens t " +
          "LEFT JOIN projects p ON p.id = t.project_id WHERE t.token_hash = ?"
      )
      .get(tokenHash) as
      | { id: number; user_id: number; expires_at: number | null; project_name: string | null }
      | undefined;
    if (!row) return null;
    if (row.expires_at != null && row.expires_at <= nowSeconds()) {
      this.db.prepare("DELETE FROM upload_tokens WHERE id = ?").run(row.id);
      return null;
    }
    this.db
      .prepare("UPDATE upload_tokens SET last_used_at = ? WHERE id = ?")
      .run(nowSeconds(), row.id);
    const user = this.getUser(row.user_id);
    if (!user) return null;
    return { user, projectName: row.project_name };
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
