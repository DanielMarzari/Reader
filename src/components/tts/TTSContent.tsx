"use client";

import { useEffect, useMemo } from "react";
import { useTTS } from "./TTSContext";

export function TTSContent({
  highlightSentence,
}: {
  highlightSentence: boolean;
}) {
  const { tokens, currentWordIdx, currentSentenceIdx, jumpToWord } = useTTS();

  // Scroll current word into view.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = document.getElementById(`w-${currentWordIdx}`);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentWordIdx]);

  const rendered = useMemo(() => {
    const out: React.ReactNode[] = [];
    let wordCursor = 0;
    for (let p = 0; p < tokens.paragraphs.length; p++) {
      const para = tokens.paragraphs[p];
      const children: React.ReactNode[] = [];
      let i = 0;
      while (i < para.words.length) {
        const sIdx = para.words[i].sentenceIndex;
        const group: React.ReactNode[] = [];
        while (i < para.words.length && para.words[i].sentenceIndex === sIdx) {
          const word = para.words[i];
          const globalIdx = wordCursor + i;
          let wordCls = "word word-clickable";
          if (globalIdx === currentWordIdx) wordCls = "word word-current word-clickable";
          else if (globalIdx < currentWordIdx) wordCls = "word word-spoken word-clickable";
          group.push(
            <span
              key={`w-${globalIdx}`}
              id={`w-${globalIdx}`}
              className={wordCls}
              onClick={() => jumpToWord(globalIdx)}
            >
              {word.text}
            </span>
          );
          if (word.trailing) group.push(word.trailing);
          i++;
        }
        const sentenceCls =
          highlightSentence && sIdx === currentSentenceIdx
            ? "sentence sentence-current"
            : "sentence";
        children.push(
          <span key={`s-${sIdx}`} className={sentenceCls}>
            {group}
          </span>
        );
      }
      out.push(
        <p key={`p-${p}`} style={{ whiteSpace: "pre-wrap" }}>
          {children}
        </p>
      );
      wordCursor += para.words.length;
    }
    return out;
  }, [tokens, currentWordIdx, currentSentenceIdx, highlightSentence, jumpToWord]);

  return <article className="reader-content">{rendered}</article>;
}
