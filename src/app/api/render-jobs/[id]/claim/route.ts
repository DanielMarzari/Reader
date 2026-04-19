import { NextRequest, NextResponse } from "next/server";
import { authorizeVoiceLabRequest } from "@/lib/voices";
import { getDocument } from "@/lib/documents";
import { claimRenderJob, getRenderJob } from "@/lib/renderJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/render-jobs/:id/claim — Voice Studio worker atomically takes
// ownership of a pending job. Returns the full document text + job so the
// worker has everything it needs to render offline.
//
// Response:
//   200 — { job, document: { id, title, content } }
//   401 — missing / bad bearer
//   404 — job doesn't exist
//   409 — already claimed (not pending anymore)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!authorizeVoiceLabRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const existing = getRenderJob(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const claimed = claimRenderJob(id);
  if (!claimed) {
    return NextResponse.json(
      { error: `Already ${existing.status}`, job: existing },
      { status: 409 }
    );
  }

  const doc = getDocument(claimed.documentId);
  if (!doc) {
    // Doc vanished between queue and claim — shouldn't happen (FK cascades)
    // but guard anyway.
    return NextResponse.json(
      { error: "Document missing after claim" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    job: claimed,
    document: {
      id: doc.id,
      title: doc.title,
      content: doc.content,
    },
  });
}
