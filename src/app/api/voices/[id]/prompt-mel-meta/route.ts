import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { getVoiceProfile, voicePromptMelMetaPath } from "@/lib/voices";

// GET /api/voices/[id]/prompt-mel-meta
//
// Tiny JSON sidecar for prompt_mel.f32 — sizes, shape, feat_scale, and
// the SHA-256 of the .f32 bytes. Browser client reads this BEFORE
// fetching the binary to know the expected byte count and num_frames.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const voice = getVoiceProfile(id);
  if (!voice) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const filePath = voicePromptMelMetaPath(id);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json(
      { error: "prompt_mel_meta not available for this voice" },
      { status: 404 }
    );
  }

  const json = fs.readFileSync(filePath, "utf8");
  return new Response(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
