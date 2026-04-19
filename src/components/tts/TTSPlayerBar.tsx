"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTTS } from "./TTSContext";
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

export function TTSPlayerBar() {
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
    play,
    pause,
    skip,
    seekFrac,
    cycleRate,
    setVoice,
    engine,
  } = useTTS();
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const [playingSampleId, setPlayingSampleId] = useState<string | null>(null);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);

  const engineLabel = engine === "voice-studio" ? "Voice Studio" : "Browser";
  const voiceTitle = selectedVoice?.name
    ? `${engineLabel}: ${selectedVoice.name}`
    : engineLabel;

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
        <div className="relative">
          <button
            className="player-voice relative"
            onClick={() => setVoicePickerOpen((x) => !x)}
            aria-label="Change voice"
            title={voiceTitle}
          >
            <VoiceAvatar voice={selectedVoice} size={36} />
            {engine === "voice-studio" && (
              <span
                className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[color:var(--accent)] border border-[color:var(--surface)]"
                aria-hidden
                title="Voice Studio engine (local)"
              />
            )}
          </button>
          {voicePickerOpen && (
            <div
              className="absolute bottom-12 left-0 bg-[color:var(--surface)] border border-[color:var(--border)] rounded-lg shadow-lg max-h-72 overflow-y-auto z-10 min-w-[260px]"
            >
              <div className="px-3 py-2 border-b border-[color:var(--border)] flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--muted)]">
                  Voice
                </span>
                <Link
                  href="/voice-lab"
                  className="text-xs text-[color:var(--accent)] hover:underline"
                >
                  Voice Lab →
                </Link>
              </div>
              {voicesLoading ? (
                <div className="px-3 py-4 text-xs text-[color:var(--muted)]">
                  Loading voices…
                </div>
              ) : voices.length === 0 ? (
                <div className="px-3 py-4 text-xs text-[color:var(--muted)]">
                  No voices imported yet. Create one in Voice Studio and it
                  will appear here.
                </div>
              ) : (
                voices.map((v) => (
                  <div
                    key={v.id}
                    className={`flex items-center gap-2 px-2 py-2 text-sm hover:bg-[color:var(--surface-2)] ${
                      v.id === voiceId ? "bg-[color:var(--surface-2)]" : ""
                    }`}
                  >
                    <button
                      onClick={() => {
                        setVoice(v.id);
                      }}
                      className="flex items-center gap-2 flex-1 text-left min-w-0"
                    >
                      <VoiceAvatar voice={v} size={28} />
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate ${
                            v.id === voiceId
                              ? "font-semibold text-[color:var(--accent)]"
                              : ""
                          }`}
                        >
                          {v.name}
                        </span>
                        {v.design?.description ? (
                          <span className="block text-[11px] text-[color:var(--muted)] truncate">
                            {v.design.description as string}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {v.hasSample && (
                      <button
                        onClick={() => toggleSample(v)}
                        className="btn-ghost"
                        title={playingSampleId === v.id ? "Stop preview" : "Preview"}
                        aria-label={playingSampleId === v.id ? "Stop preview" : "Preview"}
                        style={{ padding: 4 }}
                      >
                        {playingSampleId === v.id ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="5" width="4" height="14" rx="1" />
                            <rect x="14" y="5" width="4" height="14" rx="1" />
                          </svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 4 L20 12 L6 20 Z" />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

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
          onClick={status === "playing" ? pause : play}
          aria-label={status === "playing" ? "Pause" : "Play"}
        >
          {status === "playing" ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
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
