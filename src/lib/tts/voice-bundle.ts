// Voice bundle: everything needed to synthesize one or more sentences
// for a given voice id. Loaded once per voice switch, cached in memory
// across provider mounts so navigating document → back → document
// doesn't re-download the ~500 MB of ONNX + reparse tokens.txt + re-
// phonemize the prompt text.
//
// What's bundled:
//
//   sessions    — ORT-Web InferenceSessions for text_encoder + fm_decoder
//                 + vocos. Cached at the HTTP layer (Cache Storage) so
//                 first voice load pays ~500 MB of bandwidth once; all
//                 voices share these three sessions.
//
//   tokenizer   — ZipVoiceTokenizer with tokens.txt vocab preloaded.
//                 Same across all voices.
//
//   promptMel         — PromptMel for this voice, with `data` kept in
//                       Float32Array and featScale copied through.
//   scaledPromptMel   — data × featScale, precomputed so we don't
//                       multiply 77,400 floats every synthesis call.
//   promptTokens      — BigInt64Array of the voice prompt text's
//                       phonemes, precomputed so we don't re-phonemize
//                       the same prompt for each sentence.
//
// The first three (shared) are held in module-level singletons.
// Per-voice state is keyed on voiceId in a Map.

import {
  configureOrt,
  createSessions,
  defaultSharedAssets,
  type TtsSessions,
  type DownloadProgress,
  type CreateSessionsPhase,
} from "@/lib/tts/browser-inference";
import { ZipVoiceTokenizer } from "@/lib/tts/tokenizer";
import { loadPromptMel, type PromptMel } from "@/lib/tts/prompt-mel";

export type VoiceBundle = {
  voiceId: string;
  sessions: TtsSessions;
  tokenizer: ZipVoiceTokenizer;
  promptMel: PromptMel;
  /** promptMel.data × promptMel.featScale. Fed as the prompt portion
   *  of `speech_condition`; rest of the tensor is zeros. */
  scaledPromptMel: Float32Array;
  /** Pre-tokenized prompt text for this voice. The Voice Studio clone
   *  endpoint put the transcript in voice.design.prompt_text; we
   *  phonemize + look up vocab once per voice. */
  promptTokens: BigInt64Array;
  promptPhonemes: string;
  skippedPromptChars: string[];
};

// ---------- Shared (cross-voice) singletons ----------

let _sharedSessionsPromise: Promise<TtsSessions> | null = null;
let _tokenizerPromise: Promise<ZipVoiceTokenizer> | null = null;

function getSharedSessions(
  onProgress?: (p: DownloadProgress) => void,
  onPhase?: (phase: CreateSessionsPhase) => void
): Promise<TtsSessions> {
  if (!_sharedSessionsPromise) {
    configureOrt();
    const shared = defaultSharedAssets();
    _sharedSessionsPromise = createSessions(shared, onProgress, onPhase).catch(
      (err) => {
        // Reset on failure so a retry can start fresh.
        _sharedSessionsPromise = null;
        throw err;
      }
    );
  }
  return _sharedSessionsPromise;
}

function getTokenizer(): Promise<ZipVoiceTokenizer> {
  if (!_tokenizerPromise) {
    const shared = defaultSharedAssets();
    const t = new ZipVoiceTokenizer();
    _tokenizerPromise = t.loadVocab(shared.tokensUrl).then(() => t);
  }
  return _tokenizerPromise;
}

// ---------- Per-voice cache ----------

const _voiceBundles = new Map<string, Promise<VoiceBundle>>();

export type LoadVoiceBundleArgs = {
  voiceId: string;
  /** The voice's prompt transcript. Usually from voice.design.prompt_text
   *  (Whisper auto-transcript at clone time). If empty we fail loudly —
   *  Phase 3 inference requires a prompt transcript. */
  promptText: string;
  onProgress?: (p: DownloadProgress) => void;
  /** Fires as the ORT session pipeline moves between "downloading" and
   *  "compiling" phases. The compile phase is silent (no byte progress)
   *  but takes 3–5 s on a fresh load — without this signal the progress
   *  chip hits 100 % and disappears while the user still waits. */
  onPhase?: (phase: CreateSessionsPhase) => void;
};

/** Build + cache a VoiceBundle. Subsequent calls for the same voice id
 *  return the cached promise. */
export function loadVoiceBundle({
  voiceId,
  promptText,
  onProgress,
  onPhase,
}: LoadVoiceBundleArgs): Promise<VoiceBundle> {
  const cached = _voiceBundles.get(voiceId);
  if (cached) return cached;

  const promise = (async () => {
    if (!promptText || !promptText.trim()) {
      throw new Error(
        `Voice ${voiceId} has no prompt_text. Re-clone in Voice Studio ` +
          `or run backend/scripts/compute_prompt_mel.py after restoring ` +
          `the transcript.`
      );
    }

    console.log(`[VoiceBundle] Loading bundle for voiceId=${voiceId}…`);
    const t0 = performance.now();

    // Kick all the loads off in parallel. Shared singletons are
    // memoized so concurrent voice loads share them.
    const [sessions, tokenizer, promptMel] = await Promise.all([
      getSharedSessions(onProgress, onPhase),
      getTokenizer(),
      loadPromptMel(voiceId),
    ]);
    console.log(
      `[VoiceBundle] Shared sessions + tokenizer + prompt mel ready (${
        ((performance.now() - t0) / 1000).toFixed(2)
      }s)`
    );

    // Tokenize the voice prompt once per voice.
    const tok = await tokenizer.textToTokenIds(promptText, "en-us");
    console.log(
      `[VoiceBundle] Tokenized prompt: ${tok.ids.length} phoneme ids, ` +
        `${tok.skippedChars.length} skipped chars`
    );

    // Precompute scaled prompt mel so per-sentence synth just memcpy's
    // it into the speech_condition buffer.
    const scaled = new Float32Array(promptMel.data.length);
    const s = promptMel.featScale;
    for (let i = 0; i < scaled.length; i++) scaled[i] = promptMel.data[i] * s;

    const bundle: VoiceBundle = {
      voiceId,
      sessions,
      tokenizer,
      promptMel,
      scaledPromptMel: scaled,
      promptTokens: tok.ids,
      promptPhonemes: tok.phonemes,
      skippedPromptChars: tok.skippedChars,
    };
    console.log(
      `[VoiceBundle] Ready — voiceId=${voiceId}, total=${
        ((performance.now() - t0) / 1000).toFixed(2)
      }s`
    );
    return bundle;
  })();

  promise.catch(() => {
    // On failure, let a retry rebuild this specific voice's bundle
    // without invalidating shared singletons (which may have succeeded).
    _voiceBundles.delete(voiceId);
  });
  _voiceBundles.set(voiceId, promise);
  return promise;
}

/** Drop a specific voice from the cache. Useful if the voice's
 *  prompt_text changed upstream and we need a fresh tokenize. */
export function invalidateVoiceBundle(voiceId: string): void {
  _voiceBundles.delete(voiceId);
}

/** Drop everything. Nuclear option if the shared ONNX versions bump. */
export function resetTtsCaches(): void {
  _voiceBundles.clear();
  _sharedSessionsPromise = null;
  _tokenizerPromise = null;
}
