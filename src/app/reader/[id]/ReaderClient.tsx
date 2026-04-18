"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TTSProvider } from "@/components/tts/TTSContext";
import { TTSContent } from "@/components/tts/TTSContent";
import { TTSPlayerBar } from "@/components/tts/TTSPlayerBar";
import { PdfPagesViewer } from "@/components/PdfPagesViewer";
import {
  SettingsDrawer,
  applyTheme,
  defaultSettings,
  loadSettings,
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

type Tab = "text" | "pages";

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
  const [tab, setTab] = useState<Tab>("text");

  useEffect(() => {
    const s = loadSettings();
    setSettings(s);
    applyTheme(s.theme);
  }, []);

  const pagesAvailable = sourceType === "pdf";

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

          <div className="tab-switch" role="tablist" aria-label="View mode">
            <button
              role="tab"
              aria-selected={tab === "text"}
              className={tab === "text" ? "active" : ""}
              onClick={() => setTab("text")}
            >
              Text
            </button>
            <button
              role="tab"
              aria-selected={tab === "pages"}
              className={tab === "pages" ? "active" : ""}
              onClick={() => pagesAvailable && setTab("pages")}
              disabled={!pagesAvailable}
              title={pagesAvailable ? "" : "Pages view only available for PDFs"}
              style={pagesAvailable ? undefined : { opacity: 0.5, cursor: "not-allowed" }}
            >
              Pages
            </button>
          </div>

          <button
            className="btn-ghost ml-1"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title="Settings"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.13-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.13 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1.03-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1.03z" />
            </svg>
          </button>
        </nav>

        <main className="reader-canvas flex-1">
          {tab === "text" ? (
            <TTSContent highlightSentence={settings.highlightSentence} />
          ) : (
            <PdfPagesViewer
              docId={docId}
              sourceType={sourceType}
              pageRanges={pageRanges}
            />
          )}
        </main>

        <TTSPlayerBar />

        <SettingsDrawer
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          onChange={setSettings}
        />

        {/* Suppress unused-variable lint for wordCount if any linter runs */}
        <span className="sr-only">{wordCount}</span>
      </div>
    </TTSProvider>
  );
}
