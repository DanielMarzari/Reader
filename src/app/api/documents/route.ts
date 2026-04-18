import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { insertDocument, listDocuments } from "@/lib/documents";
import { countWords, parseEpub, parsePdf, parseText, normalize } from "@/lib/parse";
import { saveOriginal } from "@/lib/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const docs = listDocuments();
  return NextResponse.json({ documents: docs });
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";

  let title = "Untitled";
  let sourceType: "pdf" | "epub" | "text" = "text";
  let originalFilename: string | null = null;
  let content = "";
  let originalBuffer: Buffer | null = null;

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const providedTitle = (form.get("title") as string | null)?.trim() ?? "";
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    originalFilename = file.name;
    const lower = file.name.toLowerCase();
    originalBuffer = buffer;

    try {
      if (lower.endsWith(".pdf") || file.type === "application/pdf") {
        sourceType = "pdf";
        content = await parsePdf(buffer);
      } else if (lower.endsWith(".epub") || file.type === "application/epub+zip") {
        sourceType = "epub";
        const parsed = await parseEpub(buffer);
        content = parsed.content;
        if (!providedTitle && parsed.title) title = parsed.title;
      } else if (
        lower.endsWith(".txt") ||
        lower.endsWith(".md") ||
        file.type.startsWith("text/")
      ) {
        sourceType = "text";
        content = await parseText(buffer);
      } else {
        return NextResponse.json(
          { error: `Unsupported file type: ${file.type || lower}` },
          { status: 400 }
        );
      }
    } catch (err) {
      return NextResponse.json(
        { error: `Failed to parse file: ${(err as Error).message}` },
        { status: 400 }
      );
    }

    if (providedTitle) title = providedTitle;
    else if (title === "Untitled") title = file.name.replace(/\.(pdf|epub|txt|md)$/i, "");
  } else if (contentType.includes("application/json")) {
    const body = await req.json();
    const rawText = (body.text as string) ?? "";
    const providedTitle = (body.title as string)?.trim() ?? "";
    if (!rawText.trim()) {
      return NextResponse.json({ error: "Text is empty" }, { status: 400 });
    }
    sourceType = "text";
    content = normalize(rawText);
    title = providedTitle || content.slice(0, 60).replace(/\s+/g, " ") + (content.length > 60 ? "…" : "");
  } else {
    return NextResponse.json({ error: "Unsupported content-type" }, { status: 400 });
  }

  if (!content.trim()) {
    return NextResponse.json({ error: "Extracted text is empty" }, { status: 400 });
  }

  const id = randomUUID();

  // Persist original PDF/EPUB so the Pages tab can render it. Text files
  // don't need the original — we already have the full content.
  let storedPath: string | null = null;
  if (originalBuffer && (sourceType === "pdf" || sourceType === "epub")) {
    try {
      storedPath = await saveOriginal(id, sourceType, originalBuffer);
    } catch (err) {
      console.warn("Failed to save original upload:", (err as Error).message);
    }
  }

  insertDocument({
    id,
    title: title.slice(0, 250),
    sourceType,
    originalFilename,
    content,
    wordCount: countWords(content),
    storedPath,
  });

  return NextResponse.json({ id });
}
