import { NextRequest, NextResponse } from "next/server";
import { cancelRenderJob, getRenderJob } from "@/lib/renderJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/render-jobs/:id — unauthed; the Reader UI polls this to
// refresh the "Rendering… N/M" progress indicator. Response is just the
// job row, no sensitive content.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = getRenderJob(id);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ job });
}

// DELETE /api/render-jobs/:id — user cancel. Same-origin.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = cancelRenderJob(id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ cancelled: id });
}
