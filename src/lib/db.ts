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
      pages_meta TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Additive migrations for older databases
  const cols = db.prepare(`PRAGMA table_info(documents)`).all() as Array<{ name: string }>;
  const has = (n: string) => cols.some((c) => c.name === n);
  if (!has("stored_path")) db.exec(`ALTER TABLE documents ADD COLUMN stored_path TEXT`);
  if (!has("pages_meta")) db.exec(`ALTER TABLE documents ADD COLUMN pages_meta TEXT`);

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

  // Voice Lab — profiles uploaded from the Voice Studio local tool, plus
  // bearer tokens that authenticate those uploads. sample_path is an
  // absolute path under STORAGE_DIR (outside /public so requests are
  // mediated by the API route).
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('cloned','designed','uploaded')),
      engine TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      sample_path TEXT,
      cover_path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Additive migration: older DBs might be missing cover_path.
  const vCols = db.prepare(`PRAGMA table_info(voice_profiles)`).all() as Array<{ name: string }>;
  if (!vCols.some((c) => c.name === "cover_path")) {
    db.exec(`ALTER TABLE voice_profiles ADD COLUMN cover_path TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_voice_profiles_created ON voice_profiles(created_at DESC)`
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_lab_tokens (
      token_hash TEXT PRIMARY KEY,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT
    )
  `);
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
  pages_meta: string | null;
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

export type VoiceProfileRow = {
  id: string;
  name: string;
  kind: "cloned" | "designed" | "uploaded";
  engine: string;
  meta_json: string;
  sample_path: string | null;
  cover_path: string | null;
  created_at: string;
};

export type VoiceLabTokenRow = {
  token_hash: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
};
