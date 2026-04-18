// Shared PDF text assembly used by both the server parser and the
// client Pages viewer. They MUST produce identical output so we can
// map a TTS char offset back to an exact item on the rendered canvas.

export type PdfItem = {
  str: string;
  transform: number[];
  hasEOL?: boolean;
  width?: number;
  height?: number;
};

export type ItemRange = { start: number; end: number };

export type AssembledPage = {
  text: string;
  itemRanges: ItemRange[]; // indexed by item position; start/end are char offsets within `text`
};

/**
 * Concatenate items into a page text. Inserts "\n" when the baseline Y
 * jumps (new line) or when an item is flagged hasEOL. Appends each item
 * verbatim — length-preserving so per-item char ranges stay stable.
 */
export function assemblePage(items: PdfItem[]): AssembledPage {
  let text = "";
  const itemRanges: ItemRange[] = [];
  let lastY: number | null = null;
  for (const item of items) {
    const y = item.transform?.[5];
    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
      text += "\n";
    }
    const start = text.length;
    text += item.str;
    const end = text.length;
    itemRanges.push({ start, end });
    if (item.hasEOL) text += "\n";
    lastY = y ?? lastY;
  }
  return { text, itemRanges };
}

/**
 * Length-preserving whitespace cleanup for PDF text. Must NOT remove
 * or add characters; only substitute. Keeps char offsets stable so the
 * offsets stored in pages_meta continue to map to the exact items.
 */
export function safeNormalize(s: string): string {
  return s
    .replace(/\r/g, " ")
    .replace(/\t/g, " ")
    .replace(/\f/g, " ")
    .replace(/\v/g, " ");
}

/**
 * Join normalized page texts with a fixed separator; return the full
 * text AND the char range for each page.
 */
export function joinPages(pageTexts: string[], sep: string = "\n\n") {
  const parts: string[] = [];
  const pageRanges: Array<{ charStart: number; charEnd: number }> = [];
  let cursor = 0;
  for (let i = 0; i < pageTexts.length; i++) {
    const t = pageTexts[i];
    if (i > 0 && parts.length > 0) {
      parts.push(sep);
      cursor += sep.length;
    }
    const start = cursor;
    parts.push(t);
    cursor += t.length;
    pageRanges.push({ charStart: start, charEnd: cursor });
  }
  return { content: parts.join(""), pageRanges };
}
