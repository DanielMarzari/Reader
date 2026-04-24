"use client";

// "No playable voice" stub provider.
//
// Mounted when no Voice Lab voice has a usable playback path — i.e. the
// selected voice has no `prompt_mel` (so BrowserInferenceProvider can't
// run it) AND no pre-rendered audiobook exists for this (doc, voice).
//
// This used to be a Web Speech API fallback that invoked
// `window.speechSynthesis.speak()` — which on desktop hands off to the
// OS's default voice (Microsoft David / Apple Samantha / whatever). That
// silently swapped the user's chosen Voice Lab voice for a system voice
// without telling them. We cut that. No speech comes out of this
// provider at all; `canPlay` is false and the player bar surfaces a
// "queue an audiobook with this voice" prompt instead.
//
// We DO still:
//   - load the voice list from /api/voices
//   - support voice-picker selection
//   - persist voice + position to reading_positions (so the next session
//     resumes on the same voice)
//   - track currentWordIdx for click-to-seek visual feedback
//
// The user's escape hatches, surfaced by the player bar:
//   - queue a pre-rendered audiobook for this voice → AudiobookProvider
//   - select a voice that has hasPromptMel → BrowserInferenceProvider

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

const WORDS_PER_SECOND = 2.5;
const SPEED_CYCLE = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5] as const;

export type Status = "idle" | "loading" | "playing" | "paused";

export type TTSContextValue = {
  tokens: Tokenized;
  status: Status;
  currentWordIdx: number;
  currentSentenceIdx: number;
  rate: number;
  voiceId: string | null;
  selectedVoice: ReaderVoice | null;
  voices: ReaderVoice[];
  voicesLoading: boolean;
  elapsedSec: number;
  totalSec: number;
  progressPct: number;

  /**
   * True when the document has no extractable text (e.g. image-only PDF
   * without OCR). The player-bar uses this to disable the Play button
   * and surface a "No text to read" hint instead of silently no-op'ing.
   */
  hasText: boolean;

  /**
   * True when this provider can actually produce audio. False for the
   * stub provider (no playback path available — user needs to queue an
   * audiobook or pick a hasPromptMel voice). The player bar uses this
   * to disable the Play button and surface a queue-voice prompt.
   */
  canPlay: boolean;

  clickToListen: boolean;

  play: () => void;
  pause: () => void;
  skip: (seconds: number) => void;
  seekTo: (wordIdx: number, play?: boolean) => void;
  seekToCharOffset: (charOffset: number, play?: boolean) => void;
  seekFrac: (frac: number) => void;
  cycleRate: () => void;
  setVoice: (id: string) => void;
  jumpToWord: (wordIdx: number) => void;
};

export const TTSContext = createContext<TTSContextValue | null>(null);

export function useTTS(): TTSContextValue {
  const ctx = useContext(TTSContext);
  if (!ctx) throw new Error("useTTS must be used inside <TTSProvider>");
  return ctx;
}

