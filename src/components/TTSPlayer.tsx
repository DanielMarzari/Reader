"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tokenize, flatWords, paragraphIndexAt, wordIndexAt, type Paragraph } from "@/lib/tokenize";

type Props = {
  docId: string;
  content: string;
  initialCharIndex: number;
  initialRate: number;
  initialVoiceName: string | null;
};

// Roughly 10 seconds of playback at rate 1 ≈ 25 words (150 wpm).
const WORDS_PER_SECOND = 2.5;

type Status = "idle" | "playing" | "paused";

export function TTSPlayer({
  docId,
  content,
  initialCharIndex,
  initialRate,
  initialVoiceName,
}: Props) {
  const paragraphs = useMemo<Paragraph[]>(() => tokenize(content), [content]);
  const allWords = useMemo(() => flatWords(paragraphs), [paragraphs]);

  const [status, setStatus] = useState<Status>("idle");
  const [rate, setRate] = useState(initialRate);
  const [voiceName, setVoiceName] = useState<string | null>(initialVoiceName);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [currentWordIdx, setCurrentWordIdx] = useState<number>(() =>
    wordIndexAt(allWords, initialCharIndex)
  );

  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  // Track the char offset in the original `content` where the current utterance begins.
  const utteranceBaseRef = useRef<number>(0);
  const manualStopRef = useRef(false);
  const savedIdxRef = useRef<number>(currentWordIdx);

  // Load available voices. Chrome fires 'voiceschanged' async.
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const load = () => {
      const list = window.speechSynthesis.getVoices();
      setVoices(list);
      if (!voiceName && list.length) {
        // Pick a sensible default: first English voice.
        const en = list.find((v) => v.lang.startsWith("en"));
        setVoiceName(en?.name ?? list[0].name);
      }
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedVoice = useMemo(
    () => voices.find((v) => v.name === voiceName) ?? null,
    [voices, voiceName]
  );

  // Persist position (debounced).
  useEffect(() => {
    savedIdxRef.current = currentWordIdx;
  }, [currentWordIdx]);

  useEffect(() => {
    const handle = setInterval(() => {
      const w = allWords[savedIdxRef.current];
      if (!w) return;
      void fetch(`/api/documents/${docId}/position`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          charIndex: w.start,
          rate,
          voiceName,
        }),
      });
    }, 4000);
    return () => clearInterval(handle);
  }, [docId, rate, voiceName, allWords]);

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
            [JSON.stringify({ charIndex: w.start, rate, voiceName })],
            { type: "application/json" }
          )
        );
      }
    };
  }, [docId, allWords, rate, voiceName]);

  // Start speech from a word index. If already playing, cancel and restart.
  const speakFrom = useCallback(
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
      const tail = content.slice(startChar);
      utteranceBaseRef.current = startChar;

      const u = new SpeechSynthesisUtterance(tail);
      u.rate = rate;
      if (selectedVoice) u.voice = selectedVoice;
      u.onboundary = (e: SpeechSynthesisEvent) => {
        if (e.name !== "word" && e.charLength === 0) return;
        const globalChar = utteranceBaseRef.current + e.charIndex;
        const idx = wordIndexAt(allWords, globalChar);
        setCurrentWordIdx(idx);
      };
      u.onend = () => {
        if (manualStopRef.current) return;
        setStatus("idle");
        setCurrentWordIdx(allWords.length - 1);
      };
      u.onerror = (e) => {
        // 'interrupted' / 'canceled' happen on manual stop — ignore.
        if (e.error === "interrupted" || e.error === "canceled") return;
        console.warn("TTS error:", e.error);
        setStatus("paused");
      };

      utteranceRef.current = u;
      setCurrentWordIdx(startWordIdx);
      synth.speak(u);
      setStatus("playing");
    },
    [allWords, content, rate, selectedVoice]
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
      if (status === "playing") {
        speakFrom(next);
      } else {
        setCurrentWordIdx(next);
      }
    },
    [rate, currentWordIdx, allWords.length, status, speakFrom]
  );

  const changeRate = useCallback(
    (next: number) => {
      setRate(next);
      if (status === "playing") {
        // Restart with new rate from the current position.
        window.speechSynthesis.cancel();
        setTimeout(() => speakFrom(currentWordIdx), 30);
      }
    },
    [status, speakFrom, currentWordIdx]
  );

  const changeVoice = useCallback(
    (name: string) => {
      setVoiceName(name);
      if (status === "playing") {
        window.speechSynthesis.cancel();
        setTimeout(() => speakFrom(currentWordIdx), 30);
      }
    },
    [status, speakFrom, currentWordIdx]
  );

  const handleWordClick = useCallback(
    (idx: number) => {
      if (status === "playing") {
        speakFrom(idx);
      } else {
        setCurrentWordIdx(idx);
      }
    },
    [status, speakFrom]
  );

  // Scroll the current word into view smoothly.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = document.getElementById(`w-${currentWordIdx}`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [currentWordIdx]);

  const progressPct = allWords.length
    ? Math.round((currentWordIdx / (allWords.length - 1)) * 100)
    : 0;

  // Render the document with per-word spans so we can highlight.
  const rendered = useMemo(() => {
    const out: React.ReactNode[] = [];
    let wordCursor = 0;
    for (let p = 0; p < paragraphs.length; p++) {
      const para = paragraphs[p];
      const children: React.ReactNode[] = [];
      for (let w = 0; w < para.words.length; w++) {
        const word = para.words[w];
        const idx = wordCursor + w;
        const classes =
          idx === currentWordIdx
            ? "word word-current"
            : idx < currentWordIdx
            ? "word word-spoken"
            : "word";
        children.push(
          <span
            key={`w-${idx}`}
            id={`w-${idx}`}
            className={classes}
            onClick={() => handleWordClick(idx)}
            style={{ cursor: "pointer" }}
          >
            {word.text}
          </span>
        );
        if (word.trailing) children.push(word.trailing);
      }
      out.push(
        <p key={`p-${p}`} style={{ whiteSpace: "pre-wrap" }}>
          {children}
        </p>
      );
      wordCursor += para.words.length;
    }
    return out;
  }, [paragraphs, currentWordIdx, handleWordClick]);

  return (
    <>
      <article className="reader-content px-4 pt-6 pb-40">{rendered}</article>

      {/* Bottom player bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-[color:var(--border)] bg-[color:var(--background)]/95 backdrop-blur">
        {/* Progress bar */}
        <div className="h-1 bg-[color:var(--surface-2)]">
          <div
            className="h-full bg-[color:var(--accent)] transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <select
            className="select text-sm"
            value={voiceName ?? ""}
            onChange={(e) => changeVoice(e.target.value)}
            disabled={voices.length === 0}
            style={{ maxWidth: 220 }}
          >
            {voices.length === 0 ? (
              <option>No voices available</option>
            ) : (
              voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))
            )}
          </select>

          <div className="flex items-center gap-2 mx-auto">
            <button
              className="btn btn-icon"
              onClick={() => skip(-10)}
              title="Back 10s"
              aria-label="Back 10 seconds"
            >
              ⏮ 10
            </button>
            <button
              className="btn-play"
              onClick={status === "playing" ? pause : play}
              aria-label={status === "playing" ? "Pause" : "Play"}
            >
              {status === "playing" ? "❚❚" : "▶"}
            </button>
            <button
              className="btn btn-icon"
              onClick={() => skip(10)}
              title="Forward 10s"
              aria-label="Forward 10 seconds"
            >
              10 ⏭
            </button>
          </div>

          <select
            className="select text-sm"
            value={rate}
            onChange={(e) => changeRate(Number(e.target.value))}
          >
            {[0.5, 0.75, 1, 1.2, 1.5, 1.75, 2, 2.5, 3].map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>

          <div className="text-xs text-[color:var(--muted)] tabular-nums w-12 text-right">
            {progressPct}%
          </div>
        </div>
      </div>
    </>
  );
}

// Helper so the Reader page can deep-link to a paragraph if needed.
export function getInitialParagraphIndex(paragraphs: Paragraph[], charIndex: number) {
  return paragraphIndexAt(paragraphs, charIndex);
}
