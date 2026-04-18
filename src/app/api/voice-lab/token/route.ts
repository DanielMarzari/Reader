import { NextRequest, NextResponse } from "next/server";
import {
  createVoiceLabToken,
  listVoiceLabTokens,
  revokeAllVoiceLabTokens,
} from "@/lib/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/voice-lab/token — list tokens (metadata only, no secrets).
export async function GET() {
  const tokens = listVoiceLabTokens();
  return NextResponse.json({ tokens });
}

// POST /api/voice-lab/token — mint a new bearer token. The plaintext is
// returned ONCE in the response body — after this, only the sha256 hash
// is retained server-side.
export async function POST(req: NextRequest) {
  let label: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.label === "string") label = body.label.slice(0, 60);
  } catch {
    /* tolerate missing/empty body */
  }

  const { token, record } = createVoiceLabToken(label);
  return NextResponse.json({
    token,
    record,
    warning:
      "This token will not be shown again. Paste it into Voice Studio's .env.local now.",
  });
}

// DELETE /api/voice-lab/token — revoke ALL tokens. Cheap "panic button" in
// the UI. Per-token revoke can come later if we ever show token list.
export async function DELETE() {
  const n = revokeAllVoiceLabTokens();
  return NextResponse.json({ revoked: n });
}
