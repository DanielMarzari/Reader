import { NextRequest, NextResponse } from "next/server";
import path from "path";
import {
  authorizeVoiceLabRequest,
  listVoiceProfiles,
  upsertVoiceProfile,
} from "@/lib/voices";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/voices — list voice profiles for the Voice Lab gallery.
// Public (no auth): the sample MP3s and names are already "shareable"
// within this single-user app.
export async function GET() {
  const voices = listVoiceProfiles();
  return NextResponse.json({ voices });
}

// POST /api/voices — Voice Studio push (bearer-authed multipart).
// Multipart fields: `metadata` (JSON blob), `sample` (audio/mpeg), optional
// `cover` (image). Same-origin uploads from the Reader UI were removed;
// the Voice Studio app's Import tab is now the one authoritative path.
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 }
    );
  }
  if (!authorizeVoiceLabRequest(req)) {
    return NextResponse.json(
      { error: "Unauthorized — generate a token from the Voice Lab UI" },
      { status: 401 }
    );
  }
  const form = await req.formData();
  return handleStudioPush(form);
}

async function handleStudioPush(form: FormData): Promise<Response> {
  const metaRaw = form.get("metadata");
  const sample = form.get("sample");
  const cover = form.get("cover");
  const promptMel = form.get("prompt_mel");
  const promptMelMeta = form.get("prompt_mel_meta");

  if (typeof metaRaw !== "string") {
    return NextResponse.json({ error: "Missing 'metadata' field" }, { status: 400 });
  }
  if (!(sample instanceof File)) {
    return NextResponse.json({ error: "Missing 'sample' file" }, { status: 400 });
  }

  let meta: {
    id?: string;
    name?: string;
    kind?: string;
    engine?: string;
    createdAt?: string;
    design?: Record<string, unknown>;
  };
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    return NextResponse.json({ error: "metadata is not valid JSON" }, { status: 400 });
  }

  if (!meta.id || !meta.name) {
    return NextResponse.json(
      { error: "metadata requires id and name" },
      { status: 400 }
    );
  }
  if (
    meta.kind !== "cloned" &&
    meta.kind !== "designed" &&
    meta.kind !== "uploaded"
  ) {
    return NextResponse.json(
      { error: "metadata.kind must be 'cloned' | 'designed' | 'uploaded'" },
      { status: 400 }
    );
  }

  const buf = Buffer.from(await sample.arrayBuffer());
  if (!buf.length) {
    return NextResponse.json({ error: "Empty sample file" }, { status: 400 });
  }
  // Imported voices may be longer than synthesized previews, so the
  // ceiling is generous; 10 MB is ~6 min of 192 kbps MP3.
  if (buf.length > 10 * 1024 * 1024) {
    return NextResponse.json(
      { error: "Sample too large (max 10 MB)" },
      { status: 413 }
    );
  }

  // Optional cover image — Voice Studio's Import tab ships one when the
  // user chooses "profile picture" instead of the mood sphere.
  let coverBuf: Buffer | null = null;
  let coverExt: string | null = null;
  if (cover instanceof File && cover.size > 0) {
    const ext = path.extname(cover.name || "").toLowerCase();
    if (!IMAGE_EXTS.has(ext)) {
      return NextResponse.json(
        { error: `cover must be one of ${[...IMAGE_EXTS].join(", ")}` },
        { status: 400 }
      );
    }
    if (cover.size > 5 * 1024 * 1024) {
      return NextResponse.json(
        { error: "cover image too large (max 5 MB)" },
        { status: 413 }
      );
    }
    coverBuf = Buffer.from(await cover.arrayBuffer());
    coverExt = ext;
  }

  // Optional prompt_mel payload. Phase 3: Voice Studio's /api/clone
  // computes the log-mel spectrogram of the reference audio via
  // mel_features.compute_prompt_mel and ships it here so Reader can
  // serve it to the browser client for ZipVoice's `speech_condition`.
  // Old Voice Studio versions won't send these — voice still works for
  // audiobook / Web-Speech playback but not browser-native inference.
  let promptMelBuf: Buffer | null = null;
  let promptMelMetaBuf: Buffer | null = null;
  if (promptMel instanceof File && promptMel.size > 0) {
    // 100 mels × 4 bytes × ~40 frames/second × 60 seconds = 960 KB per
    // minute. Ceiling of 10 MB covers very long prompt clips (> 2.5 min).
    if (promptMel.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "prompt_mel too large (max 10 MB)" },
        { status: 413 }
      );
    }
    promptMelBuf = Buffer.from(await promptMel.arrayBuffer());
  }
  if (promptMelMeta instanceof File && promptMelMeta.size > 0) {
    if (promptMelMeta.size > 16 * 1024) {
      return NextResponse.json(
        { error: "prompt_mel_meta too large (max 16 KB — it's a tiny JSON)" },
        { status: 413 }
      );
    }
    promptMelMetaBuf = Buffer.from(await promptMelMeta.arrayBuffer());
    // Sanity-check it parses as JSON. Bad JSON now means unusable
    // prompt_mel later; fail fast.
    try {
      JSON.parse(promptMelMetaBuf.toString("utf8"));
    } catch {
      return NextResponse.json(
        { error: "prompt_mel_meta is not valid JSON" },
        { status: 400 }
      );
    }
  }

  try {
    const saved = upsertVoiceProfile({
      id: meta.id,
      name: meta.name.slice(0, 80),
      kind: meta.kind,
      engine: meta.engine ?? "unknown",
      createdAt: meta.createdAt ?? new Date().toISOString(),
      design: meta.design ?? {},
      sampleBuffer: buf,
      coverBuffer: coverBuf,
      coverExt,
      promptMelBuffer: promptMelBuf,
      promptMelMetaBuffer: promptMelMetaBuf,
    });
    return NextResponse.json({ voice: saved });
  } catch (err) {
    console.error("upsertVoiceProfile failed:", err);
    return NextResponse.json(
      { error: `Failed to save: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}

