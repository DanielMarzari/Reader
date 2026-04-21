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

// ---------- Module-level sentence sample cache ----------
//
// Keyed on `${voiceId}|${docId}|${sentenceIdx}|${textHash}` so navigating
// document → back → document doesn't re-synth. We cache raw Float32
// samples (AudioContext-independent) and rebuild an AudioBuffer per
// playback — AudioBuffers are tied to a specific AudioContext that
// gets destroyed on unmount, so reusing the BUFFER across provider
// instances fails. Samples Just Work.
//
// ~3s of audio = 72 KB (24 kHz × 3 × 4 bytes). Cap at 200 sentences
// ≈ 14 MB for a long doc. Trivially fits in memory.

type SentenceSamples = Float32Array;

const _sentenceCache = new Map<string, SentenceSamples>();
const SENTENCE_CACHE_MAX = 200;

function cacheKey(
  voiceId: string,
  docId: string,
  sentenceIdx: number,
  text: string
): string {
  // FNV-1a of the text guards against stale entries if the doc
  // content mutates under a fixed id. Collisions are harmless — we
  // just re-synth.
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${voiceId}|${docId}|${sentenceIdx}|${(h >>> 0).toString(36)}`;
}

function cacheGet(key: string): SentenceSamples | null {
  return _sentenceCache.get(key) ?? null;
}

function cachePut(key: string, samples: SentenceSamples) {
  if (_sentenceCache.size >= SENTENCE_CACHE_MAX) {
    const oldest = _sentenceCache.keys().next().value;
    if (oldest) _sentenceCache.delete(oldest);
  }
  _sentenceCache.set(key, samples);
}

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
  // Strategy: sentence samples cached at module scope (persists across
  // navigations). Per-call prefetch cache holds in-flight synthesis
  // promises so multiple getSentenceSamples calls for the same sentence
  // dedupe to one WebGPU run.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playbackStartedAtRef = useRef<number>(0);
  const currentSentenceIdxRef = useRef<number>(0);
  const pendingRef = useRef<Map<number, Promise<Float32Array>>>(new Map());
  const stopRequestedRef = useRef(false);
  /** True while an AudioBufferSourceNode is actively emitting audio.
   *  Separate from `status` because we want the highlight tick to
   *  advance only during actual playback, not during the synth gaps
   *  before sentence N+1's audio starts. */
  const isPlayingAudioRef = useRef(false);
  /** Sentence currently being synthesized for the first time (shown in
   *  the UI so the user knows why there's a delay). null = not synthing. */
  const [synthesizingSentenceIdx, setSynthesizingSentenceIdx] = useState<
    number | null
  >(null);

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

  /** Synthesize a sentence → Float32 samples. Uses the module-level
   *  cache for cross-session reuse; in-flight synth calls dedupe via
   *  pendingRef so a prefetch + a play() of the same sentence only
   *  kick off one WebGPU run. */
  const getSentenceSamples = useCallback(
    (sentenceIdx: number): Promise<Float32Array> => {
      const existing = pendingRef.current.get(sentenceIdx);
      if (existing) return existing;

      const promise = (async () => {
        if (!bundle) throw new Error("Voice bundle not loaded");
        const text = sentenceText(sentenceIdx);
        if (!text) throw new Error(`Empty sentence ${sentenceIdx}`);

        const key = cacheKey(bundle.voiceId, docId, sentenceIdx, text);
        const cached = cacheGet(key);
        if (cached) return cached;

        // Mark as synthesizing for the UI — only if nobody else beat
        // us to it (race with prefetch).
        setSynthesizingSentenceIdx((cur) => (cur == null ? sentenceIdx : cur));
        try {
          const { samples } = await synthesizeSentence(bundle, text);
          cachePut(key, samples);
          return samples;
        } finally {
          setSynthesizingSentenceIdx((cur) =>
            cur === sentenceIdx ? null : cur
          );
        }
      })();

      promise.catch(() => pendingRef.current.delete(sentenceIdx));
      pendingRef.current.set(sentenceIdx, promise);
      return promise;
    },
    [bundle, docId, sentenceText]
  );

  /** Turn Float32 samples into an AudioBuffer on the shared context. */
  const buildBuffer = useCallback((samples: Float32Array): AudioBuffer => {
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
  }, []);

  /** Start playback of a sentence. Kicks off prefetch of sentence N+1
   *  BEFORE awaiting current synth so two synthesis calls (current +
   *  next) run as concurrently as the underlying runtime allows. */
  const playSentence = useCallback(
    async (sentenceIdx: number) => {
      if (!bundle) return;
      if (sentenceIdx >= allSentences.length) {
        isPlayingAudioRef.current = false;
        setStatus("idle");
        return;
      }
      stopRequestedRef.current = false;
      currentSentenceIdxRef.current = sentenceIdx;
      setCurrentWordIdx(firstWordOfSentence(sentenceIdx));

      // Prefetch next sentence IMMEDIATELY — starts its synth in
      // parallel with the current one's. ORT-Web serializes on the
      // GPU kernel queue so we don't get full parallelism, but
      // kicking off early means the next sentence's synth begins
      // now instead of after this one's audio starts playing.
      if (sentenceIdx + 1 < allSentences.length) {
        void getSentenceSamples(sentenceIdx + 1);
      }

      let samples: Float32Array;
      try {
        samples = await getSentenceSamples(sentenceIdx);
      } catch (e) {
        console.error("[BrowserInference] synthesis failed:", e);
        isPlayingAudioRef.current = false;
        setStatus("idle");
        return;
      }
      if (stopRequestedRef.current) return; // user paused/seeked during synth

      const ctx = audioCtxRef.current ??
        (audioCtxRef.current = new AudioContext({
          sampleRate: VOCOS_ISTFT_CONFIG.sampleRate,
        }));
      if (ctx.state === "suspended") await ctx.resume();

      // Stop any existing source.
      if (currentSourceRef.current) {
        try {
          currentSourceRef.current.onended = null;
          currentSourceRef.current.stop();
        } catch {
          /* already stopped */
        }
      }

      const buffer = buildBuffer(samples);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      src.connect(ctx.destination);
      currentSourceRef.current = src;
      playbackStartedAtRef.current = ctx.currentTime;
      isPlayingAudioRef.current = true;

      src.onended = () => {
        if (stopRequestedRef.current) return;
        if (currentSourceRef.current !== src) return;
        isPlayingAudioRef.current = false;
        setCurrentWordIdx(firstWordOfSentence(sentenceIdx + 1));
        void playSentence(sentenceIdx + 1);
      };

      src.start();
      setStatus("playing");
    },
    [
      bundle,
      allSentences.length,
      firstWordOfSentence,
      getSentenceSamples,
      buildBuffer,
      rate,
    ]
  );

  // ---------- Word-highlight tick loop ----------
  //
  // ZipVoice doesn't emit per-word timings. We drive highlight via
  // elapsed time × WORDS_PER_SECOND × rate within the current sentence.
  // Gated on isPlayingAudioRef (not just `status`) so the highlight
  // stays pinned at the sentence-start word during synth gaps instead
  // of racing to the end based on a stale playbackStartedAt.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const ctx = audioCtxRef.current;
      if (
        isPlayingAudioRef.current &&
        status === "playing" &&
        ctx &&
        ctx.state === "running"
      ) {
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
      isPlayingAudioRef.current = true;
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
    isPlayingAudioRef.current = false;
    void audioCtxRef.current?.suspend();
    setStatus("paused");
  }, [status]);

  const seekToWord = useCallback(
    (wordIdx: number, startPlaying = true) => {
      stopRequestedRef.current = true;
      isPlayingAudioRef.current = false;
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
      // Clear in-flight pending synth promises (stale positions).
      // The MODULE cache of completed samples is preserved — if we
      // seek to a sentence we already synth'd, it plays instantly.
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
      {synthesizingSentenceIdx != null &&
        status === "playing" &&
        synthesizingSentenceIdx !== currentSentenceIdxRef.current && (
          <SynthesizingChip
            sentenceIdx={synthesizingSentenceIdx}
            totalSentences={allSentences.length}
            reason="prefetch"
          />
        )}
      {synthesizingSentenceIdx != null &&
        !isPlayingAudioRef.current &&
        synthesizingSentenceIdx === currentSentenceIdxRef.current && (
          <SynthesizingChip
            sentenceIdx={synthesizingSentenceIdx}
            totalSentences={allSentences.length}
            reason="current"
          />
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

function SynthesizingChip({
  sentenceIdx,
  totalSentences,
  reason,
}: {
  sentenceIdx: number;
  totalSentences: number;
  reason: "current" | "prefetch";
}) {
  const label =
    reason === "prefetch"
      ? `Prefetching sentence ${sentenceIdx + 1}/${totalSentences}…`
      : `Synthesizing sentence ${sentenceIdx + 1}/${totalSentences}…`;
  return (
    <div className="fixed bottom-20 right-4 z-40 rounded-full border border-slate-700 bg-slate-900/90 backdrop-blur px-3 py-1.5 text-[11px] text-slate-200 shadow">
      <span className="inline-block w-2 h-2 rounded-full bg-indigo-400 animate-pulse mr-2 align-middle" />
      {label}
    </div>
  );
}
