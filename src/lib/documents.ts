import { getDb, DocumentRow, PositionRow, CollectionRow } from "./db";
import type { DocumentDetail, DocumentSummary, Collection } from "@/types/document";

function rowToSummary(
  d: DocumentRow,
  position: PositionRow | undefined,
  collections: CollectionRow[]
): DocumentSummary {
  const progressPercent =
    d.char_count > 0 && position
      ? Math.min(100, Math.max(0, Math.round((position.char_index / d.char_count) * 100)))
      : 0;
  return {
    id: d.id,
    title: d.title,
    sourceType: d.source_type as DocumentSummary["sourceType"],
    originalFilename: d.original_filename,
    wordCount: d.word_count,
    charCount: d.char_count,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    collections: collections.map((c) => ({ id: c.id, name: c.name })),
    position: position
      ? {
          charIndex: position.char_index,
          rate: position.rate,
          voiceName: position.voice_name,
          updatedAt: position.updated_at,
        }
      : null,
    progressPercent,
  };
}

export function listDocuments(): DocumentSummary[] {
  const db = getDb();
  const docs = db
    .prepare(`SELECT * FROM documents ORDER BY updated_at DESC`)
    .all() as DocumentRow[];
  if (docs.length === 0) return [];

  const ids = docs.map((d) => d.id);
  const placeholders = ids.map(() => "?").join(",");

  const positions = db
    .prepare(`SELECT * FROM reading_positions WHERE document_id IN (${placeholders})`)
    .all(...ids) as PositionRow[];
  const posMap = new Map(positions.map((p) => [p.document_id, p]));

  const colls = db
    .prepare(
      `SELECT c.*, dc.document_id AS _doc_id
       FROM collections c
       JOIN document_collections dc ON dc.collection_id = c.id
       WHERE dc.document_id IN (${placeholders})
       ORDER BY c.name ASC`
    )
    .all(...ids) as Array<CollectionRow & { _doc_id: string }>;
  const collMap = new Map<string, CollectionRow[]>();
  for (const c of colls) {
    const list = collMap.get(c._doc_id) ?? [];
    list.push({ id: c.id, name: c.name, created_at: c.created_at });
    collMap.set(c._doc_id, list);
  }

  return docs.map((d) => rowToSummary(d, posMap.get(d.id), collMap.get(d.id) ?? []));
}

export function getDocument(id: string): DocumentDetail | null {
  const db = getDb();
  const d = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as
    | DocumentRow
    | undefined;
  if (!d) return null;
  const position = db
    .prepare(`SELECT * FROM reading_positions WHERE document_id = ?`)
    .get(id) as PositionRow | undefined;
  const colls = db
    .prepare(
      `SELECT c.* FROM collections c
       JOIN document_collections dc ON dc.collection_id = c.id
       WHERE dc.document_id = ? ORDER BY c.name ASC`
    )
    .all(id) as CollectionRow[];
  const summary = rowToSummary(d, position, colls);

  let pageRanges: DocumentDetail["pageRanges"] = null;
  if (d.pages_meta) {
    try {
      const parsed = JSON.parse(d.pages_meta);
      if (Array.isArray(parsed)) pageRanges = parsed;
    } catch {}
  }
  return { ...summary, content: d.content, pageRanges };
}

export function insertDocument(doc: {
  id: string;
  title: string;
  sourceType: "pdf" | "epub" | "text";
  originalFilename: string | null;
  content: string;
  wordCount: number;
  storedPath?: string | null;
  pageRanges?: Array<{ charStart: number; charEnd: number }> | null;
}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO documents (id, title, source_type, original_filename, content, word_count, char_count, stored_path, pages_meta)
     VALUES (@id, @title, @sourceType, @originalFilename, @content, @wordCount, @charCount, @storedPath, @pagesMeta)`
  ).run({
    ...doc,
    charCount: doc.content.length,
    storedPath: doc.storedPath ?? null,
    pagesMeta: doc.pageRanges ? JSON.stringify(doc.pageRanges) : null,
  });
}

export function getStoredPath(id: string): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT stored_path FROM documents WHERE id = ?`)
    .get(id) as { stored_path: string | null } | undefined;
  return row?.stored_path ?? null;
}

export function deleteDocument(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
}

export function updateDocumentTitle(id: string, title: string) {
  const db = getDb();
  db.prepare(
    `UPDATE documents SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(title, id);
}

/**
 * Replace a document's text content + per-page char ranges. Used by the
 * auto-OCR pipeline (src/lib/ocr.ts) once ocrmypdf produces a PDF with
 * a real text layer and we re-parse it. Mirrors insertDocument's shape
 * so the data stays identical to a normal upload — char_count comes
 * from content.length, pages_meta from JSON-encoded pageRanges.
 */
export function updateDocumentOcrResult(
  id: string,
  patch: {
    content: string;
    wordCount: number;
    pageRanges: Array<{ charStart: number; charEnd: number }> | null;
  }
) {
  const db = getDb();
  db.prepare(
    `UPDATE documents
        SET content = @content,
            word_count = @wordCount,
            char_count = @charCount,
            pages_meta = @pagesMeta,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = @id`
  ).run({
    id,
    content: patch.content,
    wordCount: patch.wordCount,
    charCount: patch.content.length,
    pagesMeta: patch.pageRanges ? JSON.stringify(patch.pageRanges) : null,
  });
}

export function upsertPosition(
  id: string,
  charIndex: number,
  rate: number,
  voiceName: string | null
) {
  const db = getDb();
  db.prepare(
    `INSERT INTO reading_positions (document_id, char_index, rate, voice_name, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(document_id) DO UPDATE SET
       char_index = excluded.char_index,
       rate = excluded.rate,
       voice_name = excluded.voice_name,
       updated_at = CURRENT_TIMESTAMP`
  ).run(id, charIndex, rate, voiceName);
}

export function listCollections(): (Collection & { documentCount: number })[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.created_at, COUNT(dc.document_id) AS document_count
       FROM collections c
       LEFT JOIN document_collections dc ON dc.collection_id = c.id
       GROUP BY c.id ORDER BY c.name ASC`
    )
    .all() as Array<{ id: string; name: string; created_at: string; document_count: number }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    documentCount: r.document_count,
  }));
}

export function createCollection(id: string, name: string) {
  const db = getDb();
  db.prepare(`INSERT INTO collections (id, name) VALUES (?, ?)`).run(id, name.trim());
}

export function deleteCollection(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM collections WHERE id = ?`).run(id);
}

export function setDocumentCollections(documentId: string, collectionIds: string[]) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM document_collections WHERE document_id = ?`).run(documentId);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO document_collections (document_id, collection_id) VALUES (?, ?)`
    );
    for (const cid of collectionIds) insert.run(documentId, cid);
  });
  tx();
}
