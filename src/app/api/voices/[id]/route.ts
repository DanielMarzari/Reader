import { NextRequest, NextResponse } from "next/server";
import {
  authorizeVoiceLabRequest,
  deleteVoiceProfile,
  getVoiceProfile,
} from "@/lib/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const voice = getVoiceProfile(id);
  if (!voice) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ voice });
}

// DELETE is allowed from two origins:
//   1. Browser request (Voice Lab UI) — same-origin, trusted.
//   2. Voice Studio via bearer token.
// For simplicity in this single-user app we accept either. If a future
// deployment has multiple users we can tighten this.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const hasAuthHeader =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (hasAuthHeader && !authorizeVoiceLabRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const ok = deleteVoiceProfile(id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: id });
}
