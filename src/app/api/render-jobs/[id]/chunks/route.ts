import { NextRequest, NextResponse } from "next/server";
import { authorizeVoiceLabRequest } from "@/lib/voices";
import {
  getRenderJob,
  incrementRenderProgress,
  writeAudiobookChunk,
} from "@/lib/renderJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/render-jobs/:id/chunks — Voice Studio uploads one rendered
// audio chunk. multipart/form-data:
//   index:        int (1-based)
//   total:        int (optional; first upload carries it so the UI can
//                 show "N/M" right away)
//   mp3:          audio/mpeg file (the rendered chunk)
//
// Writes to STORAGE_DIR/audiobooks/<doc>/<voice>/chunk_NNNN.mp3 and
// bumps chunks_done on the job row.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!authorizeVoiceLabRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const job = getRenderJob(id);
  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (job.status !== "rendering") {
    return NextResponse.json(
      { error: `Job is ${job.status}; only 'rendering' accepts chunks` },
      { status: 409 }
    );
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 }
    );
  }
  const form = await req.formData();
  const indexRaw = form.get("index");
  const totalRaw = form.get("total");
  const mp3 = form.get("mp3");

  const index = typeof indexRaw === "string" ? parseInt(indexRaw, 10) : NaN;
  if (!Number.isFinite(index) || index < 1) {
    return NextResponse.json({ error: "index must be ≥ 1" }, { status: 400 });
  }
  if (!(mp3 instanceof File)) {
    return NextResponse.json({ error: "mp3 file required" }, { status: 400 });
  }
  const buf = Buffer.from(await mp3.arrayBuffer());
  if (!buf.length) {
    return NextResponse.json({ error: "Empty mp3" }, { status: 400 });
  }
  // Hard cap — 10 MB per chunk is generous (180-250 char chunk is typically
  // 10-20s of audio = ~250-500 KB at 128kbps).
  if (buf.length > 10 * 1024 * 1024) {
    return NextResponse.json(
      { error: "Chunk too large (max 10 MB)" },
      { status: 413 }
    );
  }

  writeAudiobookChunk(job.documentId, job.voiceId, index, buf);

  let total: number | null = null;
  if (typeof totalRaw === "string") {
    const t = parseInt(totalRaw, 10);
    if (Number.isFinite(t) && t > 0) total = t;
  }

  const updated = incrementRenderProgress(id, total);
  return NextResponse.json({ job: updated });
}
