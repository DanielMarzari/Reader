import { NextRequest, NextResponse } from "next/server";
import { upsertPosition } from "@/lib/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const charIndex = Math.max(0, Math.floor(Number(body.charIndex) || 0));
  const rate = Math.max(0.25, Math.min(4, Number(body.rate) || 1));
  const voiceName = typeof body.voiceName === "string" ? body.voiceName : null;
  upsertPosition(id, charIndex, rate, voiceName);
  return NextResponse.json({ ok: true });
}
