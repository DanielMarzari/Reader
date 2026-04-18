import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { getVoiceProfile, voiceSamplePath } from "@/lib/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const voice = getVoiceProfile(id);
  if (!voice) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const filePath = voiceSamplePath(id);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Sample not found" }, { status: 404 });
  }

  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  // @ts-expect-error Node Readable is accepted by the Response constructor
  // in Next's runtime, even though TS doesn't know that.
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${id}.mp3"`,
    },
  });
}
