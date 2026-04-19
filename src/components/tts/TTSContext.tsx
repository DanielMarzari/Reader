"use client";

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
import { chunkDocument, estimateWordIdx, type Chunk } from "@/lib/ttsChunker";
import { TTSStreamer, type StreamerStatus } from "./TTSStreamer";

const WORDS_PER_SECOND = 2.5;
const SPEED_CYCLE = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5] as const;

export type Status = "idle" | "playing" | "paused";
export type TTSEngine = "browser" | "elevenlabs";

export type ElevenLabsVoice = {
  id: string;
  name: string;
  labels?: Record<string, string>;
};

type TTSContextValue = {
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

  engine: TTSEngine;
  setEngine: (engine: TTSEngine) => void;
  elevenLabsAvailable: boolean;
  elevenLabsVoices: ElevenLabsVoice[];
  elevenLabsVoiceId: string | null;
  setElevenLabsVoiceId: (id: string) => void;
  engineError: string | null;

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

const TTSContext = createContext<TTSContextValue | null>(null);

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
  initialEngine = "browser",
  initialElevenLabsVoiceId = null,
  onEngineChange,
  onElevenLabsVoiceChange,
  clickToListen,
  autoSkip = defaultAutoSkip,
  children,
}: {
  docId: string;
  content: string;
  initialCharIndex: number;
  initialRate: number;
  initialVoiceName: string | null;
  initialEngine?: TTSEngine;
  initialElevenLabsVoiceId?: string | null;
  onEngineChange?: (engine: TTSEngine) => void;
  onElevenLabsVoiceChange?: (voiceId: string | null) => void;
  clickToListen: boolean;
  autoSkip?: AutoSkipSettings;
  children: React.ReactNode;
}) {
  const tokens = useMemo<Tokenized>(() => tokenize(content), [content]);
  const allWords = tokens.words;

  const [status, setStatus] = useState<Status>("idle");
  const [rate, setRate] = useState(initialRate);
  // voiceId is the id of a Voice Lab profile (/api/voices). initialVoiceName
  // comes from the DB — it may be an old browser voice name from before we
  // migrated; in that case we just ignore it and fall back to the first
  // Voice Lab voice.
  const [voiceId, setVoiceId] = useState<string | null>(initialVoiceName);
  const [voices, setVoices] = useState<ReaderVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [currentWordIdx, setCurrentWordIdx] = useState<number>(() =>
    wordIndexAt(allWords, initialCharIndex)
  );

  // ElevenLabs engine state.
  const [engine, setEngineState] = useState<TTSEngine>(initialEngine);
  const [elevenLabsAvailable, setElevenLabsAvailable] = useState(false);
  const [elevenLabsVoices, setElevenLabsVoices] = useState<ElevenLabsVoice[]>([]);
  const [elevenLabsVoiceId, setElevenLabsVoiceIdState] = useState<string | null>(
    initialElevenLabsVoiceId
  );
  const [engineError, setEngineError] = useState<string | null>(null);

  const utteranceBaseRef = useRef<number>(0);
  const manualStopRef = useRef(false);
  const savedIdxRef = useRef<number>(currentWordIdx);
  const clickToListenRef = useRef(clickToListen);
  const autoSkipRef = useRef<AutoSkipSettings>(autoSkip);
  const streamerRef = useRef<TTSStreamer | null>(null);
  const chunksRef = useRef<Chunk[]>([]);
  useEffect(() => {
    clickToListenRef.current = clickToListen;
  }, [clickToListen]);
  useEffect(() => {
    autoSkipRef.current = autoSkip;
  }, [autoSkip]);

  // Load Voice Lab voices from the server. Browser SpeechSynthesis voices
  // are intentionally NOT surfaced — the app only exposes voices imported
  // from Voice Studio.
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
            // Accept either id or legacy name as the persisted value.
            const match = list.find((v) => v.id === prev) ?? list.find((v) => v.name === prev);
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

  // Probe ElevenLabs availability once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/tts/voices");
        if (!resp.ok) return;
        const data = (await resp.json()) as {
          enabled?: boolean;
          voices?: ElevenLabsVoice[];
        };
        if (cancelled) return;
        setElevenLabsAvailable(Boolean(data.enabled));
        const list = data.voices ?? [];
        setElevenLabsVoices(list);
        setElevenLabsVoiceIdState((prev) => prev ?? list[0]?.id ?? null);
      } catch {
        /* silent */
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
        // The server field is still called voiceName; we pass the voice id.
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
      streamerRef.current?.dispose();
      streamerRef.current = null;
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

  // -------- Browser engine (Web Speech API) --------

  const speakFromBrowser = useCallback(
    (startWordIdx: number) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      const synth = window.speechSynthesis;
      manualStopRef.current = true;
      synth.cancel();
      manualStopRef.current = false;

      if (startWordIdx >= allWords.length) {
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
      // Until a real TTS engine (ElevenLabs/etc.) is wired, we still use
      // the browser's SpeechSynthesis with its default system voice.
      // The Voice Lab selection is stored but doesn't yet influence timbre.
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

  // -------- ElevenLabs engine (chunked streaming) --------

  const teardownStreamer = useCallback(() => {
    streamerRef.current?.dispose();
    streamerRef.current = null;
  }, []);

  const handleStreamerStatus = useCallback(
    (s: StreamerStatus, err?: string) => {
      if (s === "error") {
        setEngineError(err ?? "Streaming error");
        setStatus("paused");
        return;
      }
      if (s === "playing") setStatus("playing");
      else if (s === "paused") setStatus("paused");
      else if (s === "ended") setStatus("idle");
    },
    []
  );

  const handleStreamerTick = useCallback(
    (chunkIdx: number, progress: number) => {
      const chunk = chunksRef.current[chunkIdx];
      if (!chunk) return;
      const idx = estimateWordIdx(chunk, progress);
      setCurrentWordIdx(idx);
    },
    []
  );

  const startElevenLabsFrom = useCallback(
    async (startWordIdx: number) => {
      setEngineError(null);
      teardownStreamer();
      if (startWordIdx >= allWords.length) {
        setStatus("idle");
        return;
      }
      const startChar = allWords[startWordIdx]?.start ?? 0;
      const chunks = chunkDocument(content, allWords, startChar);
      if (chunks.length === 0) {
        setStatus("idle");
        return;
      }
      chunksRef.current = chunks;

      const streamer = new TTSStreamer({
        content,
        chunks,
        voiceId: elevenLabsVoiceId ?? undefined,
        rate,
        onStatusChange: handleStreamerStatus,
        onTick: handleStreamerTick,
      });
      streamerRef.current = streamer;
      setCurrentWordIdx(startWordIdx);
      setStatus("playing");
      try {
        await streamer.start();
      } catch (err) {
        setEngineError(err instanceof Error ? err.message : "Streaming failed");
        setStatus("paused");
      }
    },
    [
      allWords,
      content,
      elevenLabsVoiceId,
      handleStreamerStatus,
      handleStreamerTick,
      rate,
      teardownStreamer,
    ]
  );

  // -------- Unified engine dispatch --------

  const speakFrom = useCallback(
    (startWordIdx: number) => {
      if (engine === "elevenlabs") {
        void startElevenLabsFrom(startWordIdx);
      } else {
        speakFromBrowser(startWordIdx);
      }
    },
    [engine, speakFromBrowser, startElevenLabsFrom]
  );

  const play = useCallback(() => {
    if (status === "playing") return;
    if (engine === "elevenlabs") {
      if (status === "paused" && streamerRef.current) {
        streamerRef.current.resume();
        setStatus("playing");
        return;
      }
      void startElevenLabsFrom(currentWordIdx);
      return;
    }
    if (status === "paused" && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      setStatus("playing");
      return;
    }
    speakFromBrowser(currentWordIdx);
  }, [status, engine, currentWordIdx, speakFromBrowser, startElevenLabsFrom]);

  const pause = useCallback(() => {
    if (typeof window === "undefined") return;
    if (engine === "elevenlabs") {
      if (status === "playing" && streamerRef.current) {
        streamerRef.current.pause();
        setStatus("paused");
      }
      return;
    }
    if (status === "playing") {
      window.speechSynthesis.pause();
      setStatus("paused");
    }
  }, [status, engine]);

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
    if (engine === "elevenlabs") {
      streamerRef.current?.setRate(next);
      return;
    }
    if (status === "playing") {
      window.speechSynthesis.cancel();
      setTimeout(() => speakFromBrowser(currentWordIdx), 30);
    }
  }, [rate, status, engine, speakFromBrowser, currentWordIdx]);

  const setVoice = useCallback(
    (id: string) => {
      setVoiceId(id);
      if (engine === "browser" && status === "playing") {
        window.speechSynthesis.cancel();
        setTimeout(() => speakFromBrowser(currentWordIdx), 30);
      }
    },
    [engine, status, speakFromBrowser, currentWordIdx]
  );

  const setEngine = useCallback(
    (next: TTSEngine) => {
      if (next === engine) return;
      // Stop whatever is currently running.
      if (engine === "browser") {
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
          window.speechSynthesis.cancel();
        }
      } else {
        teardownStreamer();
      }
      setStatus("idle");
      setEngineState(next);
      onEngineChange?.(next);
    },
    [engine, onEngineChange, teardownStreamer]
  );

  const setElevenLabsVoiceId = useCallback(
    (id: string) => {
      setElevenLabsVoiceIdState(id);
      onElevenLabsVoiceChange?.(id);
      if (engine === "elevenlabs" && status === "playing") {
        void startElevenLabsFrom(currentWordIdx);
      }
    },
    [engine, status, currentWordIdx, onElevenLabsVoiceChange, startElevenLabsFrom]
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
    engine,
    setEngine,
    elevenLabsAvailable,
    elevenLabsVoices,
    elevenLabsVoiceId,
    setElevenLabsVoiceId,
    engineError,
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
