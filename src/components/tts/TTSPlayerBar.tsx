"use client";

import { useState } from "react";
import { useTTS } from "./TTSContext";

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

export function TTSPlayerBar() {
  const {
    status,
    rate,
    voiceName,
    voices,
    elapsedSec,
    totalSec,
    progressPct,
    play,
    pause,
    skip,
    seekFrac,
    cycleRate,
    setVoice,
  } = useTTS();
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const voiceInitial = voiceName?.charAt(0).toUpperCase() || "V";

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
            className="player-voice"
            onClick={() => setVoicePickerOpen((x) => !x)}
            aria-label="Change voice"
            title={voiceName || "Voice"}
          >
            {voiceInitial}
          </button>
          {voicePickerOpen && (
            <div
              className="absolute bottom-12 left-0 bg-[color:var(--surface)] border border-[color:var(--border)] rounded-lg shadow-lg max-h-64 overflow-y-auto z-10 min-w-[220px]"
              onMouseLeave={() => setVoicePickerOpen(false)}
            >
              {voices.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[color:var(--muted)]">
                  No voices available
                </div>
              ) : (
                voices.map((v) => (
                  <button
                    key={v.name}
                    onClick={() => {
                      setVoice(v.name);
                      setVoicePickerOpen(false);
                    }}
                    className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-[color:var(--surface-2)] ${
                      v.name === voiceName ? "font-semibold text-[color:var(--accent)]" : ""
                    }`}
                  >
                    {v.name} <span className="text-[color:var(--muted)]">({v.lang})</span>
                  </button>
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
