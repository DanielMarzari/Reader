"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TTSProvider } from "@/components/tts/TTSContext";
import { AudiobookProvider } from "@/components/tts/AudiobookProvider";
// BrowserInferenceProvider imports onnxruntime-web — specifically the
// WebGPU bundle (`ort.webgpu.bundle.min.mjs`) via the turbopack alias
// in next.config.ts. That bundle self-locates at module top-level via
// `new URL(import.meta.url)`, which throws "Invalid URL" during
// Turbopack's SSR pass because `import.meta.url` there is a relative
// `/ _next/static/media/...` path, not absolute. Even though this file
// and the provider are both "use client", Next still evaluates client
// modules on the server to pre-render initial HTML — so the ORT
// bundle is evaluated server-side and crashes SSR.
//
// next/dynamic + `ssr: false` creates a true client-only boundary:
// the provider module is NEVER evaluated on the server, so the ORT
// import chain doesn't fire until the browser picks up the chunk.
const BrowserInferenceProvider = dynamic(
  () =>
    import("@/components/tts/BrowserInferenceProvider").then((m) => ({
      default: m.BrowserInferenceProvider,
    })),
  { ssr: false }
);
import { TTSContent } from "@/components/tts/TTSContent";
import { TTSPlayerBar } from "@/components/tts/TTSPlayerBar";
import { PdfPagesViewer } from "@/components/PdfPagesViewer";
import type { ReaderVoice } from "@/types/voice";
import {
  SettingsDrawer,
  applyTheme,
  defaultSettings,
  loadSettings,
  saveSettings,
  type ReaderSettings,
} from "@/components/SettingsDrawer";
import type { InferenceCapability } from "@/lib/tts/device-capability";

type Props = {
  docId: string;
  title: string;
  sourceType: "pdf" | "epub" | "text";
  wordCount: number;
  content: string;
  pageRanges: Array<{ charStart: number; charEnd: number }> | null;
  initialCharIndex: number;
  initialRate: number;
  initialVoiceName: string | null;
};

// Shape pulled from /api/audiobooks/:doc/:voice/manifest.
type AudiobookManifest = {
  documentId: string;
  voiceId: string;
  voiceName: string;
  engine: string;
  totalDurationMs: number;
  chunks: Array<{
    index: number;
    charStart: number;
    charEnd: number;
    durationMs: number;
    wordOffsetsMs?: number[];
  }>;
};

