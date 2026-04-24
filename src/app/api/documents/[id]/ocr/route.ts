// OCR status + trigger endpoint for a single document.
//
// GET  → current status (idle | running | done | failed | unavailable)
// POST → idempotently kick off OCR if needed; returns current status
//
// The client's <OcrBanner/> POSTs once on mount when the doc has no
// text, then polls GET every 2s until status transitions out of
// "running". See src/lib/ocr.ts for the actual pipeline.

import { NextRequest, NextResponse } from "next/server";
import { getOcrStatus, triggerOcr } from "@/lib/ocr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return NextResponse.json(getOcrStatus(id));
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const status = await triggerOcr(id);
  return NextResponse.json(status);
}
