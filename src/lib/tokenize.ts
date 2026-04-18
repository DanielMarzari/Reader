// Tokenize a block of text into paragraphs → sentences → words for
// rendering and two-tier highlighting. Preserves character offsets so
// we can map from `onboundary` charIndex → word → enclosing sentence.

export type Word = {
  text: string;
  start: number; // char offset in full content
  end: number; // exclusive
  trailing: string; // whitespace/punctuation that follows
  sentenceIndex: number; // index into the global sentence list
};

export type Sentence = {
  start: number;
  end: number;
};

export type Paragraph = {
  text: string;
  start: number;
  end: number;
  words: Word[];
};

export type Tokenized = {
  paragraphs: Paragraph[];
  words: Word[];
  sentences: Sentence[];
};

/** Split content into paragraphs → sentences → words, all with char offsets. */
export function tokenize(content: string): Tokenized {
  const paragraphs: Paragraph[] = [];
  const words: Word[] = [];
  const sentences: Sentence[] = [];

  const paraRe = /[^\n]+(?:\n[^\n]+)*/g;
  let pm: RegExpExecArray | null;

  while ((pm = paraRe.exec(content)) !== null) {
    const paraText = pm[0];
    const paraStart = pm.index;
    const paraEnd = paraStart + paraText.length;

    // Sentence segmentation inside this paragraph.
    const sentenceRe = /[^.!?]+[.!?]+["')\]”’]*\s*|[^.!?]+$/g;
    const paraSentences: Sentence[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = sentenceRe.exec(paraText)) !== null) {
      const sStart = paraStart + sm.index;
      const sEnd = sStart + sm[0].length;
      paraSentences.push({ start: sStart, end: sEnd });
    }
    if (paraSentences.length === 0) {
      paraSentences.push({ start: paraStart, end: paraEnd });
    }

    const paraWords: Word[] = [];
    const wordRe = /([\p{L}\p{N}][\p{L}\p{N}'’-]*)(\s*[.,;:!?—\-…"()\[\]“”‘’]*\s*)?/gu;
    let wm: RegExpExecArray | null;
    while ((wm = wordRe.exec(paraText)) !== null) {
      if (!wm[1]) continue;
      const wStart = paraStart + wm.index;
      const wEnd = wStart + wm[1].length;

      // Find enclosing sentence (global index).
      const localIdx = paraSentences.findIndex(
        (s) => wStart >= s.start && wStart < s.end
      );
      const sentenceIndex =
        sentences.length +
        (localIdx === -1 ? paraSentences.length - 1 : localIdx);

      const word: Word = {
        text: wm[1],
        start: wStart,
        end: wEnd,
        trailing: wm[2] ?? "",
        sentenceIndex,
      };
      paraWords.push(word);
      words.push(word);
    }

    sentences.push(...paraSentences);
    paragraphs.push({ text: paraText, start: paraStart, end: paraEnd, words: paraWords });
  }

  return { paragraphs, words, sentences };
}

/** Binary-search the word index at a given char offset. */
export function wordIndexAt(words: Word[], charIndex: number): number {
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid];
    if (charIndex < w.start) hi = mid - 1;
    else if (charIndex >= w.end) lo = mid + 1;
    else return mid;
  }
  return Math.min(words.length - 1, Math.max(0, lo));
}
