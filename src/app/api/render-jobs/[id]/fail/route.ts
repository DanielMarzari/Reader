import { NextRequest, NextResponse } from "next/server";
import { authorizeVoiceLabRequest } from "@/lib/voices";
import { failRenderJob, getRenderJob } from "@/lib/renderJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/render-jobs/:id/fail — Voice Studio reports a failure.
// Body: { error: string }. Short error message stored on the row so the
// UI can show "Render failed: <reason>" and the user can retry.
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

  let body: { error?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const errText = (body.error || "Unknown error").slice(0, 500);
  const updated = failRenderJob(id, errText);
  return NextResponse.json({ job: updated });
}
