import { homedir } from "node:os";
import { join } from "node:path";

export function ingestDb(): string {
  return (
    process.env.PAPYRI_INGEST_DB ??
    join(homedir(), ".papyri", "ingest", "papyri.db")
  );
}
