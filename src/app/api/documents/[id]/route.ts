import { NextRequest, NextResponse } from "next/server";
import {
  deleteDocument,
  getDocument,
  getStoredPath,
  setDocumentCollections,
  updateDocumentTitle,
} from "@/lib/documents";
import { deleteOriginal } from "@/lib/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const doc = getDocument(id);
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(doc);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const existing = getDocument(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await req.json();
  if (typeof body.title === "string" && body.title.trim()) {
    updateDocumentTitle(id, body.title.trim().slice(0, 250));
  }
  if (Array.isArray(body.collectionIds)) {
    setDocumentCollections(id, body.collectionIds.filter((x: unknown) => typeof x === "string"));
  }
  const updated = getDocument(id);
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const storedPath = getStoredPath(id);
  deleteDocument(id);
  await deleteOriginal(storedPath);
  return NextResponse.json({ ok: true });
}
