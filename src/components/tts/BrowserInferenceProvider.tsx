"use client";

// BrowserInferenceProvider — third implementation of the useTTS() shape,
// alongside the existing TTSProvider (Web Speech API fallback) and
// AudiobookProvider (pre-rendered MP3 chunks).
//
// This one runs ZipVoice-Distill directly in the browser via
// onnxruntime-web + WebGPU. Synthesizes one sentence at a time, plays
// via Web Audio API, pre-fetches the next sentence while the current
// one plays so perceived latency is roughly the first-sentence
// synthesis cost.
//
// Mounts under the same `TTSContext` as the other two providers, so
// <TTSContent/> + <TTSPlayerBar/> work unchanged regardless of which
// provider the page chose.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { tokenize, wordIndexAt, type Tokenized } from "@/lib/tokenize";
import { defaultAutoSkip, type AutoSkipSettings } from "@/lib/autoskip";
import type { ReaderVoice } from "@/types/voice";
import { TTSContext, type TTSContextValue, type Status } from "./TTSContext";
import {
  loadVoiceBundle,
  type VoiceBundle,
} from "@/lib/tts/voice-bundle";
import { synthesizeSentence } from "@/lib/tts/synth";
import { VOCOS_ISTFT_CONFIG } from "@/lib/tts/istft";
import type { DownloadProgress } from "@/lib/tts/browser-inference";

const SPEED_CYCLE = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5] as const;

// When Web Audio doesn't give us word-level timing (ZipVoice doesn't),
// we fall back to a fixed words-per-second estimate to drive highlight
// advancement. Matches TTSProvider's fallback constant.
const WORDS_PER_SECOND = 2.5;

export type BrowserInferenceProviderStatus =
  | { kind: "idle" }
  | { kind: "loading-voice"; progress: Record<string, DownloadProgress> }
  | { kind: "voice-error"; message: string }
  | { kind: "ready" };

