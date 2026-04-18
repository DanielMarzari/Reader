// Storage for original uploaded files (PDF, EPUB).
// Writes alongside the SQLite DB under {db-dir}/files/{id}.{ext}.
// Excluded from the deploy rsync --delete (see .github/workflows/deploy.yml).

import fs from "node:fs/promises";
import path from "node:path";

function filesDir(): string {
  const envDir = process.env.FILES_DIR;
  if (envDir) return envDir;
  const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), "reader.db");
  return path.join(path.dirname(dbPath), "files");
}

export function extensionFor(sourceType: "pdf" | "epub" | "text"): string {
  return sourceType === "pdf" ? "pdf" : sourceType === "epub" ? "epub" : "txt";
}

export function contentTypeFor(sourceType: "pdf" | "epub" | "text"): string {
  return sourceType === "pdf"
    ? "application/pdf"
    : sourceType === "epub"
    ? "application/epub+zip"
    : "text/plain";
}

export async function saveOriginal(
  id: string,
  sourceType: "pdf" | "epub" | "text",
  buffer: Buffer
): Promise<string> {
  const dir = filesDir();
  await fs.mkdir(dir, { recursive: true });
  const full = path.join(dir, `${id}.${extensionFor(sourceType)}`);
  await fs.writeFile(full, buffer);
  return full;
}

export async function readOriginal(storedPath: string): Promise<Buffer> {
  return fs.readFile(storedPath);
}

export async function deleteOriginal(storedPath: string | null): Promise<void> {
  if (!storedPath) return;
  try {
    await fs.unlink(storedPath);
  } catch {
    // ignore: file may already be gone
  }
}
