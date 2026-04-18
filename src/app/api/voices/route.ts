import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import path from "path";
import {
  authorizeVoiceLabRequest,
  listVoiceProfiles,
  upsertVoiceProfile,
} from "@/lib/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/voices — list voice profiles for the Voice Lab gallery.
// Public (no auth): the sample MP3s and names are already "shareable"
// within this single-user app.
export async function GET() {
  const voices = listVoiceProfiles();
  return NextResponse.json({ voices });
}

// POST /api/voices — accepts two flavors of upload:
//   1. Voice Studio push — bearer token in Authorization header.
//      Multipart fields: `metadata` (JSON blob), `sample` (MP3).
//   2. Same-origin user upload from the Voice Lab UI ("Upload Voice" modal).
//      Multipart fields: `name`, `audio` (MP3/WAV/OGG), optional `cover`
//      (image). Auth: the request is already from the user's own browser
//      session on reader.danmarzari.com — we rely on same-origin for now
//      (AUTH_PASSWORD guards the whole app per ecosystem.config.js).
//
// The two shapes are distinguished by the presence of a bearer header.
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 }
    );
  }

  const form = await req.formData();
  const hasBearer = Boolean(
    req.headers.get("authorization") || req.headers.get("Authorization")
  );

  // ---- Flavor 1: Voice Studio push ----
  if (hasBearer) {
    if (!authorizeVoiceLabRequest(req)) {
      return NextResponse.json(
        { error: "Unauthorized — generate a token from the Voice Lab UI" },
        { status: 401 }
      );
    }
    return handleStudioPush(form);
  }

  // ---- Flavor 2: user upload from the Voice Lab UI ----
  return handleUserUpload(form);
}

async function handleStudioPush(form: FormData): Promise<Response> {
  const metaRaw = form.get("metadata");
  const sample = form.get("sample");

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
  if (meta.kind !== "cloned" && meta.kind !== "designed") {
    return NextResponse.json(
      { error: "metadata.kind must be 'cloned' or 'designed'" },
      { status: 400 }
    );
  }

  const buf = Buffer.from(await sample.arrayBuffer());
  if (!buf.length) {
    return NextResponse.json({ error: "Empty sample file" }, { status: 400 });
  }
  if (buf.length > 2 * 1024 * 1024) {
    return NextResponse.json(
      { error: "Sample too large (max 2 MB)" },
      { status: 413 }
    );
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

// User upload flow — lets the user drop in their own audio file and an
// optional cover image. The audio is stored as-is as the "sample" (click
// the sphere / cover to hear it). `kind` is stored as "uploaded".
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

async function handleUserUpload(form: FormData): Promise<Response> {
  const name = (form.get("name") as string | null)?.trim();
  const audio = form.get("audio");
  const cover = form.get("cover");

  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  if (!(audio instanceof File)) {
    return NextResponse.json({ error: "audio file required" }, { status: 400 });
  }

  const audioBuf = Buffer.from(await audio.arrayBuffer());
  if (!audioBuf.length) {
    return NextResponse.json({ error: "empty audio file" }, { status: 400 });
  }
  // Cap at 5 MB for user uploads — enough for ~3 min of 192 kbps MP3.
  if (audioBuf.length > 5 * 1024 * 1024) {
    return NextResponse.json(
      { error: "audio too large (max 5 MB)" },
      { status: 413 }
    );
  }

  // Cover is optional. If present, validate it's a small image.
  let coverBuf: Buffer | null = null;
  let coverExt: string | null = null;
  if (cover instanceof File && cover.size > 0) {
    const origName = cover.name || "";
    const ext = path.extname(origName).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) {
      return NextResponse.json(
        { error: `cover must be one of ${[...IMAGE_EXTS].join(", ")}` },
        { status: 400 }
      );
    }
    if (cover.size > 3 * 1024 * 1024) {
      return NextResponse.json(
        { error: "cover image too large (max 3 MB)" },
        { status: 413 }
      );
    }
    coverBuf = Buffer.from(await cover.arrayBuffer());
    coverExt = ext;
  }

  const id = randomUUID();

  try {
    const saved = upsertVoiceProfile({
      id,
      name: name.slice(0, 80),
      kind: "uploaded",
      engine: "user",
      createdAt: new Date().toISOString(),
      design: {},
      sampleBuffer: audioBuf,
      coverBuffer: coverBuf,
      coverExt,
    });
    return NextResponse.json({ voice: saved });
  } catch (err) {
    console.error("user upload upsert failed:", err);
    return NextResponse.json(
      { error: `Failed to save: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
