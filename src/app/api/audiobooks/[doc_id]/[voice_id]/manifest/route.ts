import { NextRequest, NextResponse } from "next/server";
import { readAudiobookManifest } from "@/lib/renderJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/audiobooks/:doc_id/:voice_id/manifest — player reads this to
// learn chunk boundaries, durations, and word timings. Same-origin (no
// bearer); this is public within the single-user AUTH_PASSWORD layer.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ doc_id: string; voice_id: string }> }
) {
  const { doc_id, voice_id } = await params;
  const m = readAudiobookManifest(doc_id, voice_id);
  if (!m) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(m, {
    headers: { "Cache-Control": "private, max-age=60" },
  });
}
