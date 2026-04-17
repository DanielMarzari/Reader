import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createCollection, listCollections } from "@/lib/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ collections: listCollections() });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const name = (body.name as string | undefined)?.trim();
  if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });
  const id = randomUUID();
  try {
    createCollection(id, name);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  return NextResponse.json({ id, name });
}
