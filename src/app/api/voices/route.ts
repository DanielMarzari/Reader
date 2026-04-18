import { NextRequest, NextResponse } from "next/server";
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

// POST /api/voices — called by the Voice Studio local app.
// multipart/form-data:
//   metadata: JSON blob { id, name, kind, engine, createdAt, design }
//   sample:   audio/mpeg file (preview MP3, typically 6-10s)
// Bearer token required.
export async function POST(req: NextRequest) {
  if (!authorizeVoiceLabRequest(req)) {
    return NextResponse.json(
      { error: "Unauthorized — generate a token from the Voice Lab UI" },
      { status: 401 }
    );
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 }
    );
  }

  const form = await req.formData();
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
  if (buf.length === 0) {
    return NextResponse.json({ error: "Empty sample file" }, { status: 400 });
  }
  // Soft size ceiling (1.5 MB is enough for ~1 min of 192kbps MP3).
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
