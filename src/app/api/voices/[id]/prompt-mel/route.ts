import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { getVoiceProfile, voicePromptMelPath } from "@/lib/voices";

// GET /api/voices/[id]/prompt-mel
//
// Streams the voice's prompt_mel.f32 — the log-mel spectrogram of its
// reference audio, Float32 little-endian, shape (num_frames, 100).
//
// Reader's browser inference (src/lib/tts/prompt-mel.ts) fetches this
// alongside prompt_mel_meta and feeds the buffer into fm_decoder's
// `speech_condition` input at synthesis time. Without this file the
// voice isn't usable for browser-native TTS (falls back to the
// audiobook render queue or Web Speech).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const voice = getVoiceProfile(id);
  if (!voice) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const filePath = voicePromptMelPath(id);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json(
      {
        error:
          "prompt_mel not available for this voice. Upload via Voice Studio's " +
          "/api/clone flow (any new voice gets one automatically) or run " +
          "backend/scripts/compute_prompt_mel.py --profile <id> + re-sync.",
      },
      { status: 404 }
    );
  }

  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  // @ts-expect-error Node Readable is accepted by the Response constructor
  // in Next's runtime, even though TS doesn't know that.
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stat.size),
      // One-year cache: the prompt_mel is deterministic from the
      // reference audio, which itself is immutable per voice id.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
