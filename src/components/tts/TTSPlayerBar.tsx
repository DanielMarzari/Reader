"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTTS } from "./TTSContext";
import { OcrBanner } from "./OcrBanner";
import { QueueVoiceBanner } from "./QueueVoiceBanner";
import type { ReaderVoice } from "@/types/voice";

function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function avatarGradient(v: ReaderVoice | null): string {
  const cols = (v?.design?.colors ?? []).filter(
    (c): c is string => typeof c === "string"
  );
  if (cols.length === 0) return "linear-gradient(135deg, #2f43fa, #818cf8)";
  if (cols.length === 1) return cols[0];
  return `conic-gradient(from 210deg, ${cols.join(", ")}, ${cols[0]})`;
}

function VoiceAvatar({
  voice,
  size = 36,
}: {
  voice: ReaderVoice | null;
  size?: number;
}) {
  const initial = voice?.name?.trim().charAt(0).toUpperCase() || "V";
  return (
    <span
      className="player-voice-avatar"
      style={{
        width: size,
        height: size,
        background: avatarGradient(voice),
      }}
    >
      <span
        style={{
          color: "white",
          fontWeight: 700,
          fontSize: size * 0.42,
          textShadow: "0 1px 2px rgba(0,0,0,0.35)",
        }}
      >
        {initial}
      </span>
    </span>
  );
}

// Human-readable category labels for the voice `kind` field. Voice
// Studio produces three kinds today (cloned / designed / uploaded);
// unknown values fall through to a "Voice" generic label.
const KIND_LABELS: Record<string, string> = {
  cloned: "Cloned",
  designed: "Designed",
  uploaded: "Uploaded",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? "Voice";
}

// Tabs across the top of the modal. "all" is special-cased so users
// can scan every voice at once; the rest filter by ReaderVoice.kind.
const TABS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "cloned", label: "Cloned" },
  { id: "designed", label: "Designed" },
  { id: "uploaded", label: "Uploaded" },
];

