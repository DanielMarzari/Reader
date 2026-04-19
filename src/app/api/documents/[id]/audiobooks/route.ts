import { NextRequest, NextResponse } from "next/server";
import {
  getRenderJobForPair,
  listDocumentAudiobooks,
  listRenderJobs,
} from "@/lib/renderJobs";
import { getVoiceProfile } from "@/lib/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/documents/:id/audiobooks — one entry per voice that HAS a
// render for this doc. Each entry includes the voice name + current job
// status (ready / rendering / pending / failed) so the UI can render a
// single dropdown: "Listen — Alex (ready)", "Beth (rendering, 6/12)".
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Ready audiobooks (have manifest.json on disk).
  const ready = listDocumentAudiobooks(id).map(({ voiceId, manifest }) => ({
    voiceId,
    voiceName: manifest.voiceName,
    engine: manifest.engine,
    status: "ready" as const,
    totalDurationMs: manifest.totalDurationMs,
    chunks: manifest.chunks.length,
  }));

  // In-flight / failed / pending jobs for this doc (even without a manifest).
  const jobs = listRenderJobs({ documentId: id });
  const inflight = jobs
    .filter((j) => j.status !== "ready" && j.status !== "cancelled")
    .map((j) => {
      const voice = getVoiceProfile(j.voiceId);
      return {
        voiceId: j.voiceId,
        voiceName: voice?.name ?? "(deleted voice)",
        engine: voice?.engine ?? "unknown",
        status: j.status,
        jobId: j.id,
        chunksDone: j.chunksDone,
        chunksTotal: j.chunksTotal,
        priority: j.priority,
        error: j.error,
      };
    });

  return NextResponse.json({ ready, inflight });
}

// POST /api/documents/:id/audiobooks — convenience: queue a render for
// this doc with a specific voice. Body: { voice_id, priority? }.
// Thin wrapper around POST /api/render-jobs that saves the client one
// lookup, and lets us UPSERT by (doc,voice) cleanly.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: { voice_id?: string; priority?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.voice_id) {
    return NextResponse.json({ error: "voice_id required" }, { status: 400 });
  }
  const existing = getRenderJobForPair(id, body.voice_id);
  if (existing && (existing.status === "ready" || existing.status === "rendering")) {
    return NextResponse.json({ job: existing, reused: true });
  }
  // Delegate to the main endpoint's logic via the lib directly — saves a
  // round-trip. The same validation (doc + voice exist) happens there,
  // so replicate the checks here.
  const { getDocument } = await import("@/lib/documents");
  const { upsertRenderJob } = await import("@/lib/renderJobs");
  if (!getDocument(id)) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  if (!getVoiceProfile(body.voice_id)) {
    return NextResponse.json({ error: "Voice not found" }, { status: 404 });
  }
  const priority = body.priority === "low" ? "low" : "high";
  const job = upsertRenderJob({
    documentId: id,
    voiceId: body.voice_id,
    priority,
  });
  return NextResponse.json({ job });
}
