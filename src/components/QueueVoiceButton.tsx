"use client";

// QueueVoiceButton — one pill in the reader page's top nav that owns the
// "render this doc with voice X so I can listen later" flow.
//
// States shown:
//   1. No audiobooks + no pending/rendering jobs → "Listen with…" dropdown
//      lists every Voice Lab voice; clicking one POSTs /api/render-jobs.
//   2. A job is pending/rendering for the doc → progress chip
//      "Rendering Alex… 7/32" + a cancel (×) button. Polls /api/render-jobs/:id
//      every 3 s until it finishes.
//   3. One or more audiobooks are ready → "Listen: Alex ▾" dropdown with
//      each ready voice; clicking switches the active audiobook.
//
// The audiobook playback itself happens in ReaderClient (which swaps
// <TTSProvider/> for <AudiobookProvider/> when a voice is selected).

import { useCallback, useEffect, useState } from "react";
import type { ReaderVoice } from "@/types/voice";

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

type Props = {
  documentId: string;
  /** Voice currently powering playback (if an audiobook is active). */
  selectedVoiceId: string | null;
  /** Called when the user picks a ready audiobook to listen to. */
  onSelectAudiobook: (voiceId: string) => void;
};

export function QueueVoiceButton({
  documentId,
  selectedVoiceId,
  onSelectAudiobook,
}: Props) {
  const [entries, setEntries] = useState<AudiobookEntry[]>([]);
  const [voices, setVoices] = useState<ReaderVoice[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/documents/${documentId}/audiobooks`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as {
        ready: AudiobookEntry[];
        inflight: AudiobookEntry[];
      };
      setEntries([...(json.ready ?? []), ...(json.inflight ?? [])]);
    } catch (e) {
      console.warn("audiobooks list:", e);
    }
  }, [documentId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while anything is in flight (pending or rendering).
  useEffect(() => {
    const inflight = entries.some(
      (e) => e.status === "pending" || e.status === "rendering"
    );
    if (!inflight) return;
    const h = setInterval(refresh, 3000);
    return () => clearInterval(h);
  }, [entries, refresh]);

  // Fetch voice list for the "Listen with…" dropdown (lazy on menu open).
  useEffect(() => {
    if (!menuOpen || voices.length > 0) return;
    (async () => {
      try {
        const r = await fetch("/api/voices");
        const j = (await r.json()) as { voices: ReaderVoice[] };
        setVoices(j.voices ?? []);
      } catch (err) {
        console.warn("voices load:", err);
      }
    })();
  }, [menuOpen, voices.length]);

  async function queue(voiceId: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/documents/${documentId}/audiobooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_id: voiceId, priority: "high" }),
      });
      if (!r.ok) throw new Error(await r.text());
      setMenuOpen(false);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(jobId: string) {
    if (!confirm("Cancel this render? Any completed chunks are discarded.")) return;
    setBusy(true);
    try {
      await fetch(`/api/render-jobs/${jobId}`, { method: "DELETE" });
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const ready = entries.filter((e): e is Extract<AudiobookEntry, { status: "ready" }> =>
    e.status === "ready"
  );
  const inflight = entries.filter(
    (e) => e.status === "pending" || e.status === "rendering"
  );

  // --- Rendering mode: progress chip + cancel ---
  if (inflight.length > 0) {
    const job = inflight[0] as Extract<
      AudiobookEntry,
      { status: "pending" | "rendering" | "failed" }
    >;
    const pct =
      job.chunksTotal && job.chunksTotal > 0
        ? Math.round((job.chunksDone / job.chunksTotal) * 100)
        : null;
    return (
      <div className="flex items-center gap-2">
        <span className="chip" title={`Rendering with ${job.voiceName}`}>
          {job.status === "pending"
            ? `Queued · ${job.voiceName}`
            : `Rendering · ${job.voiceName}${
                pct != null ? ` · ${job.chunksDone}/${job.chunksTotal}` : "…"
              }`}
        </span>
        <button
          className="btn-ghost text-xs"
          onClick={() => cancel(job.jobId)}
          title="Cancel render"
          disabled={busy}
          aria-label="Cancel render"
        >
          ✕
        </button>
      </div>
    );
  }

  // --- Ready mode: Listen with dropdown ---
  if (ready.length > 0) {
    const active = selectedVoiceId
      ? ready.find((r) => r.voiceId === selectedVoiceId)
      : undefined;
    const label = active ? active.voiceName : ready[0].voiceName;
    return (
      <div className="relative">
        <button
          className="btn"
          onClick={() => setMenuOpen((x) => !x)}
          title="Switch audiobook voice"
        >
          ▶ Listen · {label} ▾
        </button>
        {menuOpen && (
          <div className="absolute top-10 right-0 bg-[color:var(--surface)] border border-[color:var(--border)] rounded-lg shadow-lg z-20 min-w-[240px]">
            <div className="px-3 py-2 border-b border-[color:var(--border)] text-xs uppercase tracking-wider text-[color:var(--muted)]">
              Ready audiobooks
            </div>
            {ready.map((r) => (
              <button
                key={r.voiceId}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-[color:var(--surface-2)] ${
                  r.voiceId === selectedVoiceId ? "font-semibold" : ""
                }`}
                onClick={() => {
                  onSelectAudiobook(r.voiceId);
                  setMenuOpen(false);
                }}
              >
                {r.voiceName}
                <span className="ml-2 text-xs text-[color:var(--muted)]">
                  {fmtMs(r.totalDurationMs)}
                </span>
              </button>
            ))}
            <div className="border-t border-[color:var(--border)] px-3 py-2 text-xs text-[color:var(--muted)]">
              Want another voice? Use the menu below.
            </div>
            <QueueFooter
              voices={voices}
              alreadyQueued={new Set(ready.map((r) => r.voiceId))}
              busy={busy}
              onQueue={queue}
            />
          </div>
        )}
        {error && (
          <span className="text-xs text-red-500 ml-2">{error}</span>
        )}
      </div>
    );
  }

  // --- No audiobook yet: Listen-with dropdown to queue one ---
  return (
    <div className="relative">
      <button
        className="btn"
        onClick={() => setMenuOpen((x) => !x)}
        title="Queue an audiobook render on Voice Studio"
      >
        ▶ Listen with… ▾
      </button>
      {menuOpen && (
        <div className="absolute top-10 right-0 bg-[color:var(--surface)] border border-[color:var(--border)] rounded-lg shadow-lg z-20 min-w-[260px]">
          <QueueFooter
            voices={voices}
            alreadyQueued={new Set()}
            busy={busy}
            onQueue={queue}
          />
          <div className="px-3 py-2 text-xs text-[color:var(--muted)] border-t border-[color:var(--border)]">
            Voice Studio renders on your Mac in the background and ships
            the audio here. Close this tab and come back when it&apos;s done.
          </div>
        </div>
      )}
      {error && <div className="text-xs text-red-500 mt-1">{error}</div>}
    </div>
  );
}

function QueueFooter({
  voices,
  alreadyQueued,
  busy,
  onQueue,
}: {
  voices: ReaderVoice[];
  alreadyQueued: Set<string>;
  busy: boolean;
  onQueue: (voiceId: string) => void;
}) {
  if (voices.length === 0) {
    return (
      <div className="px-3 py-3 text-sm text-[color:var(--muted)]">
        No voices yet — create one in{" "}
        <a href="/voice-lab" className="underline">Voice Lab</a>.
      </div>
    );
  }
  return (
    <div className="max-h-64 overflow-y-auto">
      {voices.map((v) => {
        const disabled = alreadyQueued.has(v.id) || busy;
        return (
          <button
            key={v.id}
            onClick={() => onQueue(v.id)}
            disabled={disabled}
            className={`w-full text-left px-3 py-2 text-sm hover:bg-[color:var(--surface-2)] disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {v.name}
            {alreadyQueued.has(v.id) && (
              <span className="ml-2 text-xs text-[color:var(--muted)]">(already ready)</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}
