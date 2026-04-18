import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getVoiceProfile, voiceSampleDir } from "@/lib/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cover filenames use their original extension so we have to probe.
function findCover(id: string): { filePath: string; contentType: string } | null {
  const dir = voiceSampleDir(id);
  if (!fs.existsSync(dir)) return null;
  for (const ext of [".png", ".jpg", ".jpeg", ".webp", ".gif"]) {
    const p = path.join(dir, `cover${ext}`);
    if (fs.existsSync(p)) {
      const contentType =
        ext === ".png"
          ? "image/png"
          : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
          ? "image/gif"
          : "image/jpeg";
      return { filePath: p, contentType };
    }
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const voice = getVoiceProfile(id);
  if (!voice) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const found = findCover(id);
  if (!found) return NextResponse.json({ error: "No cover" }, { status: 404 });

  const stat = fs.statSync(found.filePath);
  const stream = fs.createReadStream(found.filePath);
  // @ts-expect-error — Node Readable works here per Next runtime.
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": found.contentType,
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
