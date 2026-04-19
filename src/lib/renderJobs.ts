import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDb, type RenderJobRow, type RenderJobStatus } from "./db";

// All audiobook storage lives under STORAGE_DIR/audiobooks/<doc>/<voice>/.
// Voice Studio uploads chunk files here; the Reader player reads from here.
function storageRoot(): string {
  return process.env.STORAGE_DIR || path.join(process.cwd(), "storage");
}

export function audiobookDir(docId: string, voiceId: string): string {
  return path.join(storageRoot(), "audiobooks", docId, voiceId);
}

export function audiobookChunkPath(
  docId: string,
  voiceId: string,
  chunkIndex: number
): string {
  // 4-digit zero-padded so ls sorts naturally up to 9999 chunks
  // (~6 hours of speech; plenty).
  const n = String(chunkIndex).padStart(4, "0");
  return path.join(audiobookDir(docId, voiceId), `chunk_${n}.mp3`);
}

export function audiobookManifestPath(docId: string, voiceId: string): string {
  return path.join(audiobookDir(docId, voiceId), "manifest.json");
}

// ---- Job shape exposed to routes/UI (camelCase) ----

export type RenderJob = {
  id: string;
  documentId: string;
  voiceId: string;
  status: RenderJobStatus;
  priority: "high" | "low";
  chunksTotal: number | null;
  chunksDone: number;
  error: string | null;
  requestedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
};

function rowTo(r: RenderJobRow): RenderJob {
  return {
    id: r.id,
    documentId: r.document_id,
    voiceId: r.voice_id,
    status: r.status,
    priority: r.priority,
    chunksTotal: r.chunks_total,
    chunksDone: r.chunks_done,
    error: r.error,
    requestedAt: r.requested_at,
    claimedAt: r.claimed_at,
    completedAt: r.completed_at,
  };
}

// ---- Manifest (what Voice Studio uploads alongside the chunks) ----

export type AudiobookChunkMeta = {
  index: number;           // 1-based
  charStart: number;       // inclusive, in the original document text
  charEnd: number;         // exclusive
  durationMs: number;      // measured from the MP3 by Voice Studio
  /** Optional per-word offsets within the chunk, ms from chunk start.
   *  When present the player uses exact timings; otherwise linear estimation
   *  inside the chunk (good enough for most playback). */
  wordOffsetsMs?: number[];
};

export type AudiobookManifest = {
  documentId: string;
  voiceId: string;
  voiceName: string;
  engine: string;           // "f5" | "xtts" | etc.
  createdAt: string;        // ISO8601 UTC
  totalDurationMs: number;
  chunks: AudiobookChunkMeta[];
};

// ---- CRUD ----

