"use client";

// QueueVoiceBanner — shown in the player bar when the current (doc,
// voice) pair has no playback path. Specifically: the selected voice
// has no `prompt_mel` (can't run browser inference), there's no
// pre-rendered audiobook for it, and we can't fall back to OS voices
// because we don't use them.
//
// Gives the user one obvious action: queue an audiobook render for
// this voice. The UI mirrors OcrBanner's tonal states:
//   - default: blue "Queue to listen with {voice}" + action button
//   - queued:  blue spinner "Queued {voice}… waiting for Voice Studio"
//   - rendering: blue spinner "Rendering {voice}… 12/32 chunks"
//   - ready:   blue "Audiobook ready — tap Listen to load" (shouldn't
//              actually appear here because ReaderClient switches to
//              AudiobookProvider once ready, but kept as a courtesy
//              state during the ~1s manifest load)
//   - failed:  red "Render failed — try again"
//
// The actual voice-change flow still happens via the voice picker
// modal (user can pick a different voice from the player bar avatar).
// This banner's job is just making the queue action trivially
// reachable when a voice has no playable path yet.

import { useCallback, useEffect, useState } from "react";
import { useTTS } from "./TTSContext";

type AudiobookEntry =
  | {
      voiceId: string;
      voiceName: string;
      engine: string;
      status: "ready";
      totalDurationMs: number;
      chunks: number;
    }
  | {
      voiceId: string;
      voiceName: string;
      engine: string;
      status: "pending" | "rendering" | "failed";
      jobId: string;
      chunksDone: number;
      chunksTotal: number | null;
      priority: string;
      error: string | null;
    };

type BannerState =
  | { kind: "idle" }
  | { kind: "queuing" }
  | {
      kind: "queued" | "rendering";
      voiceName: string;
      chunksDone: number;
      chunksTotal: number | null;
    }
  | { kind: "ready"; voiceName: string }
  | { kind: "failed"; message: string };

