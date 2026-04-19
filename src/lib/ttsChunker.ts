// Chunker for the ElevenLabs streaming engine.
//
// Speechify-style chunking: 30-47 words / 180-250 chars per chunk, split at
// sentence boundaries when possible. The chunker preserves the full source
// text (including whitespace) so that `charStart`/`charEnd` offsets can be
// mapped back to word indices for per-word highlight.

import type { Word } from "./tokenize";

export type Chunk = {
  index: number;
  /** The verbatim text of this chunk (including leading/trailing whitespace). */
  text: string;
  /** Trimmed text suitable for sending to the TTS engine. */
  speakText: string;
  /** Inclusive char offset in the original document. */
  charStart: number;
  /** Exclusive char offset in the original document. */
  charEnd: number;
  /** Index into the flat word list where this chunk starts. */
  wordStart: number;
  /** Exclusive index into the flat word list. */
  wordEnd: number;
};

const TARGET_MIN_CHARS = 180;
const TARGET_MAX_CHARS = 250;
const HARD_MAX_CHARS = 320;

/** True if `ch` is a sentence terminator. */
function isSentenceEnd(ch: string): boolean {
  return ch === "." || ch === "!" || ch === "?";
}

/** True if `ch` is a clause separator (used for soft splits past max). */
function isClauseBreak(ch: string): boolean {
  return ch === "," || ch === ";" || ch === ":";
}

/**
 * Find a good split point inside `text[from..to)` (absolute offsets into the
 * document). Returns the exclusive end offset of the first chunk.
 *
 * Priority:
 *   1. Paragraph break (\n\n) within [from+TARGET_MIN, from+HARD_MAX].
 *   2. Sentence end (. ! ?) within [from+TARGET_MIN, from+TARGET_MAX].
 *   3. Clause break (, ; :) within [from+TARGET_MIN, from+HARD_MAX].
 *   4. Whitespace boundary at from+TARGET_MAX.
 *   5. Hard cut at from+HARD_MAX.
 */
function findSplit(source: string, from: number, to: number): number {
  const remaining = to - from;
  if (remaining <= TARGET_MAX_CHARS) return to;

  const windowEnd = Math.min(to, from + HARD_MAX_CHARS);

  // 1. Paragraph break.
  const paraIdx = source.indexOf("\n\n", from + TARGET_MIN_CHARS);
  if (paraIdx !== -1 && paraIdx < windowEnd) return paraIdx + 2;

  const softEnd = Math.min(to, from + TARGET_MAX_CHARS);

  // 2. Sentence end within the preferred window.
  for (let i = softEnd - 1; i >= from + TARGET_MIN_CHARS; i--) {
    if (isSentenceEnd(source[i])) {
      // Consume trailing quotes and whitespace.
      let j = i + 1;
      while (j < to && /["')\]”’\s]/.test(source[j])) j++;
      return j;
    }
  }

  // 3. Sentence end up to the hard max.
  for (let i = windowEnd - 1; i >= from + TARGET_MIN_CHARS; i--) {
    if (isSentenceEnd(source[i])) {
      let j = i + 1;
      while (j < to && /["')\]”’\s]/.test(source[j])) j++;
      return j;
    }
  }

  // 4. Clause break within the hard window.
  for (let i = windowEnd - 1; i >= from + TARGET_MIN_CHARS; i--) {
    if (isClauseBreak(source[i])) {
      let j = i + 1;
      while (j < to && /\s/.test(source[j])) j++;
      return j;
    }
  }

  // 5. Whitespace boundary at softEnd.
  for (let i = softEnd; i < windowEnd; i++) {
    if (/\s/.test(source[i])) return i + 1;
  }
  for (let i = softEnd - 1; i > from; i--) {
    if (/\s/.test(source[i])) return i + 1;
  }

  // 6. Hard cut.
  return windowEnd;
}

/**
 * Chunk `content` starting at `startCharOffset` into sequential pieces.
 *
 * Respects paragraph boundaries: we never produce a chunk that spans an empty
 * line. Words with no enclosing chunk are attributed to the nearest chunk.
 */
export function chunkDocument(
  content: string,
  words: Word[],
  startCharOffset: number
): Chunk[] {
  const out: Chunk[] = [];
  const clampedStart = Math.max(0, Math.min(content.length, Math.floor(startCharOffset)));
  if (clampedStart >= content.length) return out;

  // Split the source into paragraphs (double-newline delimited) so a chunk
  // never carries over a paragraph break — that's where the neural model's
  // prosody naturally resets anyway.
  const paras: Array<{ start: number; end: number }> = [];
  const paraRe = /[^\n]+(?:\n[^\n]+)*/g;
  let pm: RegExpExecArray | null;
  while ((pm = paraRe.exec(content)) !== null) {
    paras.push({ start: pm.index, end: pm.index + pm[0].length });
  }
  if (paras.length === 0) paras.push({ start: 0, end: content.length });

  // Active paragraphs (those that intersect with [clampedStart, end)).
  const active: Array<{ start: number; end: number }> = [];
  for (const p of paras) {
    if (p.end <= clampedStart) continue;
    active.push({ start: Math.max(p.start, clampedStart), end: p.end });
  }

  let chunkIdx = 0;
  for (const para of active) {
    let cursor = para.start;
    while (cursor < para.end) {
      const splitAt = findSplit(content, cursor, para.end);
      const charStart = cursor;
      const charEnd = Math.min(splitAt, para.end);

      const slice = content.slice(charStart, charEnd);
      const speakText = slice.replace(/\s+/g, " ").trim();
      if (!speakText) {
        cursor = charEnd;
        continue;
      }

      const wordStart = firstWordAtOrAfter(words, charStart);
      const wordEnd = firstWordAtOrAfter(words, charEnd);
      out.push({
        index: chunkIdx++,
        text: slice,
        speakText,
        charStart,
        charEnd,
        wordStart,
        wordEnd: Math.max(wordStart, wordEnd),
      });
      cursor = charEnd;
    }
  }

  return out;
}

/** Binary-search the index of the first word whose start >= `charIndex`. */
function firstWordAtOrAfter(words: Word[], charIndex: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start < charIndex) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Given a chunk and a progress fraction [0,1], return the word index to
 * highlight inside that chunk. Uses a linear time→word estimate — good
 * enough when with-timestamps alignment isn't available.
 */
export function estimateWordIdx(chunk: Chunk, progress: number): number {
  const count = chunk.wordEnd - chunk.wordStart;
  if (count <= 0) return chunk.wordStart;
  const clamped = Math.max(0, Math.min(0.999, progress));
  const offset = Math.floor(clamped * count);
  return chunk.wordStart + offset;
}

/**
 * Previous-text context helper: return up to `maxChars` of the text *before*
 * `chunk`. This is sent as `previous_text` to ElevenLabs so the model knows
 * how the prior audio ended.
 */
export function previousContext(
  content: string,
  chunk: Chunk,
  maxChars = 500
): string {
  const start = Math.max(0, chunk.charStart - maxChars);
  return content.slice(start, chunk.charStart).replace(/\s+/g, " ").trim();
}

/**
 * Forward-text context helper: return the verbatim speak-text of the NEXT
 * chunk if it exists. Sent as `next_text` so the model can plan trailing
 * intonation.
 */
export function forwardContext(
  chunks: Chunk[],
  currentIdx: number,
  maxChars = 500
): string {
  const next = chunks[currentIdx + 1];
  if (!next) return "";
  return next.speakText.slice(0, maxChars);
}
