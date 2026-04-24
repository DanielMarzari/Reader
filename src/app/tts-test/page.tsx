import { TtsTestClient } from "./TtsTestClient";

// Server component shell — client-only interactivity goes in TtsTestClient.
// This page is a dev-mode proof-of-concept for the browser-native TTS
// pipeline. It replaces Spike B's standalone HTML harness with a real
// Reader route so we can iterate inside the app shell, benefit from
// Next.js's COOP/COEP headers, and catch integration issues (like
// ORT-Web + React 19 + Next 16 interactions) early.
//
// NOT user-facing. Phase 3's real integration lives on /reader/[id]
// once BrowserInferenceProvider is wired up.

export const dynamic = "force-dynamic";

export default function TtsTestPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-xl font-semibold mb-1">TTS test harness</h1>
        <p className="text-sm text-slate-400 mb-6">
          Dev page for browser-native ZipVoice + Vocos. Fake tokens; produces
          audible noise with the correct voice timbre. Phase 3 integration
          test, not user-facing.
        </p>
        <TtsTestClient />
      </div>
    </div>
  );
}
