import { homedir } from "node:os";
import { join } from "node:path";

export function ingestDir(): string {
  return (
    process.env.PAPYRI_INGEST_DIR ??
    join(homedir(), ".papyri", "ingest")
  );
}

export function ingestDb(): string {
  return (
    process.env.PAPYRI_INGEST_DB ??
    join(homedir(), ".papyri", "ingest", "papyri.db")
  );
}
