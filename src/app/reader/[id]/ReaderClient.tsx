"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { TTSProvider } from "@/components/tts/TTSContext";
import { AudiobookProvider } from "@/components/tts/AudiobookProvider";
import { TTSContent } from "@/components/tts/TTSContent";
import { TTSPlayerBar } from "@/components/tts/TTSPlayerBar";
import { PdfPagesViewer } from "@/components/PdfPagesViewer";
import { QueueVoiceButton } from "@/components/QueueVoiceButton";
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
  // <AudiobookProvider/> instead of <TTSProvider/>. null = use browser engine.
  const [audiobookVoiceId, setAudiobookVoiceId] = useState<string | null>(null);
  const [audiobookManifest, setAudiobookManifest] = useState<AudiobookManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);

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

  // When an audiobook is selected + its manifest is loaded, mount the
  // audiobook provider; otherwise the browser TTS provider. Swapping
  // providers tears down the previous playback cleanly (provider unmount).
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
