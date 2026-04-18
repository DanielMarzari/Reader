import { NextRequest, NextResponse } from "next/server";
import { upsertPosition } from "@/lib/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // navigator.sendBeacon posts a Blob; req.json() still works because the
  // Blob carries content-type application/json, but guard for safety.
  let body: { charIndex?: unknown; rate?: unknown; voiceName?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    const txt = await req.text().catch(() => "");
    if (txt) {
      try {
        body = JSON.parse(txt);
      } catch {}
    }
  }
  const charIndex = Math.max(0, Math.floor(Number(body.charIndex) || 0));
  const rate = Math.max(0.25, Math.min(4, Number(body.rate) || 1));
  const voiceName = typeof body.voiceName === "string" ? body.voiceName : null;
  upsertPosition(id, charIndex, rate, voiceName);
  return NextResponse.json({ ok: true });
}

// Web Speech player sends PUT during playback (interval + pause).
// navigator.sendBeacon() on unmount always uses POST — accept both.
export { handle as PUT, handle as POST };