// Speechify-style centered modal with a filterable grid of voice
// cards. Each card = large gradient avatar + play-preview overlay +
// name + kind/playability tags. Selecting a card immediately swaps
// the active voice via the picker's onSelect handler (which lifts
// through setVoice → onVoiceChange → setBrowserVoiceId in
// ReaderClient).
function VoicePickerModal({
  voices,
  voicesLoading,
  voiceId,
  playingSampleId,
  onPreview,
  onSelect,
  onClose,
}: {
  voices: ReaderVoice[];
  voicesLoading: boolean;
  voiceId: string | null;
  playingSampleId: string | null;
  onPreview: (v: ReaderVoice) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<string>("all");
  const [query, setQuery] = useState<string>("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Only show tabs for kinds that actually have voices — if the user
  // hasn't uploaded anything, don't render an empty "Uploaded" tab.
  const availableTabs = useMemo(() => {
    const kinds = new Set(voices.map((v) => v.kind));
    return TABS.filter((t) => t.id === "all" || kinds.has(t.id));
  }, [voices]);

  const filteredVoices = useMemo(() => {
    const q = query.trim().toLowerCase();
    return voices.filter((v) => {
      if (activeTab !== "all" && v.kind !== activeTab) return false;
      if (!q) return true;
      const hay = [
        v.name,
        (v.design?.description as string | undefined) ?? "",
        kindLabel(v.kind),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [voices, activeTab, query]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Choose a voice"
    >
      <div
        className="relative max-h-[85vh] w-[min(96vw,720px)] overflow-hidden rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: title + search + close */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[color:var(--border)]">
          <div className="min-w-0">
            <div className="text-base font-semibold">Choose a voice</div>
            <div className="text-[11px] text-[color:var(--muted)] mt-0.5">
              {voices.length} voice{voices.length === 1 ? "" : "s"} in your
              library
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link
              href="/voice-lab"
              className="text-xs text-[color:var(--accent)] hover:underline whitespace-nowrap"
            >
              Voice Lab →
            </Link>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-[color:var(--muted)] hover:text-[color:var(--fg)] text-2xl leading-none px-1"
            >
              ×
            </button>
          </div>
        </div>

        {/* Tabs + search */}
        {!voicesLoading && voices.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-3 border-b border-[color:var(--border)]">
            <div className="flex gap-1 overflow-x-auto">
              {availableTabs.map((t) => {
                const active = t.id === activeTab;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTab(t.id)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                      active
                        ? "bg-[color:var(--accent)] text-white"
                        : "bg-[color:var(--surface-2)] text-[color:var(--fg)] hover:bg-[color:var(--surface-3,var(--surface-2))]"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search voices"
              className="input text-xs w-[min(40%,180px)]"
              style={{ padding: "6px 10px" }}
              aria-label="Search voices"
            />
          </div>
        )}

        {/* Grid body — `flex-1 min-h-0` is load-bearing: without
            min-h-0, flex children default to min-height:auto (intrinsic
            content height), so overflow-y-auto never kicks in and the
            modal grows past max-h-[85vh], pushing the grid off-screen. */}
        <div className="flex-1 min-h-0 p-4 overflow-y-auto">
          {voicesLoading ? (
            <div className="px-3 py-10 text-sm text-center text-[color:var(--muted)]">
              Loading voices…
            </div>
          ) : voices.length === 0 ? (
            <div className="px-3 py-10 text-sm text-center text-[color:var(--muted)]">
              No voices imported yet. Create one in{" "}
              <Link
                href="/voice-lab"
                className="text-[color:var(--accent)] hover:underline"
              >
                Voice Lab
              </Link>{" "}
              and it will appear here.
            </div>
          ) : filteredVoices.length === 0 ? (
            <div className="px-3 py-10 text-sm text-center text-[color:var(--muted)]">
              No voices match “{query}”.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {filteredVoices.map((v) => (
                <VoiceCard
                  key={v.id}
                  voice={v}
                  selected={v.id === voiceId}
                  previewPlaying={playingSampleId === v.id}
                  onSelect={onSelect}
                  onPreview={onPreview}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Individual voice tile. The whole tile is a button so any click
// inside it (other than the preview play overlay) selects the
// voice. The preview overlay uses stopPropagation so the user can
// audition a voice without committing to it.
function VoiceCard({
  voice,
  selected,
  previewPlaying,
  onSelect,
  onPreview,
}: {
  voice: ReaderVoice;
  selected: boolean;
  previewPlaying: boolean;
  onSelect: (id: string) => void;
  onPreview: (v: ReaderVoice) => void;
}) {
  const description = (voice.design?.description as string | undefined) ?? "";
  return (
    <button
      type="button"
      onClick={() => onSelect(voice.id)}
      className={`relative flex flex-col items-center gap-2.5 p-3 rounded-xl border text-center transition-all ${
        selected
          ? "border-[color:var(--accent)] bg-[color:var(--surface-2)] ring-2 ring-[color:var(--accent)]"
          : "border-[color:var(--border)] hover:border-[color:var(--accent)] hover:bg-[color:var(--surface-2)]"
      }`}
      aria-pressed={selected}
      aria-label={`Select ${voice.name}`}
    >
      {/* Avatar + preview play overlay */}
      <div className="relative">
        <VoiceAvatar voice={voice} size={72} />
        {voice.hasSample && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onPreview(voice);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onPreview(voice);
              }
            }}
            title={previewPlaying ? "Stop preview" : "Preview voice"}
            aria-label={previewPlaying ? "Stop preview" : "Preview voice"}
            className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 hover:opacity-100 focus:opacity-100 transition-opacity cursor-pointer"
            style={previewPlaying ? { opacity: 1 } : undefined}
          >
            {previewPlaying ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
                <path d="M6 4 L20 12 L6 20 Z" />
              </svg>
            )}
          </span>
        )}
        {selected && (
          <span
            className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-[color:var(--accent)] flex items-center justify-center shadow"
            aria-hidden="true"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12 L10 17 L19 7" />
            </svg>
          </span>
        )}
      </div>

      {/* Name */}
      <div
        className={`w-full truncate text-sm ${
          selected
            ? "font-semibold text-[color:var(--accent)]"
            : "font-medium"
        }`}
        title={voice.name}
      >
        {voice.name}
      </div>

      {/* Tags */}
      <div className="flex flex-wrap items-center justify-center gap-1">
        <span className="px-1.5 py-0.5 rounded text-[10px] bg-[color:var(--surface-2)] text-[color:var(--muted)]">
          {kindLabel(voice.kind)}
        </span>
        {voice.hasPromptMel && (
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
            Native
          </span>
        )}
      </div>

      {/* Optional description */}
      {description && (
        <div
          className="w-full text-[11px] text-[color:var(--muted)] line-clamp-2"
          title={description}
        >
          {description}
        </div>
      )}
    </button>
  );
}

export function TTSPlayerBar({
  docId,
  sourceType,
  onLoadAudiobook,
}: {
  /** Needed so the embedded OcrBanner can POST /api/documents/:id/ocr
   *  and poll for status. Passed down from ReaderClient rather than
   *  pulled from useTTS() — none of the three TTS provider shapes
   *  expose docId, and plumbing it through all three is more churn
   *  than a prop. */
  docId: string;
  sourceType: "pdf" | "epub" | "text";
  /** Forwarded to QueueVoiceBanner so a freshly rendered audiobook
   *  hands off to AudiobookProvider without an extra user click. */
  onLoadAudiobook?: (voiceId: string) => void;
}) {
  const {
    status,
    rate,
    voiceId,
    selectedVoice,
    voices,
    voicesLoading,
    elapsedSec,
    totalSec,
    progressPct,
    hasText,
    canPlay,
    play,
    pause,
    skip,
    seekFrac,
    cycleRate,
    setVoice,
  } = useTTS();
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const [playingSampleId, setPlayingSampleId] = useState<string | null>(null);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);

  const voiceTitle = selectedVoice?.name ?? "Browser voice";

  // Stop any sample preview when the picker closes.
  useEffect(() => {
    if (!voicePickerOpen && sampleAudioRef.current) {
      sampleAudioRef.current.pause();
      sampleAudioRef.current = null;
      setPlayingSampleId(null);
    }
  }, [voicePickerOpen]);

  function toggleSample(v: ReaderVoice) {
    if (playingSampleId === v.id && sampleAudioRef.current) {
      sampleAudioRef.current.pause();
      sampleAudioRef.current = null;
      setPlayingSampleId(null);
      return;
    }
    if (sampleAudioRef.current) {
      sampleAudioRef.current.pause();
    }
    const audio = new Audio(`/api/voices/${v.id}/sample`);
    audio.onended = () => {
      if (sampleAudioRef.current === audio) {
        sampleAudioRef.current = null;
        setPlayingSampleId(null);
      }
    };
    audio.onerror = () => {
      setPlayingSampleId(null);
      sampleAudioRef.current = null;
    };
    sampleAudioRef.current = audio;
    setPlayingSampleId(v.id);
    void audio.play().catch(() => setPlayingSampleId(null));
  }

  return (
    <div className="player">
      {/* OcrBanner only renders when there's something to say. For PDFs
          with no text it auto-triggers ocrmypdf server-side and polls
          for completion (then reloads the page). For anything already
          readable — or non-PDFs — it stays invisible. */}
      <OcrBanner docId={docId} sourceType={sourceType} />
      {/* QueueVoiceBanner appears only when hasText is true AND the
          mounted provider is the "no playable voice" stub — gives the
          user an inline "Queue with <voice>" button so they don't have
          to discover the nav-bar QueueVoiceButton. */}
      <QueueVoiceBanner docId={docId} onLoadAudiobook={onLoadAudiobook} />
      <div className="player-time">
        <span>{fmtTime(elapsedSec)}</span>
        <span>{fmtTime(totalSec)}</span>
      </div>
      <div
        className="player-progress"
        onClick={(e) => {
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          seekFrac((e.clientX - rect.left) / rect.width);
        }}
      >
        <div className="player-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>
      <div className="player-row">
        <button
          className="player-voice relative"
          onClick={() => setVoicePickerOpen((x) => !x)}
          aria-label="Change voice"
          title={voiceTitle}
        >
          <VoiceAvatar voice={selectedVoice} size={36} />
        </button>
        {voicePickerOpen && (
          <VoicePickerModal
            voices={voices}
            voicesLoading={voicesLoading}
            voiceId={voiceId}
            playingSampleId={playingSampleId}
            onPreview={toggleSample}
            onSelect={(id) => {
              setVoice(id);
              setVoicePickerOpen(false);
            }}
            onClose={() => setVoicePickerOpen(false)}
          />
        )}

        <button
          className="player-skip"
          onClick={() => skip(-10)}
          title="Back 10 seconds"
          aria-label="Back 10 seconds"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3.5 12 a8.5 8.5 0 1 0 3-6.5" strokeLinecap="round" />
            <path d="M3 4 v4 h4" strokeLinecap="round" strokeLinejoin="round" />
            <text x="12" y="15" textAnchor="middle" fontSize="7" fill="currentColor" stroke="none" fontWeight="700">10</text>
          </svg>
        </button>

        <button
          className="player-play"
          disabled={!hasText || !canPlay}
          onClick={
            status === "playing" || status === "loading" ? pause : play
          }
          aria-label={
            !hasText
              ? "No text to read"
              : !canPlay
              ? selectedVoice && !selectedVoice.hasPromptMel
                ? "Preview-only voice — clone in Voice Lab"
                : "No playable voice — queue an audiobook"
              : status === "playing"
              ? "Pause"
              : status === "loading"
              ? "Cancel"
              : "Play"
          }
          title={
            !hasText
              ? "This document has no readable text"
              : !canPlay
              ? selectedVoice
                ? selectedVoice.hasPromptMel
                  ? `Queue an audiobook with ${selectedVoice.name} to listen`
                  : `${selectedVoice.name} is preview-only — clone or design a voice in Voice Lab`
                : "Pick a Voice Lab voice to listen"
              : status === "playing"
              ? "Pause"
              : status === "loading"
              ? "Cancel"
              : "Play"
          }
          style={
            !hasText || !canPlay
              ? { opacity: 0.5, cursor: "not-allowed" }
              : undefined
          }
        >
          {status === "playing" ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : status === "loading" ? (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="animate-spin"
            >
              <circle cx="12" cy="12" r="9" opacity="0.25" />
              <path d="M12 3 A9 9 0 0 1 21 12" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 4 L20 12 L6 20 Z" />
            </svg>
          )}
        </button>

        <button
          className="player-skip"
          onClick={() => skip(10)}
          title="Forward 10 seconds"
          aria-label="Forward 10 seconds"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M20.5 12 a8.5 8.5 0 1 1 -3-6.5" strokeLinecap="round" />
            <path d="M21 4 v4 h-4" strokeLinecap="round" strokeLinejoin="round" />
            <text x="12" y="15" textAnchor="middle" fontSize="7" fill="currentColor" stroke="none" fontWeight="700">10</text>
          </svg>
        </button>

        <button className="player-speed" onClick={cycleRate} title="Playback speed">
          {rate}×
        </button>
      </div>
    </div>
  );
}