export function ReaderClient({
  docId,
  title,
  sourceType,
  wordCount,
  content,
  pageRanges,
  initialCharIndex,
  initialRate,
  initialVoiceName,
}: Props) {
  const [settings, setSettings] = useState<ReaderSettings>(defaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // When the user picks an audiobook, we fetch its manifest + mount
  // <AudiobookProvider/> instead of <TTSProvider/>. null = use browser
  // inference (if voice has prompt_mel), otherwise fall through to the
  // no-playable-voice stub which nudges the user to queue an audiobook.
  const [audiobookVoiceId, setAudiobookVoiceId] = useState<string | null>(null);
  const [audiobookManifest, setAudiobookManifest] = useState<AudiobookManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);

  // Voice library — Reader-wide list of available voices. We load once
  // in the ReaderClient (not inside TTSProvider) so the page can decide
  // WHICH provider to mount based on the selected voice's
  // `hasPromptMel`. The mounted provider still owns the current
  // voiceId; we just need enough data to pick between providers.
  const [voices, setVoices] = useState<ReaderVoice[] | null>(null);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [browserVoiceId, setBrowserVoiceId] = useState<string | null>(
    initialVoiceName
  );

  // Device/browser capability — does the user's setup support the
  // in-browser ZipVoice pipeline, or do we need to fall through to
  // the audiobook/Web-Speech path? `null` = still detecting;
  // `canRun: false` = block + show the CapabilityBanner below.
  const [capability, setCapability] = useState<InferenceCapability | null>(
    null
  );
  const [capabilityBannerDismissed, setCapabilityBannerDismissed] = useState(
    false
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/voices")
      .then((r) => r.json())
      .then((d: { voices: ReaderVoice[] }) => {
        if (!cancelled) setVoices(d.voices);
      })
      .catch(() => {
        if (!cancelled) setVoices([]);
      })
      .finally(() => {
        if (!cancelled) setVoicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Kick off capability detection once on mount. Dynamically imported
  // to keep it out of the SSR evaluation path (it ends up pulling in
  // browser-inference.ts, which in turn loads the ORT-Web bundle —
  // ReaderClient is "use client" but Next still evaluates client
  // modules during pre-render and ORT's `new URL(import.meta.url)`
  // throws server-side. The dynamic import defers eval to the
  // browser, mirroring what we do for BrowserInferenceProvider
  // itself.).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import("@/lib/tts/device-capability");
        const cap = await mod.detectInferenceCapability();
        if (!cancelled) setCapability(cap);
      } catch (e) {
        if (!cancelled) {
          console.warn("[Reader] capability detection failed:", e);
          setCapability({
            deviceClass: "desktop",
            webgpu: { available: false, reason: "detection threw" },
            canRun: false,
            headline: "Can't run voice locally",
            recommendation:
              "Capability detection failed — falling back to the queued audiobook or system voice.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** If a voice is currently selected AND it has prompt_mel available
   *  AND no audiobook is chosen AND the device/browser can actually
   *  run browser inference → mount BrowserInferenceProvider.
   *  Otherwise we fall through to the audiobook/Web-Speech path. */
  const browserVoice = useMemo<ReaderVoice | null>(() => {
    if (audiobookVoiceId) return null;
    if (!voices || !browserVoiceId) return null;
    // Wait for capability detection before committing — avoids
    // mounting the provider, starting a 660 MB download, then tearing
    // it down when detection says "nope, you're on iPhone".
    if (!capability || !capability.canRun) return null;
    const v = voices.find(
      (v) => v.id === browserVoiceId || v.name === browserVoiceId
    );
    return v?.hasPromptMel ? v : null;
  }, [voices, browserVoiceId, audiobookVoiceId, capability]);

  /** Would we normally load this voice in the browser, but something
   *  about the device/browser blocks it? When true the CapabilityBanner
   *  appears explaining why. */
  const capabilityBlocks = useMemo<boolean>(() => {
    if (!voices || !browserVoiceId) return false;
    if (audiobookVoiceId) return false;
    if (!capability) return false;
    if (capability.canRun) return false;
    const v = voices.find(
      (v) => v.id === browserVoiceId || v.name === browserVoiceId
    );
    return !!v?.hasPromptMel;
  }, [voices, browserVoiceId, audiobookVoiceId, capability]);

  const pagesAvailable = sourceType === "pdf";

  useEffect(() => {
    const s = loadSettings();
    const resolved: ReaderSettings = {
      ...s,
      view: !pagesAvailable ? "text" : s.view,
    };
    setSettings(resolved);
    applyTheme(resolved.theme);
    setHydrated(true);
  }, [pagesAvailable]);

  // Register the TTS service worker once on reader mount. It
  // precaches the onnxruntime-web WASM backend (~32 MB) + tokens.txt
  // + model.json so cold-start round-trips vanish. Register on the
  // reader page specifically because that's where we first care about
  // ORT assets — the library home page doesn't load them. Fire-and-
  // forget; SW failure is non-fatal (we just lose the precache).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => {
        console.warn("[Reader] SW registration failed:", err);
      });
  }, []);

  function onSettingsChange(next: ReaderSettings) {
    setSettings(next);
    saveSettings(next);
  }

  const selectAudiobook = useCallback(
    async (voiceId: string) => {
      setManifestLoading(true);
      try {
        const r = await fetch(`/api/audiobooks/${docId}/${voiceId}/manifest`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const manifest = (await r.json()) as AudiobookManifest;
        setAudiobookManifest(manifest);
        setAudiobookVoiceId(voiceId);
      } catch (e) {
        console.warn("manifest load:", e);
      } finally {
        setManifestLoading(false);
      }
    },
    [docId]
  );

  const nav = (
    <nav className="reader-nav">
      <Link href="/" className="btn-ghost" aria-label="Back to library" title="Back to library">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 6 L9 12 L15 18" />
        </svg>
      </Link>

      <div className="flex-1 min-w-0 flex flex-col items-center">
        <div className="truncate text-sm font-semibold max-w-full px-2" title={title}>
          {title}
        </div>
        <div className="text-[10px] text-[color:var(--muted)] uppercase tracking-wide">
          {sourceType === "pdf" && pageRanges && pageRanges.length > 0
            ? `PDF · ${pageRanges.length.toLocaleString()} ${
                pageRanges.length === 1 ? "page" : "pages"
              }`
            : `${sourceType} · ${wordCount.toLocaleString()} words`}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          className="btn-ghost"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          title="Settings"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.13-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.13 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1.03-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1.03z" />
          </svg>
        </button>
      </div>
    </nav>
  );

  const body = (
    <>
      <main className="reader-canvas flex-1">
        {hydrated && settings.view === "pages" && pagesAvailable ? (
          <PdfPagesViewer
            docId={docId}
            sourceType={sourceType}
            pageRanges={pageRanges}
            highlightSentence={settings.highlightSentence}
          />
        ) : (
          <TTSContent highlightSentence={settings.highlightSentence} />
        )}
      </main>
      <TTSPlayerBar
        docId={docId}
        sourceType={sourceType}
        onLoadAudiobook={selectAudiobook}
      />
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={onSettingsChange}
        pagesAvailable={pagesAvailable}
      />
      <span className="sr-only">{wordCount}</span>
    </>
  );

  // Three-way provider selection, in preference order:
  //
  //   1. AudiobookProvider  — explicit pre-rendered MP3 chunks via
  //      the QueueVoiceButton ("Queue / Listen with…" flow).
  //   2. BrowserInferenceProvider — ZipVoice-Distill running locally
  //      in the browser. Requires the voice to have `hasPromptMel`
  //      (Voice Studio's Clone endpoint ships prompt_mel.f32).
  //   3. TTSProvider — "no playable voice" stub. Loads the voice list
  //      and persists the user's pick, but Play is disabled and the
  //      player bar shows a "Queue an audiobook" prompt. We do NOT
  //      fall through to the browser's Web Speech API — we only ever
  //      play Voice Lab voices, never the OS default voice.
  //
  // Swapping providers tears down the previous playback cleanly via
  // the provider's unmount effect.
  const chosenProvider = audiobookVoiceId && audiobookManifest
    ? "AudiobookProvider"
    : browserVoice && voices
    ? "BrowserInferenceProvider"
    : "TTSProvider (no-playable-voice stub)";
  console.log(
    `[Reader] Provider selection → ${chosenProvider} ` +
      `(voices=${voices?.length ?? "loading"}, ` +
      `browserVoiceId=${browserVoiceId ?? "none"}, ` +
      `hasPromptMel=${
        voices?.find((v) => v.id === browserVoiceId || v.name === browserVoiceId)?.hasPromptMel ?? "?"
      }, ` +
      `capability.canRun=${capability?.canRun ?? "detecting"}, ` +
      `audiobookVoiceId=${audiobookVoiceId ?? "none"}, ` +
      `wordCount=${wordCount})`
  );

  if (audiobookVoiceId && audiobookManifest) {
    return (
      <AudiobookProvider
        docId={docId}
        voiceId={audiobookVoiceId}
        manifest={audiobookManifest}
        content={content}
        initialCharIndex={initialCharIndex}
        initialRate={initialRate}
        clickToListen={settings.clickToListen}
      >
        <div className="min-h-screen flex flex-col">
          {nav}
          {body}
          {manifestLoading && (
            <div className="fixed top-14 right-4 chip">Loading audiobook…</div>
          )}
        </div>
      </AudiobookProvider>
    );
  }

  if (browserVoice && voices) {
    return (
      <BrowserInferenceProvider
        docId={docId}
        content={content}
        voiceId={browserVoice.id}
        selectedVoice={browserVoice}
        voices={voices}
        voicesLoading={voicesLoading}
        initialCharIndex={initialCharIndex}
        initialRate={initialRate}
        clickToListen={settings.clickToListen}
        onVoiceChange={setBrowserVoiceId}
      >
        <div className="min-h-screen flex flex-col">
          {nav}
          {body}
        </div>
      </BrowserInferenceProvider>
    );
  }

  return (
    <TTSProvider
      docId={docId}
      content={content}
      initialCharIndex={initialCharIndex}
      initialRate={initialRate}
      // Prefer the user's latest pick (browserVoiceId) over the
      // page-load default — otherwise, when the user swaps from a
      // hasPromptMel voice to one without prompt_mel, we'd unmount
      // BrowserInferenceProvider and remount this stub with the OLD
      // voice name, silently reverting the selection they just made.
      initialVoiceName={browserVoiceId ?? initialVoiceName}
      clickToListen={settings.clickToListen}
      autoSkip={settings.autoSkip}
      onVoiceChange={setBrowserVoiceId}
    >
      <div className="min-h-screen flex flex-col">
        {nav}
        {capabilityBlocks && !capabilityBannerDismissed && capability && (
          <CapabilityBanner
            capability={capability}
            onDismiss={() => setCapabilityBannerDismissed(true)}
          />
        )}
        {body}
        {manifestLoading && (
          <div className="fixed top-14 right-4 chip">Loading audiobook…</div>
        )}
      </div>
    </TTSProvider>
  );
}

/** Appears at the top of the reader when the user selected a voice
 *  with `hasPromptMel` (i.e. one capable of in-browser inference) but
 *  the device/browser can't actually run it — iPhone, no-WebGPU
 *  Firefox, etc. Explains the situation and points at the
 *  alternatives (queue audiobook via the nav button, or the system
 *  voice they're already hearing if they hit play). Dismissible
 *  because they only need to hear it once per session. */
function CapabilityBanner({
  capability,
  onDismiss,
}: {
  capability: InferenceCapability;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="mx-3 mt-2 mb-1 rounded-xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-500/40 px-3 py-2.5 text-xs shadow-sm flex items-start gap-3"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 mt-[1px] text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      >
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      </svg>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-amber-900 dark:text-amber-200">
          {capability.headline ?? "Voice unavailable on this device"}
        </div>
        <div className="text-amber-900/80 dark:text-amber-200/80 mt-0.5">
          {capability.recommendation}
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-amber-700/70 dark:text-amber-300/70 hover:text-amber-900 dark:hover:text-amber-200 -mt-1 -mr-1 p-1"
      >
        ×
      </button>
    </div>
  );
}
