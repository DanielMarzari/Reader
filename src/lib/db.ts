import Database from "better-sqlite3";
import path from "path";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath =
      process.env.DATABASE_PATH || path.join(process.cwd(), "reader.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    ensureAllTables(db);
  }
  return db;
}

function ensureAllTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL,
      original_filename TEXT,
      content TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      stored_path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Additive migration for older databases
  const cols = db.prepare(`PRAGMA table_info(documents)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "stored_path")) {
    db.exec(`ALTER TABLE documents ADD COLUMN stored_path TEXT`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS reading_positions (
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      char_index INTEGER NOT NULL DEFAULT 0,
      rate REAL NOT NULL DEFAULT 1.0,
      voice_name TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS document_collections (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      PRIMARY KEY (document_id, collection_id)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_coll_doc ON document_collections(document_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_coll_coll ON document_collections(collection_id)`);
}

export type DocumentRow = {
  id: string;
  title: string;
  source_type: string;
  original_filename: string | null;
  content: string;
  word_count: number;
  char_count: number;
  stored_path: string | null;
  created_at: string;
  updated_at: string;
};

export type PositionRow = {
  document_id: string;
  char_index: number;
  rate: number;
  voice_name: string | null;
  updated_at: string;
};

export type CollectionRow = {
  id: string;
  name: string;
  created_at: string;
};
