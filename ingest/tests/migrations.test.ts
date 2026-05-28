/**
 * Tests for applyMigrations (ingest.ts): the PRAGMA user_version migration
 * runner that brings a SQLite DB up to the latest schema on startup.
 *
 * Runs against an in-memory better-sqlite3 DB so no on-disk fixture is
 * needed. The expected final version tracks the highest-numbered file in
 * ingest/migrations/.
 */

import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/ingest.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Highest migration number on disk = the version a fully-migrated DB lands on. */
function latestVersion(): number {
  return Math.max(
    ...readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => Number.parseInt(f.slice(0, 4), 10)),
  );
}

function userVersion(db: Database.Database): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

describe("applyMigrations", () => {
  it("applies every migration to a fresh DB and records the version", () => {
    const db = new Database(":memory:");
    applyMigrations(db, migrationsDir);

    expect(userVersion(db)).toBe(latestVersion());
    // The migration that originally motivated the runner: bundles.content_hash
    // is added by an ALTER, which the version gate must run exactly once.
    expect(hasColumn(db, "bundles", "content_hash")).toBe(true);
    // A representative table + index from the base schema exist.
    expect(hasColumn(db, "nodes", "package")).toBe(true);
    db.close();
  });

  it("is a no-op on a second run", () => {
    const db = new Database(":memory:");
    applyMigrations(db, migrationsDir);
    const after = userVersion(db);
    // Re-running must not throw (e.g. duplicate column / table already
    // exists) and must leave the version unchanged.
    expect(() => applyMigrations(db, migrationsDir)).not.toThrow();
    expect(userVersion(db)).toBe(after);
    db.close();
  });

  it("adds content_hash to a DB created before that migration existed", () => {
    // Simulate the live-DB bug: bundles exists without content_hash and
    // user_version is still 0 (the pre-runner state).
    const db = new Database(":memory:");
    db.prepare(
      "CREATE TABLE bundles (module TEXT NOT NULL, version TEXT NOT NULL," +
        " bundle_size_bytes INTEGER NOT NULL, ingested_at INTEGER NOT NULL," +
        " PRIMARY KEY (module, version))",
    ).run();
    expect(hasColumn(db, "bundles", "content_hash")).toBe(false);
    expect(userVersion(db)).toBe(0);

    applyMigrations(db, migrationsDir);

    expect(hasColumn(db, "bundles", "content_hash")).toBe(true);
    expect(userVersion(db)).toBe(latestVersion());
    db.close();
  });
});
