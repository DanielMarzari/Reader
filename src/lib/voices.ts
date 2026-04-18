import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDb, type VoiceProfileRow } from "./db";

// Storage root — one directory per app. Defaults to ./storage next to the
// DB if STORAGE_DIR is not set (useful for local dev). In production we set
// STORAGE_DIR=/var/www/apps/reader/storage in the PM2 ecosystem config.
function storageRoot(): string {
  return process.env.STORAGE_DIR || path.join(process.cwd(), "storage");
}

export function voiceSampleDir(id: string): string {
  return path.join(storageRoot(), "voices", id);
}

export function voiceSamplePath(id: string): string {
  return path.join(voiceSampleDir(id), "sample.mp3");
}

export function voiceCoverPath(id: string, ext: string): string {
  return path.join(voiceSampleDir(id), `cover${ext}`);
}

// ---- Voice profile CRUD ----

export type VoiceProfile = {
  id: string;
  name: string;
  kind: "cloned" | "designed" | "uploaded";
  engine: string;
  createdAt: string;
  design: Record<string, unknown>;
  hasSample: boolean;
  coverUrl: string | null;
};

function rowTo(p: VoiceProfileRow): VoiceProfile {
  let design: Record<string, unknown> = {};
  try {
    design = JSON.parse(p.meta_json) as Record<string, unknown>;
  } catch {
    // Corrupt JSON in storage — surface as empty, don't crash the page.
  }
  const hasCover = Boolean(p.cover_path && fs.existsSync(p.cover_path));
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    engine: p.engine,
    createdAt: p.created_at,
    design,
    hasSample: Boolean(p.sample_path && fs.existsSync(p.sample_path)),
    coverUrl: hasCover ? `/api/voices/${p.id}/cover` : null,
  };
}

export function listVoiceProfiles(): VoiceProfile[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM voice_profiles ORDER BY created_at DESC`)
    .all() as VoiceProfileRow[];
  return rows.map(rowTo);
}

export function getVoiceProfile(id: string): VoiceProfile | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM voice_profiles WHERE id = ?`)
    .get(id) as VoiceProfileRow | undefined;
  return row ? rowTo(row) : null;
}

export function upsertVoiceProfile(args: {
  id: string;
  name: string;
  kind: "cloned" | "designed" | "uploaded";
  engine: string;
  createdAt: string;
  design: Record<string, unknown>;
  sampleBuffer: Buffer;
  /** Optional cover image — when present, displayed instead of the sphere. */
  coverBuffer?: Buffer | null;
  /** Extension for the cover file (e.g. ".png", ".jpg"). */
  coverExt?: string | null;
}): VoiceProfile {
  const db = getDb();

  // Write files first. If anything fails, we haven't polluted the DB.
  const dir = voiceSampleDir(args.id);
  fs.mkdirSync(dir, { recursive: true });
  const samplePath = path.join(dir, "sample.mp3");
  fs.writeFileSync(samplePath, args.sampleBuffer);

  let coverPath: string | null = null;
  if (args.coverBuffer && args.coverExt) {
    coverPath = voiceCoverPath(args.id, args.coverExt);
    fs.writeFileSync(coverPath, args.coverBuffer);
  }

  db.prepare(
    `INSERT INTO voice_profiles (id, name, kind, engine, meta_json, sample_path, cover_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       kind=excluded.kind,
       engine=excluded.engine,
       meta_json=excluded.meta_json,
       sample_path=excluded.sample_path,
       cover_path=COALESCE(excluded.cover_path, voice_profiles.cover_path)`
  ).run(
    args.id,
    args.name,
    args.kind,
    args.engine,
    JSON.stringify(args.design ?? {}),
    samplePath,
    coverPath,
    args.createdAt
  );

  const row = getVoiceProfile(args.id);
  if (!row) throw new Error("insert failed");
  return row;
}

export function deleteVoiceProfile(id: string): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT sample_path, cover_path FROM voice_profiles WHERE id = ?`)
    .get(id) as { sample_path: string | null; cover_path: string | null } | undefined;
  if (!row) return false;

  db.prepare(`DELETE FROM voice_profiles WHERE id = ?`).run(id);

  // Best-effort cleanup of files on disk. Don't throw if they're gone.
  try {
    for (const p of [row.sample_path, row.cover_path]) {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    }
    const dir = voiceSampleDir(id);
    if (fs.existsSync(dir)) {
      try {
        fs.rmdirSync(dir);
      } catch {
        /* not empty */
      }
    }
  } catch {
    /* swallow — DB row is gone, that's the source of truth */
  }
  return true;
}

// ---- Voice Lab tokens (bearer auth for Voice Studio → Reader) ----

export type VoiceLabToken = {
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createVoiceLabToken(label?: string): {
  token: string;
  record: VoiceLabToken;
} {
  // Generate 32 bytes of entropy — plenty for a bearer token.
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = hashToken(token);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO voice_lab_tokens (token_hash, label, created_at)
       VALUES (?, ?, ?)`
    )
    .run(hash, label ?? null, now);
  return {
    token,
    record: { label: label ?? null, createdAt: now, lastUsedAt: null },
  };
}

export function validateVoiceLabToken(token: string): boolean {
  if (!token) return false;
  const hash = hashToken(token);
  const row = getDb()
    .prepare(`SELECT token_hash FROM voice_lab_tokens WHERE token_hash = ?`)
    .get(hash) as { token_hash: string } | undefined;
  if (!row) return false;
  // Best-effort bump of last_used_at; failure here shouldn't reject auth.
  try {
    getDb()
      .prepare(`UPDATE voice_lab_tokens SET last_used_at = ? WHERE token_hash = ?`)
      .run(new Date().toISOString(), hash);
  } catch {
    /* ignore */
  }
  return true;
}

export function listVoiceLabTokens(): VoiceLabToken[] {
  const rows = getDb()
    .prepare(
      `SELECT label, created_at, last_used_at FROM voice_lab_tokens ORDER BY created_at DESC`
    )
    .all() as Array<{ label: string | null; created_at: string; last_used_at: string | null }>;
  return rows.map((r) => ({
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

export function revokeAllVoiceLabTokens(): number {
  const info = getDb().prepare(`DELETE FROM voice_lab_tokens`).run();
  return info.changes;
}

// ---- Bearer-token auth helper for API routes ----

export function authorizeVoiceLabRequest(req: Request): boolean {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/.exec(header.trim());
  if (!m) return false;
  return validateVoiceLabToken(m[1].trim());
}