export function QueueVoiceBanner({
  docId,
  onLoadAudiobook,
}: {
  docId: string;
  /** Called as soon as a render completes (or one is already ready)
   *  for the currently selected voice. ReaderClient uses this to fetch
   *  the manifest and swap us out for AudiobookProvider — no extra
   *  click required from the user. */
  onLoadAudiobook?: (voiceId: string) => void;
}) {
  const { canPlay, hasText, selectedVoice, voiceId } = useTTS();
  const [state, setState] = useState<BannerState>({ kind: "idle" });

  const refresh = useCallback(async () => {
    if (!voiceId) return;
    try {
      const r = await fetch(`/api/documents/${docId}/audiobooks`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as {
        ready: AudiobookEntry[];
        inflight: AudiobookEntry[];
      };
      const match = [...(json.ready ?? []), ...(json.inflight ?? [])].find(
        (e) => e.voiceId === voiceId
      );
      if (!match) {
        setState({ kind: "idle" });
        return;
      }
      if (match.status === "ready") {
        setState({ kind: "ready", voiceName: match.voiceName });
        // Auto-load: as soon as a render completes for the active
        // voice, hand off to AudiobookProvider. The user never has to
        // hunt for a "load" button — the page just starts playable.
        onLoadAudiobook?.(match.voiceId);
      } else if (match.status === "pending" || match.status === "rendering") {
        setState({
          kind: match.status === "pending" ? "queued" : "rendering",
          voiceName: match.voiceName,
          chunksDone: match.chunksDone,
          chunksTotal: match.chunksTotal,
        });
      } else {
        setState({
          kind: "failed",
          message: match.error ?? "render failed",
        });
      }
    } catch (err) {
      console.warn("[QueueVoiceBanner] audiobook status poll failed:", err);
    }
  }, [docId, voiceId]);

  // Initial load + poll while a job is in flight.
  useEffect(() => {
    if (!canPlay) void refresh();
  }, [canPlay, refresh]);

  useEffect(() => {
    if (state.kind !== "queued" && state.kind !== "rendering") return;
    const h = setInterval(refresh, 3000);
    return () => clearInterval(h);
  }, [state.kind, refresh]);

  const queue = useCallback(async () => {
    if (!voiceId) return;
    setState({ kind: "queuing" });
    try {
      const r = await fetch(`/api/documents/${docId}/audiobooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_id: voiceId, priority: "high" }),
      });
      if (!r.ok) throw new Error(await r.text());
      await refresh();
    } catch (err) {
      setState({
        kind: "failed",
        message: (err as Error).message || "queue failed",
      });
    }
  }, [docId, voiceId, refresh]);

  // Hide the banner when this provider can already play (the real
  // providers handle their own loading UI) or when there's no text at
  // all (OcrBanner takes that slot).
  if (canPlay) return null;
  if (!hasText) return null;
  if (!selectedVoice) {
    return (
      <Banner tone="amber" icon="info">
        Pick a Voice Lab voice to listen.
      </Banner>
    );
  }

  // Uploaded voices are static audio only — they can't synthesize new
  // text, so the audiobook render queue rejects them server-side (see
  // Voice/backend/tts.py: "Uploaded voices are static audio only").
  // Offering a Queue button here would just produce a server error the
  // user can't act on, so instead we point them at Voice Lab to clone
  // or design a synthesizable voice.
  if (!selectedVoice.hasPromptMel) {
    return (
      <Banner
        tone="amber"
        icon="info"
        action={{
          label: "Open Voice Lab",
          onClick: () => {
            window.location.href = "/voice-lab";
          },
        }}
      >
        {selectedVoice.name} is preview-only — clone or design a voice in
        Voice Lab to listen to documents.
      </Banner>
    );
  }

  if (state.kind === "queuing") {
    return (
      <Banner tone="blue" icon="spinner">
        Queuing {selectedVoice.name}…
      </Banner>
    );
  }

  if (state.kind === "queued" || state.kind === "rendering") {
    const progress =
      state.chunksTotal && state.chunksTotal > 0
        ? `${state.chunksDone}/${state.chunksTotal} chunks`
        : "starting…";
    return (
      <Banner tone="blue" icon="spinner">
        {state.kind === "queued"
          ? `Queued ${state.voiceName}… waiting for Voice Studio`
          : `Rendering ${state.voiceName}… ${progress}`}
      </Banner>
    );
  }

  if (state.kind === "ready") {
    // Brief flash before ReaderClient mounts AudiobookProvider via the
    // onLoadAudiobook callback above. If onLoadAudiobook isn't wired,
    // the user can refresh manually.
    return (
      <Banner tone="blue" icon="spinner">
        {state.voiceName} is ready — loading audiobook…
      </Banner>
    );
  }

  if (state.kind === "failed") {
    return (
      <Banner tone="red" icon="alert" action={{ label: "Try again", onClick: queue }}>
        Render failed: {state.message}
      </Banner>
    );
  }

  // idle — the default call to action.
  return (
    <Banner
      tone="amber"
      icon="info"
      action={{ label: `Listen with ${selectedVoice.name}`, onClick: queue }}
    >
      Queue an audiobook render to listen with {selectedVoice.name}.
    </Banner>
  );
}

type Tone = "amber" | "blue" | "red";
type Icon = "info" | "spinner" | "alert";

function Banner({
  tone,
  icon,
  action,
  children,
}: {
  tone: Tone;
  icon: Icon;
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  const toneClasses: Record<Tone, string> = {
    amber:
      "border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-500/40 text-amber-900 dark:text-amber-200",
    blue: "border-blue-300/60 bg-blue-50 dark:bg-blue-950/40 dark:border-blue-500/40 text-blue-900 dark:text-blue-200",
    red: "border-red-300/60 bg-red-50 dark:bg-red-950/40 dark:border-red-500/40 text-red-900 dark:text-red-200",
  };
  const actionClasses: Record<Tone, string> = {
    amber:
      "border-amber-400/60 bg-amber-100 hover:bg-amber-200 dark:bg-amber-900/50 dark:hover:bg-amber-900 dark:border-amber-500/60",
    blue: "border-blue-400/60 bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/50 dark:hover:bg-blue-900 dark:border-blue-500/60",
    red: "border-red-400/60 bg-red-100 hover:bg-red-200 dark:bg-red-900/50 dark:hover:bg-red-900 dark:border-red-500/60",
  };
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-2 rounded-lg border px-3 py-2 text-[11px] flex items-center gap-2 ${toneClasses[tone]}`}
    >
      <span className="shrink-0" aria-hidden="true">
        {icon === "info" && (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        )}
        {icon === "spinner" && (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="animate-spin"
          >
            <circle cx="12" cy="12" r="9" opacity="0.25" />
            <path d="M12 3 A9 9 0 0 1 21 12" strokeLinecap="round" />
          </svg>
        )}
        {icon === "alert" && (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
        )}
      </span>
      <span className="flex-1">{children}</span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${actionClasses[tone]}`}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
