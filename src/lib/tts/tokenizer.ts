// Text -> token IDs for ZipVoice-Distill.
//
// Pipeline (matches ZipVoice's EspeakTokenizer in the backend):
//
//   text                    e.g. "Hello world."
//     │  phonemize()  ── via xenova/phonemizer (espeak-ng compiled to WASM)
//     ▼
//   phoneme string          e.g. "həlˈəʊ wˈɜːld"
//     │  split per Unicode code point
//     ▼
//   phoneme chars           ['h','ə','l','ˈ','ə','ʊ',' ','w','ˈ','ɜ','ː','l','d']
//     │  vocab lookup       (from the tokens.txt shipped alongside the
//     │                      ZipVoice ONNX; served at SHARED_ASSET_BASE)
//     ▼
//   token IDs               int64 array suitable for ORT-Web
//
// ZipVoice splits on characters (not on full phoneme tokens) because its
// vocab includes every stress marker (ˈ, ˌ), length marker (ː), and space
// as first-class tokens — it's a character-level vocabulary over the IPA
// alphabet that espeak-ng emits. Verified by running Spike D's CLI and
// observing token arrays like ['ð','ə',' ','m','ˈ','ɔ','ː','ɹ',...].

/** espeak-ng language code passed to the phonemizer. */
export type PhonemizeLanguage = "en-us" | "en-gb" | "en" | string;

/** Result of tokenizing a single piece of text. */
export type TokenizeResult = {
  /** Token IDs, int64, ready to be passed to ORT as a BigInt64Array. */
  ids: BigInt64Array;
  /** The full IPA phoneme string that was tokenized. Keep for debugging +
   *  for display in UI (shows the user what the model actually hears). */
  phonemes: string;
  /** Chars we couldn't find in the vocab. In a healthy flow this is
   *  empty; anything here tells us either the vocab is incomplete or
   *  phonemizer emitted an unexpected character (e.g. non-English
   *  punctuation). */
  skippedChars: string[];
};

/** Singleton tokenizer. Holds the vocab + a lazy-loaded phonemize
 *  function. Instantiate once per page / provider. */
export class ZipVoiceTokenizer {
  private vocab: Map<string, number> = new Map();
  private vocabLoaded = false;
  private phonemizeFnPromise: Promise<
    (text: string, language?: string) => Promise<string[]>
  > | null = null;

  /** Fetch + parse the tokens.txt that shipped with the ZipVoice ONNX.
   *  Format: one `TOKEN\tID` per line. TOKEN can be a single IPA
   *  character, a digraph like "uo1" (pinyin — we don't use these for
   *  English but they're in the vocab), or a special token. */
  async loadVocab(tokensUrl: string): Promise<void> {
    if (this.vocabLoaded) return;
    const text = await fetch(tokensUrl).then((r) => {
      if (!r.ok) throw new Error(`tokens.txt fetch failed: ${r.status}`);
      return r.text();
    });
    for (const line of text.split("\n")) {
      if (!line) continue;
      const tabIdx = line.indexOf("\t");
      if (tabIdx < 0) continue;
      const token = line.slice(0, tabIdx);
      const id = parseInt(line.slice(tabIdx + 1), 10);
      if (!Number.isNaN(id)) this.vocab.set(token, id);
    }
    this.vocabLoaded = true;
  }

  /** Lazy-import phonemizer. ~2 MB of espeak-ng WASM + language data
   *  downloads on first call. Subsequent calls hit the browser module
   *  cache. */
  private getPhonemize() {
    if (!this.phonemizeFnPromise) {
      this.phonemizeFnPromise = import("phonemizer").then((mod) => mod.phonemize);
    }
    return this.phonemizeFnPromise;
  }

  /** Phonemize + tokenize a sentence. `language` is an espeak-ng code —
   *  "en-us" for American English (default), "en-gb" for British, etc. */
  async textToTokenIds(
    text: string,
    language: PhonemizeLanguage = "en-us"
  ): Promise<TokenizeResult> {
    if (!this.vocabLoaded) {
      throw new Error("loadVocab() must be called before textToTokenIds()");
    }
    const phonemize = await this.getPhonemize();

    // phonemize returns an array of strings (one per sentence the
    // caller passed — here we pass a single sentence, so [0]). In
    // practice xenova's impl treats the input holistically + returns
    // one element. Join defensively for safety.
    const chunks = await phonemize(text, language);
    const phonemes = chunks.join(" ");

    // Walk unicode code points (NOT .length — IPA characters may be
    // multi-codepoint, but ZipVoice's vocab is single-codepoint per
    // entry so [...str] gives the right split).
    const ids: bigint[] = [];
    const skippedChars: string[] = [];
    for (const ch of phonemes) {
      const id = this.vocab.get(ch);
      if (id !== undefined) {
        ids.push(BigInt(id));
      } else {
        skippedChars.push(ch);
      }
    }

    return {
      ids: BigInt64Array.from(ids),
      phonemes,
      skippedChars,
    };
  }

  /** How many tokens are in the vocab. Useful to spot-check load. */
  vocabSize(): number {
    return this.vocab.size;
  }

  /** Lookup for debugging: what char maps to this id? Returns undefined
   *  if the id isn't in the vocab. */
  idToChar(id: number): string | undefined {
    for (const [k, v] of this.vocab) {
      if (v === id) return k;
    }
    return undefined;
  }
}