export function BrowserInferenceProvider({
  docId,
  content,
  voiceId,
  selectedVoice,
  voices,
  voicesLoading,
  initialCharIndex,
  initialRate,
  clickToListen,
  onVoiceChange,
  children,
}: {
  docId: string;
  content: string;
  voiceId: string;
  selectedVoice: ReaderVoice;
  voices: ReaderVoice[];
  voicesLoading: boolean;
  initialCharIndex: number;
  initialRate: number;
  clickToListen: boolean;
  onVoiceChange: (id: string) => void;
  autoSkip?: AutoSkipSettings;
  children: React.ReactNode;
}) {
  // ---------- Text tokenization ----------
  const tokens = useMemo<Tokenized>(() => tokenize(content), [content]);
  const { words: allWords, sentences: allSentences } = tokens;

  // ---------- Playback state ----------
  const [status, setStatus] = useState<Status>("idle");
  const [rate, setRate] = useState(initialRate);
  const [currentWordIdx, setCurrentWordIdx] = useState<number>(() =>
    wordIndexAt(allWords, initialCharIndex)
  );
  const [elapsedSec, setElapsedSec] = useState(0);

  // ---------- Voice bundle (lazy-loaded on voice select) ----------
  const [bundle, setBundle] = useState<VoiceBundle | null>(null);
  const [providerStatus, setProviderStatus] =
    useState<BrowserInferenceProviderStatus>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    if (!voiceId || !selectedVoice) return;
    if (bundle && bundle.voiceId === voiceId) return;
    const promptText =
      (selectedVoice.design.prompt_text as string | undefined) ?? "";
    setProviderStatus({ kind: "loading-voice", progress: {} });
    setBundle(null);
    loadVoiceBundle({
      voiceId,
      promptText,
      onProgress: (p) => {
        if (cancelled) return;
        setProviderStatus((prev) =>
          prev.kind === "loading-voice"
            ? {
                kind: "loading-voice",
                progress: { ...prev.progress, [p.url]: p },
              }
            : prev
        );
      },
    })
      .then((b) => {
        if (cancelled) return;
        setBundle(b);
        setProviderStatus({ kind: "ready" });
      })
      .catch((e) => {
        if (cancelled) return;
        setProviderStatus({
          kind: "voice-error",
          message: (e as Error).message,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [voiceId, selectedVoice, bundle]);

  // ---------- Audio context + playback queue ----------
  // Strategy: maintain a Map<sentenceIdx, Promise<AudioBuffer>>. On
  // play(), synthesize current sentence, start it playing, and in
  // parallel kick off synthesis of the next one. When current ends,
  // advance + repeat. Skip / seek jumps the cursor.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playbackStartedAtRef = useRef<number>(0);
  const currentSentenceIdxRef = useRef<number>(0);
  const pendingRef = useRef<Map<number, Promise<AudioBuffer>>>(new Map());
  const stopRequestedRef = useRef(false);

  // Compute which sentence the currentWordIdx belongs to — drives
  // highlight at the sentence tier.
  const currentSentenceIdx = useMemo(() => {
    if (currentWordIdx < 0 || !allWords[currentWordIdx]) return 0;
    return allWords[currentWordIdx].sentenceIndex;
  }, [currentWordIdx, allWords]);

  const firstWordOfSentence = useCallback(
    (sentenceIdx: number): number => {
      for (let i = 0; i < allWords.length; i++) {
        if (allWords[i].sentenceIndex === sentenceIdx) return i;
      }
      return 0;
    },
    [allWords]
  );

  const lastWordOfSentence = useCallback(
    (sentenceIdx: number): number => {
      let last = -1;
      for (let i = 0; i < allWords.length; i++) {
        if (allWords[i].sentenceIndex === sentenceIdx) last = i;
        else if (last >= 0) break;
      }
      return last;
    },
    [allWords]
  );

  const sentenceText = useCallback(
    (sentenceIdx: number): string => {
      const s = allSentences[sentenceIdx];
      if (!s) return "";
      return content.slice(s.start, s.end).trim();
    },
    [allSentences, content]
  );

  // ---------- Synthesis ----------

  /** Synthesize a sentence, wrapping it in a memoized promise so
   *  prefetches and play() calls dedupe. Returns the AudioBuffer
   *  decoded into the shared AudioContext. */
  const getSentenceAudio = useCallback(
    (sentenceIdx: number): Promise<AudioBuffer> => {
      const existing = pendingRef.current.get(sentenceIdx);
      if (existing) return existing;

      const promise = (async () => {
        if (!bundle) throw new Error("Voice bundle not loaded");
        const text = sentenceText(sentenceIdx);
        if (!text) throw new Error(`Empty sentence ${sentenceIdx}`);

        const { samples } = await synthesizeSentence(bundle, text);

        if (!audioCtxRef.current) {
          audioCtxRef.current = new AudioContext({
            sampleRate: VOCOS_ISTFT_CONFIG.sampleRate,
          });
        }
        const ctx = audioCtxRef.current;
        const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
        buf.copyToChannel(
          samples as unknown as Float32Array<ArrayBuffer>,
          0
        );
        return buf;
      })();

      // If it fails, drop the cached entry so a retry can regenerate
      // rather than resurrecting the error forever.
      promise.catch(() => pendingRef.current.delete(sentenceIdx));
      pendingRef.current.set(sentenceIdx, promise);
      return promise;
    },
    [bundle, sentenceText]
  );

  /** Start playback of a sentence. Stops any current playback,
   *  schedules the next sentence's synthesis in parallel, advances
   *  the cursor when the buffer finishes. */
  const playSentence = useCallback(
    async (sentenceIdx: number) => {
      if (!bundle) return;
      if (sentenceIdx >= allSentences.length) {
        // End of document.
        setStatus("idle");
        return;
      }
      stopRequestedRef.current = false;
      currentSentenceIdxRef.current = sentenceIdx;
      setCurrentWordIdx(firstWordOfSentence(sentenceIdx));

      let buffer: AudioBuffer;
      try {
        buffer = await getSentenceAudio(sentenceIdx);
      } catch (e) {
        console.error("[BrowserInference] synthesis failed:", e);
        setStatus("idle");
        return;
      }
      if (stopRequestedRef.current) return; // user paused/seeked during synth

      // Pre-fetch the next sentence while this one plays.
      if (sentenceIdx + 1 < allSentences.length) {
        // Fire-and-forget — errors will surface when we actually
        // try to play it.
        void getSentenceAudio(sentenceIdx + 1);
      }

      const ctx = audioCtxRef.current!;
      if (ctx.state === "suspended") await ctx.resume();

      // Stop any existing source. Clears out the sentence we just
      // finished, or the one interrupted by a seek.
      if (currentSourceRef.current) {
        try {
          currentSourceRef.current.onended = null;
          currentSourceRef.current.stop();
        } catch {
          /* already stopped */
        }
      }

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      src.connect(ctx.destination);
      currentSourceRef.current = src;
      playbackStartedAtRef.current = ctx.currentTime;

      src.onended = () => {
        // If user paused (which calls .stop()), onended fires too —
        // suppress via stopRequestedRef so we don't auto-advance.
        if (stopRequestedRef.current) return;
        if (currentSourceRef.current !== src) return; // superseded by a newer sentence
        setCurrentWordIdx(lastWordOfSentence(sentenceIdx));
        void playSentence(sentenceIdx + 1);
      };

      src.start();
      setStatus("playing");
    },
    [
      bundle,
      allSentences.length,
      firstWordOfSentence,
      lastWordOfSentence,
      getSentenceAudio,
      rate,
    ]
  );

  // ---------- Word-highlight tick loop ----------
  //
  // ZipVoice doesn't emit per-word timings. We drive highlight via
  // elapsed time × WORDS_PER_SECOND × rate within the current sentence.
  // Accurate enough for a reader UI; better alignment is a future
  // improvement (attention-weight readout or forced alignment).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const ctx = audioCtxRef.current;
      const src = currentSourceRef.current;
      if (status === "playing" && ctx && src) {
        const elapsed = ctx.currentTime - playbackStartedAtRef.current;
        setElapsedSec(elapsed);
        const sIdx = currentSentenceIdxRef.current;
        const firstW = firstWordOfSentence(sIdx);
        const lastW = lastWordOfSentence(sIdx);
        const wordsInSentence = lastW - firstW + 1;
        if (wordsInSentence > 0) {
          const estWord =
            firstW +
            Math.min(
              wordsInSentence - 1,
              Math.floor(elapsed * WORDS_PER_SECOND * rate)
            );
          setCurrentWordIdx((cur) => (cur !== estWord ? estWord : cur));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [status, firstWordOfSentence, lastWordOfSentence, rate]);

  // ---------- Controls ----------

  const play = useCallback(() => {
    if (!bundle) return;
    if (status === "paused" && currentSourceRef.current) {
      // Web Audio BufferSourceNodes can't be resumed once stopped,
      // so "pause" suspends the AudioContext instead. Resume here.
      audioCtxRef.current?.resume();
      setStatus("playing");
      return;
    }
    void playSentence(currentSentenceIdxRef.current);
  }, [bundle, status, playSentence]);

  const pause = useCallback(() => {
    if (status !== "playing") return;
    // Suspend the AudioContext — keeps our scheduled BufferSourceNode
    // alive so resume() picks up seamlessly. (If we .stop() here,
    // onended would fire and auto-advance us.)
    void audioCtxRef.current?.suspend();
    setStatus("paused");
  }, [status]);

  const seekToWord = useCallback(
    (wordIdx: number, startPlaying = true) => {
      stopRequestedRef.current = true;
      if (currentSourceRef.current) {
        try {
          currentSourceRef.current.onended = null;
          currentSourceRef.current.stop();
        } catch {
          /* already stopped */
        }
        currentSourceRef.current = null;
      }
      const word = allWords[wordIdx];
      if (!word) return;
      const sIdx = word.sentenceIndex;
      currentSentenceIdxRef.current = sIdx;
      setCurrentWordIdx(wordIdx);
      // Clear queued sentences (they may have been synthesized at
      // the wrong position relative to the user's new cursor).
      pendingRef.current.clear();
      setElapsedSec(0);
      if (startPlaying) {
        void playSentence(sIdx);
      } else {
        setStatus("idle");
      }
    },
    [allWords, playSentence]
  );

  const seekToCharOffset = useCallback(
    (charOffset: number, startPlaying = true) => {
      seekToWord(wordIndexAt(allWords, charOffset), startPlaying);
    },
    [allWords, seekToWord]
  );

  const skip = useCallback(
    (seconds: number) => {
      // Jump ±seconds within the document via the WORDS_PER_SECOND
      // estimate. Matches TTSProvider's crude seek.
      const delta = Math.round(seconds * WORDS_PER_SECOND * rate);
      const next = Math.max(
        0,
        Math.min(allWords.length - 1, currentWordIdx + delta)
      );
      seekToWord(next, status === "playing");
    },
    [rate, currentWordIdx, allWords.length, status, seekToWord]
  );

  const seekFrac = useCallback(
    (frac: number) => {
      const wordIdx = Math.max(
        0,
        Math.min(
          allWords.length - 1,
          Math.floor(frac * (allWords.length - 1))
        )
      );
      seekToWord(wordIdx, status === "playing");
    },
    [allWords.length, seekToWord, status]
  );

  const cycleRate = useCallback(() => {
    const idx = SPEED_CYCLE.findIndex((r) => r === rate);
    const next = SPEED_CYCLE[(idx + 1) % SPEED_CYCLE.length];
    setRate(next);
    // Apply to currently-playing source immediately.
    if (currentSourceRef.current) {
      currentSourceRef.current.playbackRate.value = next;
    }
  }, [rate]);

  const jumpToWord = useCallback(
    (wordIdx: number) => {
      seekToWord(wordIdx, true);
    },
    [seekToWord]
  );

  const setVoice = useCallback(
    (id: string) => {
      // Hand off to the parent — they own the `voiceId` state. We
      // don't mutate it directly because TTSContext's shape expects
      // voiceId to be driven by the page (mirrors TTSProvider /
      // AudiobookProvider).
      onVoiceChange(id);
    },
    [onVoiceChange]
  );

  // ---------- Cleanup ----------
  useEffect(() => {
    return () => {
      stopRequestedRef.current = true;
      if (currentSourceRef.current) {
        try {
          currentSourceRef.current.stop();
        } catch {
          /* already stopped */
        }
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  // ---------- Derived values ----------
  const totalSec = useMemo(() => {
    // Rough estimate for progress bar — no real total until
    // everything has synthesized. Use word count / WORDS_PER_SECOND
    // as a placeholder.
    return allWords.length / WORDS_PER_SECOND / rate;
  }, [allWords.length, rate]);

  const progressPct = useMemo(() => {
    if (allWords.length === 0) return 0;
    return Math.min(100, (currentWordIdx / allWords.length) * 100);
  }, [currentWordIdx, allWords.length]);

  const value = useMemo<TTSContextValue>(
    () => ({
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
      clickToListen,
      play,
      pause,
      skip,
      seekTo: seekToWord,
      seekToCharOffset,
      seekFrac,
      cycleRate,
      setVoice,
      jumpToWord,
    }),
    [
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
      clickToListen,
      play,
      pause,
      skip,
      seekToWord,
      seekToCharOffset,
      seekFrac,
      cycleRate,
      setVoice,
      jumpToWord,
    ]
  );

  return (
    <TTSContext.Provider value={value}>
      {providerStatus.kind === "loading-voice" && (
        <LoadProgress progress={providerStatus.progress} />
      )}
      {providerStatus.kind === "voice-error" && (
        <VoiceLoadError message={providerStatus.message} voiceId={voiceId} />
      )}
      {children}
    </TTSContext.Provider>
  );
}

// ---------- Inline loading / error UI ----------

function LoadProgress({
  progress,
}: {
  progress: Record<string, DownloadProgress>;
}) {
  const items = Object.values(progress);
  const total = items.reduce((s, p) => s + (p.bytesTotal ?? 0), 0);
  const received = items.reduce((s, p) => s + p.bytesReceived, 0);
  const pct = total > 0 ? Math.floor((received / total) * 100) : null;
  return (
    <div className="fixed bottom-4 right-4 z-50 rounded-xl border border-slate-700 bg-slate-900/90 backdrop-blur px-4 py-3 text-xs text-slate-100 shadow-lg max-w-sm">
      <div className="font-semibold mb-1">Preparing voice…</div>
      <div className="text-slate-400">
        {(received / 1024 / 1024).toFixed(1)} MB
        {total > 0 && ` / ${(total / 1024 / 1024).toFixed(1)} MB`}
        {pct != null && ` · ${pct}%`}
      </div>
      <div className="mt-2 text-[10px] text-slate-500">
        One-time download of the ZipVoice model bundle. Cached for next
        visit.
      </div>
    </div>
  );
}

function VoiceLoadError({
  message,
  voiceId,
}: {
  message: string;
  voiceId: string;
}) {
  return (
    <div className="fixed bottom-4 right-4 z-50 rounded-xl border border-red-500/50 bg-red-900/70 backdrop-blur px-4 py-3 text-xs text-red-50 shadow-lg max-w-sm">
      <div className="font-semibold mb-1">Voice unavailable: {voiceId}</div>
      <div className="text-red-200">{message}</div>
    </div>
  );
}
