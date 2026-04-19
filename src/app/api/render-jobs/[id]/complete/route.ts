import { NextRequest, NextResponse } from "next/server";
import { authorizeVoiceLabRequest } from "@/lib/voices";
import {
  completeRenderJob,
  getRenderJob,
  writeAudiobookManifest,
  type AudiobookManifest,
} from "@/lib/renderJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/render-jobs/:id/complete — Voice Studio reports successful
// finish. Body is the full manifest JSON; we persist it to disk + mark
// the job 'ready'.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!authorizeVoiceLabRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const job = getRenderJob(id);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let manifest: AudiobookManifest;
  try {
    manifest = (await req.json()) as AudiobookManifest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (
    !manifest ||
    manifest.documentId !== job.documentId ||
    manifest.voiceId !== job.voiceId ||
    !Array.isArray(manifest.chunks)
  ) {
    return NextResponse.json(
      { error: "Manifest doesn't match job (documentId/voiceId/chunks)" },
      { status: 400 }
    );
  }

  writeAudiobookManifest(job.documentId, job.voiceId, manifest);
  const updated = completeRenderJob(id);
  return NextResponse.json({ job: updated });
}
