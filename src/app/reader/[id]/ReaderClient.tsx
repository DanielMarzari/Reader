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
import { QueueVoiceButton } from "@/components/QueueVoiceButton";
import type { ReaderVoice } from "@/types/voice";
import {
  SettingsDrawer,
  applyTheme,
  defaultSettings,
  loadSettings,
  saveSettings,
  type ReaderSettings,
} from "@/components/SettingsDrawer";

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
  // inference (if voice has prompt_mel) or the Web Speech fallback.
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

  /** If a voice is currently selected AND it has prompt_mel available
   *  AND no audiobook is chosen → mount BrowserInferenceProvider. */
  const browserVoice = useMemo<ReaderVoice | null>(() => {
    if (audiobookVoiceId) return null;
    if (!voices || !browserVoiceId) return null;
    const v = voices.find(
      (v) => v.id === browserVoiceId || v.name === browserVoiceId
    );
    return v?.hasPromptMel ? v : null;
  }, [voices, browserVoiceId, audiobookVoiceId]);

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
          {sourceType} · {wordCount.toLocaleString()} words
        </div>
      </div>

      <div className="flex items-center gap-2">
        <QueueVoiceButton
          documentId={docId}
          selectedVoiceId={audiobookVoiceId}
          onSelectAudiobook={selectAudiobook}
        />
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
      <TTSPlayerBar />
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
  //   3. TTSProvider — Web Speech API fallback, always works but uses
  //      the OS default voice (no cloning).
  //
  // Swapping providers tears down the previous playback cleanly via
  // the provider's unmount effect.
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
      initialVoiceName={initialVoiceName}
      clickToListen={settings.clickToListen}
      autoSkip={settings.autoSkip}
    >
      <div className="min-h-screen flex flex-col">
        {nav}
        {body}
        {manifestLoading && (
          <div className="fixed top-14 right-4 chip">Loading audiobook…</div>
        )}
      </div>
    </TTSProvider>
  );
}
