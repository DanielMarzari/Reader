// Server-side TTS proxy for ElevenLabs.
// Uses Speechify-style context: previous_text + next_text for seamless audio
// across chunked synthesis.
//
// Enabled only when ELEVENLABS_API_KEY is set in the server env.
//
// POST { text, previousText?, nextText?, voiceId?, modelId?, withTimestamps? }
//   withTimestamps === true  → JSON response:
//       { audio_base64, alignment, normalized_alignment }
//   otherwise                → audio/mpeg stream (default, unchanged).
//
// GET (health): { enabled: boolean } so the client can decide whether to
// show the ElevenLabs toggle without making a synthesis request.

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    enabled: Boolean(process.env.ELEVENLABS_API_KEY),
  });
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ElevenLabs not configured (ELEVENLABS_API_KEY missing)" },
      { status: 501 }
    );
  }

  let body: {
    text?: string;
    previousText?: string;
    nextText?: string;
    voiceId?: string;
    modelId?: string;
    withTimestamps?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const text = (body.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });

  const voiceId = body.voiceId || process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // Adam default
  const modelId = body.modelId || "eleven_turbo_v2_5";
  const withTimestamps = body.withTimestamps === true;

  const payload = {
    text,
    model_id: modelId,
    previous_text: body.previousText || undefined,
    next_text: body.nextText || undefined,
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  };

  if (withTimestamps) {
    // Non-streaming JSON response with per-character alignment.
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!upstream.ok) {
      const msg = await upstream.text().catch(() => "upstream error");
      return NextResponse.json(
        { error: `ElevenLabs error ${upstream.status}: ${msg.slice(0, 300)}` },
        { status: 502 }
      );
    }

    const data = (await upstream.json()) as unknown;
    return NextResponse.json(data, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // Streaming MP3 — default path.
  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!upstream.ok || !upstream.body) {
    const msg = await upstream.text().catch(() => "upstream error");
    return NextResponse.json(
      { error: `ElevenLabs error ${upstream.status}: ${msg.slice(0, 300)}` },
      { status: 502 }
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
