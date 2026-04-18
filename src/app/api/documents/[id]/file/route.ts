// Serves the original uploaded PDF/EPUB for the Pages tab viewer.
// Returns 404 for text-only documents (no original stored).

import { NextRequest, NextResponse } from "next/server";
import { getDocument, getStoredPath } from "@/lib/documents";
import { contentTypeFor, readOriginal } from "@/lib/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const doc = getDocument(id);
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const storedPath = getStoredPath(id);
  if (!storedPath) {
    return NextResponse.json(
      { error: "No original file stored for this document" },
      { status: 404 }
    );
  }
  try {
    const buf = await readOriginal(storedPath);
    // Response wants a BodyInit; an ArrayBuffer works everywhere.
    const ab = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength
    );
    return new Response(ab, {
      status: 200,
      headers: {
        "Content-Type": contentTypeFor(doc.sourceType),
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "File missing on server" },
      { status: 404 }
    );
  }
}
