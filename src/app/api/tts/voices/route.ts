// Returns available ElevenLabs voices, if configured.
// Used by the Reader page to populate the voice dropdown.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return NextResponse.json({ enabled: false, voices: [] });

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) return NextResponse.json({ enabled: false, voices: [] });
    const data = await res.json();
    type ElVoice = { voice_id?: string; name?: string; labels?: Record<string, string> };
    const voices = (data.voices as ElVoice[] | undefined)?.map((v) => ({
      id: v.voice_id ?? "",
      name: v.name ?? "Unknown",
      labels: v.labels ?? {},
    })) ?? [];
    return NextResponse.json({ enabled: true, voices });
  } catch {
    return NextResponse.json({ enabled: false, voices: [] });
  }
}
