//! Trivial in-memory SQLite cross-link index. The real viewer needs a graph
//! across many bundles; this prototype just demonstrates the shape — one
//! row per (bundle, qa) so a hosted multi-bundle service could query it the
//! same way.

use std::sync::Mutex;

use anyhow::Result;
use rusqlite::{params, Connection};

use crate::ir::Bundle;

pub struct Index {
    conn: Mutex<Connection>,
}

impl Index {
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE symbol (
                 bundle TEXT NOT NULL,
                 qa     TEXT NOT NULL,
                 kind   TEXT,
                 PRIMARY KEY (bundle, qa)
             );
             CREATE VIRTUAL TABLE symbol_fts USING fts5(qa, bundle UNINDEXED);",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn ingest(&self, bundle: &Bundle) -> Result<()> {
        let mut guard = self.conn.lock().unwrap();
        let tx = guard.transaction()?;
        for (qa, doc) in &bundle.api {
            tx.execute(
                "INSERT OR REPLACE INTO symbol(bundle, qa, kind) VALUES (?1, ?2, ?3)",
                params![bundle.module, qa, doc.item_type],
            )?;
            tx.execute(
                "INSERT INTO symbol_fts(qa, bundle) VALUES (?1, ?2)",
                params![qa, bundle.module],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn search(&self, q: &str) -> Result<Vec<(String, String)>> {
        if q.trim().is_empty() {
            return Ok(vec![]);
        }
        let pattern = format!("{}*", q.trim());
        let guard = self.conn.lock().unwrap();
        let mut stmt = guard
            .prepare("SELECT bundle, qa FROM symbol_fts WHERE qa MATCH ?1 LIMIT 50")?;
        let rows = stmt
            .query_map([pattern], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}
