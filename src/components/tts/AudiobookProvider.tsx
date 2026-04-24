"use client";

// AudiobookProvider — alternative to TTSProvider that sources playback
// from a pre-rendered audiobook (manifest.json + chunk_NNNN.mp3 files
// under /api/audiobooks/:doc/:voice/).
//
// Why a second provider instead of adding "audiobook mode" to the main
// TTSProvider? Because the two playback backends have very different
// internals (Web Speech onboundary vs. HTMLMediaElement currentTime)
// and mixing them balloons the branch logic. Both satisfy the same
// `useTTS()` context shape, so <TTSContent/> and <TTSPlayerBar/> work
// unchanged regardless of which provider is mounted above them.
//
// Chunk playback strategy:
//   - Single <audio> element + MediaSource + one SourceBuffer (audio/mpeg,
//     mode: "sequence"). Append chunk bytes as they arrive for gapless
//     playback.
//   - Per-frame position → word mapping uses the manifest's chunk char
//     offsets + chunk duration for linear estimation inside each chunk.
//     Good enough for highlight.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { tokenize, wordIndexAt, type Tokenized } from "@/lib/tokenize";
import { defaultAutoSkip, type AutoSkipSettings } from "@/lib/autoskip";
import type { ReaderVoice } from "@/types/voice";
import { TTSContext as BaseContext, type TTSContextValue } from "./TTSContext";

// Re-export the same hook so callers import from one place.
export function useTTS(): TTSContextValue {
  const ctx = useContext(BaseContext);
  if (!ctx) throw new Error("useTTS must be used inside a TTS/AudiobookProvider");
  return ctx;
}

const SPEED_CYCLE = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5] as const;

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

