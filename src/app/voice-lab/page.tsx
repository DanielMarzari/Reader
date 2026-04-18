import { VoiceLabClient } from "./VoiceLabClient";

// Server component wrapper — keeps the route thin so we can add server-only
// logic later (e.g. gating behind AUTH_PASSWORD) without disturbing the UI.
export default function VoiceLabPage() {
  return <VoiceLabClient />;
}