export function TTSProvider({
  docId,
  content,
  initialCharIndex,
  initialRate,
  initialVoiceName,
  clickToListen,
  // autoSkip kept in the prop signature for API compatibility with the
  // old Web-Speech provider, but intentionally unused — there's nothing
  // to preprocess when nothing is being spoken.
  autoSkip: _autoSkip = defaultAutoSkip,
  // Notify ReaderClient when the user picks a different voice via the
  // picker. ReaderClient owns the cross-provider browserVoiceId state;
  // if the new voice happens to be hasPromptMel + capability is OK,
  // ReaderClient will swap us out for BrowserInferenceProvider.
  onVoiceChange,
  children,
}: {
  docId: string;
  content: string;
  initialCharIndex: number;
  initialRate: number;
  initialVoiceName: string | null;
  clickToListen: boolean;
  autoSkip?: AutoSkipSettings;
  onVoiceChange?: (id: string) => void;
  children: React.ReactNode;
}) {
  const tokens = useMemo<Tokenized>(() => {
    const t = tokenize(content);
    console.log(
      `[TTS stub] Tokenized content: ${t.words.length} words, ${t.sentences.length} sentences`
    );
    if (t.words.length === 0) {
      console.warn(
        "[TTS stub] Document has no extractable text — Play will be disabled. " +
          "This is expected for image-only PDFs without OCR."
      );
    } else {
      console.warn(
        "[TTS stub] No playable voice path for this document. " +
          "User needs to queue an audiobook or pick a voice with prompt_mel. " +
          "Play is disabled."
      );
    }
    return t;
  }, [content]);
  const allWords = tokens.words;
  const hasText = allWords.length > 0;

  // Status is pinned to "idle" — we never transition to "playing" because
  // we never synthesize audio. Kept as a field purely so TTSContextValue
  // stays shape-compatible with the other two providers.
  const status: Status = "idle";
  const [rate, setRate] = useState(initialRate);
  // voiceId is the id of a Voice Lab profile from /api/voices. Stored +
  // persisted so the user's choice survives across sessions, even though
  // this provider can't actually play it. When they queue an audiobook
  // or switch to a hasPromptMel voice, ReaderClient swaps providers and
  // the real playback path uses this same voiceId.
  const [voiceId, setVoiceId] = useState<string | null>(initialVoiceName);
  const [voices, setVoices] = useState<ReaderVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [currentWordIdx, setCurrentWordIdx] = useState<number>(() =>
    wordIndexAt(allWords, initialCharIndex)
  );

  const savedIdxRef = useRef<number>(currentWordIdx);
  const clickToListenRef = useRef(clickToListen);
  useEffect(() => {
    clickToListenRef.current = clickToListen;
  }, [clickToListen]);

  // Load Voice Lab voices from the server. These are the ONLY voices
  // the app exposes — the browser's native SpeechSynthesis voices are
  // never surfaced.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      console.log("[TTS stub] Loading Voice Lab voices from /api/voices…");
      try {
        const res = await fetch("/api/voices");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { voices: ReaderVoice[] };
        if (cancelled) return;
        const list = json.voices ?? [];
        console.log(
          `[TTS stub] Loaded ${list.length} voice(s):`,
          list.map((v) => `${v.name} (hasPromptMel=${v.hasPromptMel})`).join(", ")
        );
        setVoices(list);
        setVoiceId((prev) => {
          if (prev && list.some((v) => v.id === prev || v.name === prev)) {
            const match =
              list.find((v) => v.id === prev) ??
              list.find((v) => v.name === prev);
            return match?.id ?? null;
          }
          return list[0]?.id ?? null;
        });
      } catch (err) {
        console.warn("[TTS stub] Failed to load Voice Lab voices:", err);
      } finally {
        if (!cancelled) setVoicesLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedVoice = useMemo(
    () => voices.find((v) => v.id === voiceId) ?? null,
    [voices, voiceId]
  );

  useEffect(() => {
    savedIdxRef.current = currentWordIdx;
  }, [currentWordIdx]);

  // Persist position + voice + rate periodically. Same cadence as the
  // playable providers so switching between them preserves the user's
  // last spot and selection.
  useEffect(() => {
    const handle = setInterval(() => {
      const w = allWords[savedIdxRef.current];
      if (!w) return;
      void fetch(`/api/documents/${docId}/position`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ charIndex: w.start, rate, voiceName: voiceId }),
      });
    }, 4000);
    return () => clearInterval(handle);
  }, [docId, rate, voiceId, allWords]);

  // Save on unmount (page close / provider swap).
  useEffect(() => {
    return () => {
      if (typeof window === "undefined") return;
      const w = allWords[savedIdxRef.current];
      if (w) {
        navigator.sendBeacon?.(
          `/api/documents/${docId}/position`,
          new Blob(
            [JSON.stringify({ charIndex: w.start, rate, voiceName: voiceId })],
            { type: "application/json" }
          )
        );
      }
    };
  }, [docId, allWords, rate, voiceId]);

  // ---- Play-surface no-ops ----
  //
  // Every "play" path is a no-op. We intentionally don't even show a
  // toast here — the player bar's disabled state + QueueVoiceBanner
  // already tell the user why nothing happens. Logging once per call
  // so the console trail is honest about what's happening.

  const play = useCallback(() => {
    console.log(
      "[TTS stub] play() called but no playable voice path exists — " +
        "queue an audiobook or pick a hasPromptMel voice."
    );
  }, []);

  const pause = useCallback(() => {
    // No-op — we're never "playing" in this provider.
  }, []);

  // Skip/seek still update currentWordIdx so the user gets visual
  // feedback (click-to-seek + forward/back buttons move the cursor),
  // but they never start playback — just like hitting skip on a video
  // that's paused.

  const skip = useCallback(
    (seconds: number) => {
      const step = Math.max(
        1,
        Math.round(Math.abs(seconds) * WORDS_PER_SECOND * rate)
      );
      const next =
        seconds >= 0
          ? Math.min(allWords.length - 1, currentWordIdx + step)
          : Math.max(0, currentWordIdx - step);
      setCurrentWordIdx(next);
    },
    [rate, currentWordIdx, allWords.length]
  );

  const seekTo = useCallback(
    (idx: number, _playAfter?: boolean) => {
      const clamped = Math.max(
        0,
        Math.min(allWords.length - 1, Math.floor(idx))
      );
      setCurrentWordIdx(clamped);
    },
    [allWords.length]
  );

  const seekToCharOffset = useCallback(
    (charOffset: number, _playAfter?: boolean) => {
      const idx = wordIndexAt(allWords, Math.max(0, charOffset));
      setCurrentWordIdx(idx);
    },
    [allWords]
  );

  const seekFrac = useCallback(
    (frac: number) => {
      const target = Math.round(
        Math.max(0, Math.min(1, frac)) * (allWords.length - 1)
      );
      setCurrentWordIdx(target);
    },
    [allWords.length]
  );

  const cycleRate = useCallback(() => {
    const idx = SPEED_CYCLE.findIndex((x) => Math.abs(x - rate) < 0.01);
    const next = SPEED_CYCLE[(idx + 1) % SPEED_CYCLE.length];
    setRate(next);
  }, [rate]);

  const setVoice = useCallback(
    (id: string) => {
      setVoiceId(id);
      // Tell ReaderClient so it can re-evaluate provider selection. If
      // the picked voice has hasPromptMel + capability OK, ReaderClient
      // will unmount us and mount BrowserInferenceProvider instead.
      onVoiceChange?.(id);
    },
    [onVoiceChange]
  );

  const jumpToWord = useCallback((idx: number) => {
    setCurrentWordIdx(idx);
  }, []);

  const currentSentenceIdx = allWords[currentWordIdx]?.sentenceIndex ?? -1;
  const totalWords = allWords.length;
  const progressPct =
    totalWords > 0 ? (currentWordIdx / (totalWords - 1)) * 100 : 0;
  const elapsedSec =
    totalWords > 0 ? currentWordIdx / (WORDS_PER_SECOND * rate) : 0;
  const totalSec = totalWords > 0 ? totalWords / (WORDS_PER_SECOND * rate) : 0;

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
    canPlay: false,
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

  return <TTSContext.Provider value={value}>{children}</TTSContext.Provider>;
}
