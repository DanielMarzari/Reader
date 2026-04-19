import { NextRequest, NextResponse } from "next/server";
import { getVoiceProfile, authorizeVoiceLabRequest } from "@/lib/voices";
import { getDocument } from "@/lib/documents";
import {
  listRenderJobs,
  upsertRenderJob,
  type RenderJob,
} from "@/lib/renderJobs";
import type { RenderJobStatus } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/render-jobs — two caller flavors:
//   1. Voice Studio polling (bearer-auth). ?status=pending&limit=1 is the
//      common case. Returns rows ordered by priority desc, requested_at asc.
//   2. Same-origin Reader UI (no bearer). Lets the Voice Lab UI show the
//      queue state without exposing a bearer token to the browser.
// In practice we just check the status filter — both flows use the same
// SQL — and apply bearer-auth only when asked for pending-worker work.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const limitParam = url.searchParams.get("limit");
  const docId = url.searchParams.get("document_id") ?? undefined;
  const voiceId = url.searchParams.get("voice_id") ?? undefined;

  // Worker flavor: status=pending → require bearer auth.
  const hasBearer = Boolean(
    req.headers.get("authorization") || req.headers.get("Authorization")
  );
  if (hasBearer && !authorizeVoiceLabRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (statusParam === "pending" && !hasBearer) {
    // Protect the worker queue from anonymous browsers — poll traffic should
    // only come from Voice Studio. The same-origin UI reads job status via
    // GET /api/render-jobs/:id (unauthed), not by scanning the pending list.
    return NextResponse.json(
      { error: "Pending-queue polling requires bearer auth" },
      { status: 401 }
    );
  }

  const status = statusParam
    ? (statusParam.split(",").filter(Boolean) as RenderJobStatus[])
    : undefined;
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;

  const jobs = listRenderJobs({
    status: status && status.length ? status : undefined,
    documentId: docId,
    voiceId,
    limit: limit && Number.isFinite(limit) ? limit : undefined,
  });
  return NextResponse.json({ jobs });
}

// POST /api/render-jobs — create or bump a job.
// Same-origin only: the request comes from a logged-in browser session
// (AUTH_PASSWORD-gated by the reader app at a higher layer). Body:
//   { document_id, voice_id, priority?: "high" | "low" }
export async function POST(req: NextRequest) {
  let body: { document_id?: string; voice_id?: string; priority?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.document_id || !body.voice_id) {
    return NextResponse.json(
      { error: "document_id and voice_id required" },
      { status: 400 }
    );
  }
  if (!getDocument(body.document_id)) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  if (!getVoiceProfile(body.voice_id)) {
    return NextResponse.json({ error: "Voice not found" }, { status: 404 });
  }
  const priority = body.priority === "low" ? "low" : "high";
  const job: RenderJob = upsertRenderJob({
    documentId: body.document_id,
    voiceId: body.voice_id,
    priority,
  });
  return NextResponse.json({ job });
}
