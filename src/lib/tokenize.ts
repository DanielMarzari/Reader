// Tokenize a block of text into paragraphs → words for rendering and highlighting.
// Preserves character offsets so we can map from `onboundary` charIndex → word.

export type Word = {
  text: string;
  start: number; // char offset in full content
  end: number; // exclusive
  // whitespace/punctuation following this word (part of display, not spoken focus)
  trailing: string;
};

export type Paragraph = {
  text: string; // the whole paragraph as one string (easier for utterances)
  start: number; // char offset of paragraph start in full content
  end: number; // exclusive
  words: Word[];
};

/** Split content into paragraphs, then each paragraph into words with offsets. */
export function tokenize(content: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  // Split by double newline; keep their offsets.
  const re = /[^\n]+(?:\n[^\n]+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const paraText = m[0];
    const paraStart = m.index;
    const paraEnd = paraStart + paraText.length;

    const words: Word[] = [];
    // Match words and trailing whitespace/punctuation separately.
    const wordRe = /([\p{L}\p{N}][\p{L}\p{N}'’-]*)(\s*[.,;:!?—\-…"()\[\]“”‘’]*\s*)?/gu;
    let wm: RegExpExecArray | null;
    while ((wm = wordRe.exec(paraText)) !== null) {
      if (!wm[1]) continue;
      const wStart = paraStart + wm.index;
      const wEnd = wStart + wm[1].length;
      words.push({
        text: wm[1],
        start: wStart,
        end: wEnd,
        trailing: wm[2] ?? "",
      });
    }
    paragraphs.push({ text: paraText, start: paraStart, end: paraEnd, words });
  }
  return paragraphs;
}

/** Flatten to a single ordered word list (for index-based navigation). */
export function flatWords(paragraphs: Paragraph[]): Word[] {
  const out: Word[] = [];
  for (const p of paragraphs) out.push(...p.words);
  return out;
}

/** Find the paragraph index containing this char offset (or the first paragraph after). */
export function paragraphIndexAt(paragraphs: Paragraph[], charIndex: number): number {
  for (let i = 0; i < paragraphs.length; i++) {
    if (charIndex < paragraphs[i].end) return i;
  }
  return Math.max(0, paragraphs.length - 1);
}

/** Find the word index containing this char offset (global, across all paragraphs). */
export function wordIndexAt(words: Word[], charIndex: number): number {
  // Binary search
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid];
    if (charIndex < w.start) hi = mid - 1;
    else if (charIndex >= w.end) lo = mid + 1;
    else return mid;
  }
  // If in a gap, return the next word.
  return Math.min(words.length - 1, Math.max(0, lo));
}
