// Auto-OCR pipeline for image-only PDFs.
//
// The user can upload a scanned PDF (a pile of page-sized images with no
// real text layer) and the server will quietly run OCR on it so the
// Reader ends up with actual words the TTS can speak. No manual re-upload,
// no "Enable OCR" checkbox — the client asks us to OCR whenever it
// notices `word_count === 0` on a pdf source type.
//
// Strategy:
//
//   1. Shell out to `ocrmypdf` — battle-tested, produces a PDF with a
//      real hocr text layer. Re-running `parsePdf` on the output gives
//      identical-shape data to the normal ingest path (content +
//      pageRanges), so the client, Pages viewer, and tokenizer all
//      keep working without any knowledge of OCR.
//   2. Overwrite the stored original PDF in-place. The Pages viewer
//      fetches `/api/documents/:id/file` and does its own
//      `getTextContent()`, so it'll pick up the new text layer the next
//      time the page re-renders.
//   3. Track job state in-memory per-doc. Survives route-handler calls
//      in the same Node process; lost on pm2 restart (fine — the
//      client will just re-POST and kick off another run).
//
// Why not in-process tesseract.js / node-canvas:
//
//   The scar we just closed was shipping a Mach-O `.node` binary to
//   the Linux server. Any additional native bindings are another
//   landmine. `ocrmypdf` is a Python/C tool invoked via subprocess,
//   installed via `apt install ocrmypdf tesseract-ocr` — no
//   Node-native surface area.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { parsePdf, countWords } from "./parse";
import {
  getDocument,
  getStoredPath,
  updateDocumentOcrResult,
} from "./documents";

export type OcrStatus =
  | { status: "idle" }
  | { status: "running"; startedAt: number }
  | { status: "done"; completedAt: number; wordCount: number }
  | { status: "failed"; completedAt: number; error: string }
  | { status: "unavailable"; reason: string };

// Per-document status. Module-level Map survives across route handler
// invocations in the same pm2 process. One process only (Next runs
// single-instance under `output: "standalone"` pm2).
const jobs = new Map<string, OcrStatus>();

// Cache the "does `ocrmypdf` exist on PATH" check — invoked on every
// trigger attempt, spawning a process each time is wasteful.
let _ocrAvailable: boolean | null = null;
async function isOcrAvailable(): Promise<boolean> {
  if (_ocrAvailable !== null) return _ocrAvailable;
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn("ocrmypdf", ["--version"]);
      p.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`exit ${code}`))
      );
      p.on("error", reject);
    });
    _ocrAvailable = true;
  } catch {
    _ocrAvailable = false;
  }
  return _ocrAvailable;
}

/** Current OCR status for a document. Cheap — reads from in-memory Map. */
export function getOcrStatus(docId: string): OcrStatus {
  // If we have no record but the doc has text, it was either OCR'd
  // earlier and the process restarted, or it never needed OCR. Either
  // way, "done" is the correct answer.
  const cached = jobs.get(docId);
  if (cached) return cached;
  const doc = getDocument(docId);
  if (doc && doc.wordCount > 0) {
    return { status: "done", completedAt: Date.now(), wordCount: doc.wordCount };
  }
  return { status: "idle" };
}

/**
 * Idempotently trigger OCR for a document. Safe to call repeatedly —
 * if a job is already running it returns the current status without
 * starting a duplicate. Returns immediately; the actual work is done
 * in the background.
 */
export async function triggerOcr(docId: string): Promise<OcrStatus> {
  const current = jobs.get(docId);
  if (current?.status === "running") return current;

  const doc = getDocument(docId);
  if (!doc) {
    const s: OcrStatus = {
      status: "failed",
      completedAt: Date.now(),
      error: "document not found",
    };
    jobs.set(docId, s);
    return s;
  }
  if (doc.sourceType !== "pdf") {
    const s: OcrStatus = {
      status: "unavailable",
      reason: "only pdf documents can be OCR'd",
    };
    jobs.set(docId, s);
    return s;
  }
  if (doc.wordCount > 0) {
    const s: OcrStatus = {
      status: "done",
      completedAt: Date.now(),
      wordCount: doc.wordCount,
    };
    jobs.set(docId, s);
    return s;
  }
  const storedPath = getStoredPath(docId);
  if (!storedPath) {
    const s: OcrStatus = {
      status: "unavailable",
      reason: "original PDF not stored",
    };
    jobs.set(docId, s);
    return s;
  }
  if (!(await isOcrAvailable())) {
    const s: OcrStatus = {
      status: "unavailable",
      reason: "ocrmypdf not installed on server",
    };
    jobs.set(docId, s);
    return s;
  }

  const running: OcrStatus = { status: "running", startedAt: Date.now() };
  jobs.set(docId, running);

  // Fire-and-forget. The catch is belt-and-braces — runOcrJob already
  // updates the jobs Map on error, but a throw escaping it would leave
  // the job stuck in "running" forever.
  runOcrJob(docId, storedPath).catch((err) => {
    console.error(`[ocr] ${docId}: unhandled job error:`, err);
    jobs.set(docId, {
      status: "failed",
      completedAt: Date.now(),
      error: String((err as Error)?.message ?? err),
    });
  });

  return running;
}

async function runOcrJob(docId: string, storedPath: string): Promise<void> {
  console.log(`[ocr] ${docId}: starting — ${storedPath}`);
  const t0 = Date.now();
  const outPath = `${storedPath}.ocr.tmp`;
  try {
    // `--force-ocr` re-OCR's even if a fake/garbage text layer exists,
    // which is the common case for scanned PDFs (our test doc has a
    // bogus text layer of 0x01 bytes).
    // `--optimize 0` skips the jbig2/pdfa optimization pass — saves ~30%
    // wall time and produces a slightly larger PDF we don't care about.
    // `--quiet` keeps stderr empty on the happy path so our error
    // parsing only sees real failures.
    await new Promise<void>((resolve, reject) => {
      const p = spawn("ocrmypdf", [
        "--force-ocr",
        "--optimize",
        "0",
        "--quiet",
        storedPath,
        outPath,
      ]);
      let stderr = "";
      p.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      p.on("exit", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `ocrmypdf exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ""}`
            )
          );
      });
      p.on("error", reject);
    });

    // Atomically replace original with OCR'd version. The Pages viewer
    // fetches /api/documents/:id/file and will pick up the new text
    // layer on its next render pass.
    await fs.rename(outPath, storedPath);

    // Re-parse the (now text-bearing) PDF so we get a real content
    // string + per-page char ranges identical in shape to a normal
    // upload.
    const buf = await fs.readFile(storedPath);
    const { content, pageRanges } = await parsePdf(buf);
    const wordCount = countWords(content);

    updateDocumentOcrResult(docId, { content, wordCount, pageRanges });
    jobs.set(docId, {
      status: "done",
      completedAt: Date.now(),
      wordCount,
    });
    const elapsedMs = Date.now() - t0;
    console.log(
      `[ocr] ${docId}: done in ${elapsedMs}ms — ${wordCount} words, ${content.length} chars, ${pageRanges.length} pages`
    );
  } catch (err) {
    console.error(`[ocr] ${docId}: failed`, err);
    await fs.unlink(outPath).catch(() => {
      /* file may not exist — fine */
    });
    jobs.set(docId, {
      status: "failed",
      completedAt: Date.now(),
      error: String((err as Error)?.message ?? err),
    });
    throw err;
  }
}