export function listRenderJobs(args?: {
  status?: RenderJobStatus | RenderJobStatus[];
  documentId?: string;
  voiceId?: string;
  limit?: number;
}): RenderJob[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (args?.status) {
    const s = Array.isArray(args.status) ? args.status : [args.status];
    where.push(`status IN (${s.map(() => "?").join(",")})`);
    params.push(...s);
  }
  if (args?.documentId) {
    where.push(`document_id = ?`);
    params.push(args.documentId);
  }
  if (args?.voiceId) {
    where.push(`voice_id = ?`);
    params.push(args.voiceId);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // Highest priority first, then oldest first (FIFO within a priority).
  const sql = `
    SELECT * FROM render_jobs
    ${whereSql}
    ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, requested_at ASC
    ${args?.limit ? "LIMIT " + Math.max(1, Math.min(100, args.limit)) : ""}
  `;
  const rows = db.prepare(sql).all(...params) as RenderJobRow[];
  return rows.map(rowTo);
}

export function getRenderJob(id: string): RenderJob | null {
  const row = getDb()
    .prepare(`SELECT * FROM render_jobs WHERE id = ?`)
    .get(id) as RenderJobRow | undefined;
  return row ? rowTo(row) : null;
}

export function getRenderJobForPair(
  documentId: string,
  voiceId: string
): RenderJob | null {
  const row = getDb()
    .prepare(`SELECT * FROM render_jobs WHERE document_id = ? AND voice_id = ?`)
    .get(documentId, voiceId) as RenderJobRow | undefined;
  return row ? rowTo(row) : null;
}

/** Queue a job. If one already exists for the (doc, voice) pair:
 *   - ready/rendering: returned as-is (caller sees the current state)
 *   - pending: bumped to 'high' priority if a higher one is requested
 *   - failed/cancelled: reset to pending so the worker picks it up again
 */
export function upsertRenderJob(args: {
  documentId: string;
  voiceId: string;
  priority?: "high" | "low";
}): RenderJob {
  const priority = args.priority ?? "high";
  const db = getDb();
  const existing = getRenderJobForPair(args.documentId, args.voiceId);
  if (existing) {
    if (existing.status === "ready" || existing.status === "rendering") {
      return existing;
    }
    // pending / failed / cancelled — reset to pending, bump priority if asked for higher.
    const newPriority =
      priority === "high" || existing.priority === "high" ? "high" : "low";
    db.prepare(
      `UPDATE render_jobs
         SET status = 'pending',
             priority = ?,
             chunks_total = NULL,
             chunks_done = 0,
             error = NULL,
             requested_at = ?,
             claimed_at = NULL,
             completed_at = NULL
       WHERE id = ?`
    ).run(newPriority, new Date().toISOString(), existing.id);
    return getRenderJob(existing.id)!;
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO render_jobs (id, document_id, voice_id, status, priority, requested_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  ).run(id, args.documentId, args.voiceId, priority, new Date().toISOString());
  return getRenderJob(id)!;
}

/** Single-row atomic transition: pending → rendering. Returns the updated
 *  row on success, null if the job wasn't pending (already claimed / done). */
export function claimRenderJob(id: string): RenderJob | null {
  const db = getDb();
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE render_jobs
         SET status = 'rendering', claimed_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(now, id);
  if (info.changes === 0) return null;
  return getRenderJob(id);
}

/** Bump chunks_done when Voice Studio uploads a chunk. `total` fills in
 *  chunks_total if it was still NULL (first chunk carries that knowledge). */
export function incrementRenderProgress(
  id: string,
  total: number | null
): RenderJob | null {
  const db = getDb();
  if (total != null) {
    db.prepare(
      `UPDATE render_jobs
         SET chunks_total = COALESCE(chunks_total, ?),
             chunks_done = chunks_done + 1
       WHERE id = ? AND status = 'rendering'`
    ).run(total, id);
  } else {
    db.prepare(
      `UPDATE render_jobs
         SET chunks_done = chunks_done + 1
       WHERE id = ? AND status = 'rendering'`
    ).run(id);
  }
  return getRenderJob(id);
}

export function completeRenderJob(id: string): RenderJob | null {
  const db = getDb();
  db.prepare(
    `UPDATE render_jobs
       SET status = 'ready', completed_at = ?
     WHERE id = ?`
  ).run(new Date().toISOString(), id);
  return getRenderJob(id);
}

export function failRenderJob(id: string, error: string): RenderJob | null {
  const db = getDb();
  db.prepare(
    `UPDATE render_jobs
       SET status = 'failed', error = ?, completed_at = ?
     WHERE id = ?`
  ).run(error.slice(0, 500), new Date().toISOString(), id);
  return getRenderJob(id);
}

/** User cancel. Also wipes any partial chunks + manifest on disk. */
export function cancelRenderJob(id: string): boolean {
  const job = getRenderJob(id);
  if (!job) return false;
  getDb()
    .prepare(
      `UPDATE render_jobs SET status = 'cancelled', completed_at = ? WHERE id = ?`
    )
    .run(new Date().toISOString(), id);
  try {
    const dir = audiobookDir(job.documentId, job.voiceId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  return true;
}

// ---- Audiobook file helpers ----

export function writeAudiobookChunk(
  documentId: string,
  voiceId: string,
  chunkIndex: number,
  bytes: Buffer
): void {
  const dir = audiobookDir(documentId, voiceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(audiobookChunkPath(documentId, voiceId, chunkIndex), bytes);
}

export function writeAudiobookManifest(
  documentId: string,
  voiceId: string,
  manifest: AudiobookManifest
): void {
  const dir = audiobookDir(documentId, voiceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    audiobookManifestPath(documentId, voiceId),
    JSON.stringify(manifest, null, 2)
  );
}

export function readAudiobookManifest(
  documentId: string,
  voiceId: string
): AudiobookManifest | null {
  const p = audiobookManifestPath(documentId, voiceId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as AudiobookManifest;
  } catch {
    return null;
  }
}

/** List ready audiobooks for a document — one per voice. */
export function listDocumentAudiobooks(documentId: string): Array<{
  voiceId: string;
  manifest: AudiobookManifest;
}> {
  const root = path.join(storageRoot(), "audiobooks", documentId);
  if (!fs.existsSync(root)) return [];
  const out: Array<{ voiceId: string; manifest: AudiobookManifest }> = [];
  for (const voiceId of fs.readdirSync(root)) {
    const m = readAudiobookManifest(documentId, voiceId);
    if (m) out.push({ voiceId, manifest: m });
  }
  return out;
}