export function AudiobookProvider({
  docId,
  voiceId,
  manifest,
  content,
  initialCharIndex,
  initialRate,
  clickToListen,
  // autoSkip is accepted for interface parity but not applied here — the
  // audio was synthesized with the text as-is. The redaction toggle only
  // makes sense for live synth.
  autoSkip: _autoSkip = defaultAutoSkip,
  children,
}: {
  docId: string;
  voiceId: string;
  manifest: AudiobookManifest;
  content: string;
  initialCharIndex: number;
  initialRate: number;
  clickToListen: boolean;
  autoSkip?: AutoSkipSettings;
  children: React.ReactNode;
}) {
  const tokens = useMemo<Tokenized>(() => {
    const t = tokenize(content);
    console.log(
      `[Audiobook] Tokenized content: ${t.words.length} words, ${t.sentences.length} sentences`
    );
    return t;
  }, [content]);
  const allWords = tokens.words;
  const hasText = allWords.length > 0;

  const [status, setStatus] = useState<"idle" | "playing" | "paused">("idle");
  const [rate, setRate] = useState(initialRate);
  const [currentWordIdx, setCurrentWordIdx] = useState<number>(() =>
    wordIndexAt(allWords, initialCharIndex)
  );
  const [voices, setVoices] = useState<ReaderVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(true);

  // Pre-compute cumulative start time per chunk for fast time→chunk lookup.
  const chunkStarts = useMemo(() => {
    const arr: number[] = [];
    let acc = 0;
    for (const c of manifest.chunks) {
      arr.push(acc);
      acc += c.durationMs;
    }
    return arr;
  }, [manifest]);

  const totalDurationMs = manifest.totalDurationMs;

  // ---- Voice list (for the player bar dropdown) ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/voices");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { voices: ReaderVoice[] };
        if (!cancelled) setVoices(json.voices ?? []);
      } catch (err) {
        console.warn("Voice list load failed:", err);
      } finally {
        if (!cancelled) setVoicesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedVoice = useMemo(
    () => voices.find((v) => v.id === voiceId) ?? null,
    [voices, voiceId]
  );

  // ---- Audio element + MediaSource lifecycle ----

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mseRef = useRef<MediaSource | null>(null);
  const srcBufferRef = useRef<SourceBuffer | null>(null);
  const appendQueueRef = useRef<ArrayBuffer[]>([]);
  const nextFetchRef = useRef<number>(1); // 1-based chunk index to fetch next
  const fetchingRef = useRef<boolean>(false);
  const endedRef = useRef<boolean>(false);

  // Save position ref for highlight + persist.
  const savedIdxRef = useRef<number>(currentWordIdx);
  useEffect(() => {
    savedIdxRef.current = currentWordIdx;
  }, [currentWordIdx]);

  // Periodic persist (same shape as TTSProvider's).
  useEffect(() => {
    const h = setInterval(() => {
      const w = allWords[savedIdxRef.current];
      if (!w) return;
      void fetch(`/api/documents/${docId}/position`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ charIndex: w.start, rate, voiceName: voiceId }),
      });
    }, 4000);
    return () => clearInterval(h);
  }, [docId, rate, voiceId, allWords]);

  // Create/dispose the audio element + MediaSource.
  const initAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current;
    if (typeof window === "undefined") return null;
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audio.playbackRate = rate;
    audioRef.current = audio;

    const canMse =
      typeof window.MediaSource !== "undefined" &&
      window.MediaSource.isTypeSupported("audio/mpeg");

    if (canMse) {
      const ms = new MediaSource();
      mseRef.current = ms;
      audio.src = URL.createObjectURL(ms);
      ms.addEventListener("sourceopen", () => {
        try {
          const sb = ms.addSourceBuffer("audio/mpeg");
          sb.mode = "sequence";
          srcBufferRef.current = sb;
          sb.addEventListener("updateend", drainAppendQueue);
          drainAppendQueue();
        } catch (err) {
          console.warn("MSE sourceBuffer failed:", err);
        }
      });
    } else {
      // Fallback path — TODO: swap blob URLs between chunks on `ended`.
      // For now we just fetch the whole audiobook as a single blob if MSE
      // isn't available. Rare on modern browsers.
      audio.src = `/api/audiobooks/${docId}/${voiceId}/chunks/1`;
    }

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("pause", () => {
      if (audio.ended) return;
      if (status === "playing") setStatus("paused");
    });
    audio.addEventListener("play", () => setStatus("playing"));
    return audio;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.removeAttribute("src");
        a.load();
      }
      try {
        const ms = mseRef.current;
        if (ms && ms.readyState === "open") ms.endOfStream();
      } catch {
        /* noop */
      }
      mseRef.current = null;
      srcBufferRef.current = null;
      audioRef.current = null;
    };
  }, []);

  // Append queued buffers when the SourceBuffer is idle.
  function drainAppendQueue() {
    const sb = srcBufferRef.current;
    if (!sb || sb.updating) return;
    const next = appendQueueRef.current.shift();
    if (!next) {
      // No more buffered; if we've fetched everything, signal end-of-stream.
      if (
        !fetchingRef.current &&
        nextFetchRef.current > manifest.chunks.length
      ) {
        try {
          const ms = mseRef.current;
          if (ms && ms.readyState === "open") ms.endOfStream();
        } catch {
          /* noop */
        }
      }
      return;
    }
    try {
      sb.appendBuffer(next);
    } catch (err) {
      console.warn("appendBuffer failed:", err);
    }
  }

  // Fetch next chunk sequentially, append to the SourceBuffer.
  async function fetchNextChunk() {
    if (fetchingRef.current || endedRef.current) return;
    const idx = nextFetchRef.current;
    if (idx > manifest.chunks.length) return;
    fetchingRef.current = true;
    try {
      const resp = await fetch(
        `/api/audiobooks/${docId}/${voiceId}/chunks/${idx}`
      );
      if (!resp.ok) throw new Error(`chunk ${idx} ${resp.status}`);
      const buf = await resp.arrayBuffer();
      appendQueueRef.current.push(buf);
      drainAppendQueue();
      nextFetchRef.current = idx + 1;
      // Opportunistically prefetch 1 more so we always have the next chunk
      // queued when the current one finishes.
      if (nextFetchRef.current <= manifest.chunks.length) {
        void fetchNextChunk();
      }
    } catch (err) {
      console.warn("chunk fetch failed:", err);
    } finally {
      fetchingRef.current = false;
    }
  }

  // --- Time → word mapping ---

  const handleTimeUpdate = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const ms = a.currentTime * 1000;

    // Binary search for the current chunk.
    let lo = 0;
    let hi = manifest.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (chunkStarts[mid] <= ms) lo = mid;
      else hi = mid - 1;
    }
    const chunk = manifest.chunks[lo];
    if (!chunk) return;
    const chunkStart = chunkStarts[lo];
    const inChunk = Math.max(0, ms - chunkStart);
    const progress =
      chunk.durationMs > 0
        ? Math.min(1, inChunk / chunk.durationMs)
        : 0;

    // Linear char interpolation within the chunk → word lookup via the
    // shared tokenizer. (If the manifest ships wordOffsetsMs, we can use
    // exact indices; linear is the default.)
    const charEst = Math.round(
      chunk.charStart + (chunk.charEnd - chunk.charStart) * progress
    );
    const wi = wordIndexAt(allWords, charEst);
    setCurrentWordIdx((prev) => (prev === wi ? prev : wi));
  }, [manifest, chunkStarts, allWords]);

  const handleEnded = useCallback(() => {
    endedRef.current = true;
    setStatus("idle");
    setCurrentWordIdx(allWords.length - 1);
  }, [allWords.length]);

  // ---- Controls ----

  const play = useCallback(() => {
    const a = initAudio();
    if (!a) return;
    // Kick off chunk fetching if we haven't started.
    if (nextFetchRef.current === 1) void fetchNextChunk();
    void a.play().catch((err) => console.warn("audio.play() failed:", err));
    setStatus("playing");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initAudio]);

  const pause = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.pause();
    setStatus("paused");
  }, []);

  const seekToMs = useCallback((ms: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(a.duration || totalDurationMs / 1000, ms / 1000));
  }, [totalDurationMs]);

  const wordsToMs = useCallback(
    (targetWordIdx: number): number => {
      // Find which chunk contains the char offset for this word, then
      // linear-interpolate within the chunk.
      const w = allWords[targetWordIdx];
      if (!w) return 0;
      const charOffset = w.start;
      // Linear scan — chunks list is small (tens to a few hundred).
      for (let i = 0; i < manifest.chunks.length; i++) {
        const c = manifest.chunks[i];
        if (charOffset < c.charEnd) {
          const within = Math.max(0, charOffset - c.charStart);
          const span = Math.max(1, c.charEnd - c.charStart);
          const progress = Math.min(1, within / span);
          return chunkStarts[i] + progress * c.durationMs;
        }
      }
      return totalDurationMs;
    },
    [allWords, manifest, chunkStarts, totalDurationMs]
  );

  const skip = useCallback(
    (seconds: number) => {
      const a = audioRef.current;
      if (!a) return;
      seekToMs((a.currentTime + seconds) * 1000);
    },
    [seekToMs]
  );

  const seekTo = useCallback(
    (idx: number, playAfter?: boolean) => {
      const clamped = Math.max(0, Math.min(allWords.length - 1, Math.floor(idx)));
      seekToMs(wordsToMs(clamped));
      setCurrentWordIdx(clamped);
      if (playAfter) play();
    },
    [allWords.length, seekToMs, wordsToMs, play]
  );

  const seekToCharOffset = useCallback(
    (charOffset: number, playAfter?: boolean) => {
      const idx = wordIndexAt(allWords, Math.max(0, charOffset));
      seekTo(idx, playAfter);
    },
    [allWords, seekTo]
  );

  const seekFrac = useCallback(
    (frac: number) => {
      seekToMs(Math.max(0, Math.min(1, frac)) * totalDurationMs);
    },
    [seekToMs, totalDurationMs]
  );

  const cycleRate = useCallback(() => {
    const idx = SPEED_CYCLE.findIndex((x) => Math.abs(x - rate) < 0.01);
    const next = SPEED_CYCLE[(idx + 1) % SPEED_CYCLE.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }, [rate]);

  const jumpToWord = useCallback(
    (idx: number) => {
      if (status === "playing") {
        seekTo(idx, true);
      } else {
        setCurrentWordIdx(idx);
      }
    },
    [status, seekTo]
  );

  // Noop setters for interface parity — voice is fixed per audiobook.
  const setVoice = useCallback((_id: string) => {
    /* audiobook voice is baked into the manifest */
  }, []);

  const currentSentenceIdx = allWords[currentWordIdx]?.sentenceIndex ?? -1;
  const totalWords = allWords.length;
  const progressPct =
    totalDurationMs > 0 && audioRef.current
      ? (audioRef.current.currentTime * 1000 / totalDurationMs) * 100
      : totalWords > 0
      ? (currentWordIdx / (totalWords - 1)) * 100
      : 0;
  const elapsedSec = audioRef.current?.currentTime ?? 0;
  const totalSec = totalDurationMs / 1000;

  const value: TTSContextValue = {
    tokens,
    status,
    currentWordIdx,
    currentSentenceIdx,
    rate,
    voiceId,
    selectedVoice,
    voices,
    voicesLoading,
    elapsedSec,
    totalSec,
    progressPct,
    hasText,
    canPlay: true,
    clickToListen,
    play,
    pause,
    skip,
    seekTo,
    seekToCharOffset,
    seekFrac,
    cycleRate,
    setVoice,
    jumpToWord,
  };

  return <BaseContext.Provider value={value}>{children}</BaseContext.Provider>;
}
