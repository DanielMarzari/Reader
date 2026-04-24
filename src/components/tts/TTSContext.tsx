"use client";

// Browser-engine TTS context.
//
// This is the fallback/baseline playback path — Web Speech API with the
// browser's built-in voice. It's used when the user is reading a document
// that has no pre-rendered audiobook yet (or one is still rendering).
// When a ready audiobook exists for (doc, voice) pair, the reader page
// mounts <AudiobookPlayer/> instead and this provider isn't used.
//
// No live streaming, no localhost calls, no external APIs — the browser
// engine is our universal floor.

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
import {
  defaultAutoSkip,
  preprocessForSpeech,
  type AutoSkipSettings,
} from "@/lib/autoskip";
import type { ReaderVoice } from "@/types/voice";

const WORDS_PER_SECOND = 2.5;
const SPEED_CYCLE = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5] as const;

export type Status = "idle" | "playing" | "paused";

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
  autoSkip = defaultAutoSkip,
  children,
}: {
  docId: string;
  content: string;
  initialCharIndex: number;
  initialRate: number;
  initialVoiceName: string | null;
  clickToListen: boolean;
  autoSkip?: AutoSkipSettings;
  children: React.ReactNode;
}) {
  const tokens = useMemo<Tokenized>(() => tokenize(content), [content]);
  const allWords = tokens.words;

  const [status, setStatus] = useState<Status>("idle");
  const [rate, setRate] = useState(initialRate);
  // voiceId is the id of a Voice Lab profile (/api/voices). It's stored and
  // shown in the avatar for UI consistency, but doesn't actually affect the
  // browser engine's timbre — the OS picks whatever Web Speech voice is
  // default. Pre-rendered audiobooks are where cloned voices actually play.
  const [voiceId, setVoiceId] = useState<string | null>(initialVoiceName);
  const [voices, setVoices] = useState<ReaderVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [currentWordIdx, setCurrentWordIdx] = useState<number>(() =>
    wordIndexAt(allWords, initialCharIndex)
  );

  const utteranceBaseRef = useRef<number>(0);
  const manualStopRef = useRef(false);
  const savedIdxRef = useRef<number>(currentWordIdx);
  const clickToListenRef = useRef(clickToListen);
  const autoSkipRef = useRef<AutoSkipSettings>(autoSkip);
  useEffect(() => {
    clickToListenRef.current = clickToListen;
  }, [clickToListen]);
  useEffect(() => {
    autoSkipRef.current = autoSkip;
  }, [autoSkip]);

  // Load Voice Lab voices from the server. Browser SpeechSynthesis voices
  // aren't surfaced — the app only exposes voices imported/cloned from
  // Voice Studio. The selected voice is just a UI hint here; rendered
  // audiobooks use it for actual synthesis.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/voices");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { voices: ReaderVoice[] };
        if (cancelled) return;
        const list = json.voices ?? [];
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
        console.warn("Failed to load Voice Lab voices:", err);
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

  // Periodic persist while playing.
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

  // Save on unmount.
  useEffect(() => {
    return () => {
      if (typeof window === "undefined") return;
      window.speechSynthesis.cancel();
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

  // ---- Speech synthesis ----

  const speakFrom = useCallback(
    (startWordIdx: number) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      const synth = window.speechSynthesis;
      manualStopRef.current = true;
      synth.cancel();
      manualStopRef.current = false;

      // `wordIndexAt` returns -1 when allWords is empty (e.g. image-only PDF
      // with no extractable text), so guard both ends before indexing.
      if (startWordIdx < 0 || startWordIdx >= allWords.length) {
        setStatus("idle");
        return;
      }
      const startChar = allWords[startWordIdx].start;
      const rawTail = content.slice(startChar);
      // Auto-skip: equal-length redaction preserves char offsets so
      // onboundary events still correctly index the displayed content.
      const tail = preprocessForSpeech(rawTail, autoSkipRef.current);
      utteranceBaseRef.current = startChar;

      const u = new SpeechSynthesisUtterance(tail);
      u.rate = rate;
      u.onboundary = (e: SpeechSynthesisEvent) => {
        if (e.name !== "word" && e.charLength === 0) return;
        const globalChar = utteranceBaseRef.current + e.charIndex;
        setCurrentWordIdx(wordIndexAt(allWords, globalChar));
      };
      u.onend = () => {
        if (manualStopRef.current) return;
        setStatus("idle");
        setCurrentWordIdx(allWords.length - 1);
      };
      u.onerror = (e) => {
        if (e.error === "interrupted" || e.error === "canceled") return;
        console.warn("TTS error:", e.error);
        setStatus("paused");
      };

      setCurrentWordIdx(startWordIdx);
      synth.speak(u);
      setStatus("playing");
    },
    [allWords, content, rate]
  );

  const play = useCallback(() => {
    if (status === "playing") return;
    if (status === "paused" && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      setStatus("playing");
      return;
    }
    speakFrom(currentWordIdx);
  }, [status, currentWordIdx, speakFrom]);

  const pause = useCallback(() => {
    if (typeof window === "undefined") return;
    if (status === "playing") {
      window.speechSynthesis.pause();
      setStatus("paused");
    }
  }, [status]);

  const skip = useCallback(
    (seconds: number) => {
      const step = Math.max(1, Math.round(Math.abs(seconds) * WORDS_PER_SECOND * rate));
      const next =
        seconds >= 0
          ? Math.min(allWords.length - 1, currentWordIdx + step)
          : Math.max(0, currentWordIdx - step);
      if (status === "playing") speakFrom(next);
      else setCurrentWordIdx(next);
    },
    [rate, currentWordIdx, allWords.length, status, speakFrom]
  );

  const seekTo = useCallback(
    (idx: number, playAfter?: boolean) => {
      const clamped = Math.max(0, Math.min(allWords.length - 1, Math.floor(idx)));
      const shouldPlay = playAfter || status === "playing";
      if (shouldPlay) speakFrom(clamped);
      else setCurrentWordIdx(clamped);
    },
    [allWords.length, speakFrom, status]
  );

  const seekToCharOffset = useCallback(
    (charOffset: number, playAfter?: boolean) => {
      const idx = wordIndexAt(allWords, Math.max(0, charOffset));
      const shouldPlay = playAfter || status === "playing";
      if (shouldPlay) speakFrom(idx);
      else setCurrentWordIdx(idx);
    },
    [allWords, speakFrom, status]
  );

  const seekFrac = useCallback(
    (frac: number) => {
      const target = Math.round(Math.max(0, Math.min(1, frac)) * (allWords.length - 1));
      if (status === "playing") speakFrom(target);
      else setCurrentWordIdx(target);
    },
    [allWords.length, speakFrom, status]
  );

  const cycleRate = useCallback(() => {
    const idx = SPEED_CYCLE.findIndex((x) => Math.abs(x - rate) < 0.01);
    const next = SPEED_CYCLE[(idx + 1) % SPEED_CYCLE.length];
    setRate(next);
    if (status === "playing") {
      window.speechSynthesis.cancel();
      setTimeout(() => speakFrom(currentWordIdx), 30);
    }
  }, [rate, status, speakFrom, currentWordIdx]);

  const setVoice = useCallback(
    (id: string) => {
      setVoiceId(id);
      if (status === "playing") {
        window.speechSynthesis.cancel();
        setTimeout(() => speakFrom(currentWordIdx), 30);
      }
    },
    [status, speakFrom, currentWordIdx]
  );

  const jumpToWord = useCallback(
    (idx: number) => {
      if (clickToListenRef.current) speakFrom(idx);
      else if (status === "playing") speakFrom(idx);
      else setCurrentWordIdx(idx);
    },
    [speakFrom, status]
  );

  const currentSentenceIdx = allWords[currentWordIdx]?.sentenceIndex ?? -1;
  const totalWords = allWords.length;
  const progressPct = totalWords > 0 ? (currentWordIdx / (totalWords - 1)) * 100 : 0;
  const elapsedSec = totalWords > 0 ? currentWordIdx / (WORDS_PER_SECOND * rate) : 0;
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
