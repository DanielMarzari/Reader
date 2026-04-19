import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { audiobookChunkPath } from "@/lib/renderJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/audiobooks/:doc_id/:voice_id/chunks/:n — streams one chunk
// MP3. The player MediaSource-appends these sequentially for gapless
// playback; or in the simpler fallback path, it just swaps <audio src>.
//
// We allow long cache lifetime — chunk content is immutable once written.
export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ doc_id: string; voice_id: string; n: string }>;
  }
) {
  const { doc_id, voice_id, n } = await params;
  const index = parseInt(n, 10);
  if (!Number.isFinite(index) || index < 1) {
    return NextResponse.json({ error: "Invalid chunk index" }, { status: 400 });
  }
  const filePath = audiobookChunkPath(doc_id, voice_id, index);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Chunk not found" }, { status: 404 });
  }
  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  // @ts-expect-error — Node Readable works in the Next runtime.
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=86400, immutable",
      "Accept-Ranges": "bytes",
    },
  });
}
