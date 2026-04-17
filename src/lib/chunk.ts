// Split text into ~200-250 char chunks on sentence boundaries.
// Mirrors Speechify's chunking strategy.

export type Chunk = {
  index: number;
  charStart: number;
  charEnd: number;
  text: string;
};

export function chunkBySentence(
  text: string,
  opts: { target?: number; max?: number } = {}
): Chunk[] {
  const target = opts.target ?? 220;
  const max = opts.max ?? 320;

  // Split on sentence enders, keeping them attached.
  const sentenceRe = /[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+\n+/g;
  const sentences: Array<{ text: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = sentenceRe.exec(text)) !== null) {
    sentences.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) {
    sentences.push({ text: text.slice(lastEnd), start: lastEnd, end: text.length });
  }

  const chunks: Chunk[] = [];
  let buf = "";
  let bufStart = sentences[0]?.start ?? 0;
  let bufEnd = bufStart;

  const flush = () => {
    if (!buf.trim()) return;
    chunks.push({
      index: chunks.length,
      charStart: bufStart,
      charEnd: bufEnd,
      text: buf,
    });
    buf = "";
  };

  for (const s of sentences) {
    const wouldBe = buf.length + s.text.length;
    if (buf.length === 0) {
      buf = s.text;
      bufStart = s.start;
      bufEnd = s.end;
    } else if (wouldBe <= target || (buf.length < target && wouldBe <= max)) {
      buf += s.text;
      bufEnd = s.end;
    } else {
      flush();
      buf = s.text;
      bufStart = s.start;
      bufEnd = s.end;
    }
  }
  flush();
  return chunks;
}
