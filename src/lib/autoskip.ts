// Auto-Skip Content: user preferences + the preprocessing pass that
// strips skippable patterns before we hand text to speechSynthesis.
//
// Headers / footers / footnotes / tables / formulas / citations need
// structural document analysis — they're UI-only for now (placeholder,
// coming-soon). Everything else is tractable with regex and is wired.

export type AutoSkipSettings = {
  enabled: boolean;
  headers: boolean;
  footers: boolean;
  footnotes: boolean;
  tables: boolean;
  formulas: boolean;
  citations: boolean;
  urls: boolean;
  parentheses: boolean;
  brackets: boolean;
  braces: boolean;
};

export const defaultAutoSkip: AutoSkipSettings = {
  enabled: false,
  headers: false,
  footers: false,
  footnotes: false,
  tables: false,
  formulas: false,
  citations: false,
  urls: false,
  parentheses: false,
  brackets: false,
  braces: false,
};

/** True when this item is plumbed through to real preprocessing today. */
export const AUTOSKIP_ACTIVE: Record<keyof AutoSkipSettings, boolean> = {
  enabled: true,
  urls: true,
  parentheses: true,
  brackets: true,
  braces: true,
  citations: true, // simple (Author, 2024) / [12] patterns
  headers: false,
  footers: false,
  footnotes: false,
  tables: false,
  formulas: false,
};

/**
 * Rewrite `text` by removing skippable spans, preserving overall length
 * by replacing with spaces so that char offsets into the ORIGINAL text
 * still match up with `onboundary` events from the synthesizer (the
 * browser reports boundaries against the string we passed it).
 *
 * We pass the REWRITTEN string to the synthesizer; the reader displays
 * the ORIGINAL text. Since the rewritten string is equal-length, the
 * charIndex from `onboundary` still indexes into the original content
 * correctly.
 */
export function preprocessForSpeech(text: string, s: AutoSkipSettings): string {
  if (!s.enabled) return text;

  const blank = (len: number) => " ".repeat(len);
  let out = text;

  const redact = (re: RegExp) => {
    out = out.replace(re, (m) => blank(m.length));
  };

  if (s.urls) {
    // http(s)://, ftp://, www., bare domains
    redact(/\b(?:https?:\/\/|ftp:\/\/|www\.)\S+/gi);
    redact(/\b[\w-]+\.(?:com|org|net|io|dev|co|edu|gov|app|ai|me)(?:\/\S*)?/gi);
  }
  if (s.citations) {
    redact(/\((?:[A-Z][\w.-]*(?:\s*&\s*[A-Z][\w.-]*)?(?:\s+et\s+al\.)?,\s*\d{4}[a-z]?(?:,\s*(?:p\.?|pp\.?)\s*\d+[\d-]*)?)\)/g);
    redact(/\[\d+(?:\s*[,-]\s*\d+)*\]/g);
  }
  if (s.parentheses) redact(/\([^()]*\)/g);
  if (s.brackets) redact(/\[[^\[\]]*\]/g);
  if (s.braces) redact(/\{[^{}]*\}/g);

  return out;
}
