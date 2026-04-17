import { NextRequest, NextResponse } from "next/server";
import { deleteCollection } from "@/lib/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  deleteCollection(id);
  return NextResponse.json({ ok: true });
}
