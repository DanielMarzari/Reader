// Load + parse a voice's prompt_mel asset.
//
// prompt_mel.f32 is a packed little-endian Float32 blob shaped
// (num_frames, 100), produced server-side by
// backend/scripts/compute_prompt_mel.py in Voice Studio.
// prompt_mel_meta.json lives next to it with the concrete num_frames
// + feat_scale + SHA-256.
//
// Both are voice-specific (per-voice-id). They're cached per voice in
// the same Cache Storage bucket as the ONNX models, so first use pays
// the ~240 KB download and subsequent synthesis hits the cache.

import { VOICE_ASSET_BASE } from "@/lib/tts/browser-inference";

const CACHE_NAME = "reader-tts-v1";

export type PromptMel = {
  voiceId: string;
  /** Log-mel Float32, shape (numFrames, nMels). Time-major layout to
   *  match the browser's preferred row-major access. */
  data: Float32Array;
  numFrames: number;
  nMels: number;
  /** Scale factor applied to the mel before feeding to fm_decoder
   *  (0.1 per ZipVoice). Also applied to the output mel in reverse
   *  before vocos. We store it on the asset so clients don't hard-code. */
  featScale: number;
  /** Mel frames per hop_length = prompt duration in samples.
   *  numFrames × hopLength / sampleRate = prompt audio length in sec. */
  hopLength: number;
  sampleRate: number;
};

export type PromptMelMeta = {
  num_frames: number;
  n_mels: number;
  sample_rate: number;
  hop_length: number;
  feat_scale: number;
  target_rms: number;
  byte_size: number;
  sha256: string;
};

function baseUrl(voiceId: string): string {
  // Normalize trailing slash
  const base = VOICE_ASSET_BASE.endsWith("/")
    ? VOICE_ASSET_BASE.slice(0, -1)
    : VOICE_ASSET_BASE;
  return `${base}/${voiceId}`;
}

/** Fetch the asset (with Cache Storage), verifying it against the
 *  metadata's byte_size so we catch truncated downloads. */
async function fetchF32Cached(url: string, expectedBytes: number): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) return cached.arrayBuffer();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  const buf = await r.arrayBuffer();
  if (expectedBytes && buf.byteLength !== expectedBytes) {
    throw new Error(
      `${url}: got ${buf.byteLength} bytes, meta said ${expectedBytes}`
    );
  }
  await cache.put(url, new Response(buf));
  return buf;
}

/** Load the prompt_mel for a voice. Resolves after both the meta JSON
 *  and the binary .f32 are in hand + validated. */
export async function loadPromptMel(voiceId: string): Promise<PromptMel> {
  const metaUrl = `${baseUrl(voiceId)}/prompt_mel_meta.json`;
  const dataUrl = `${baseUrl(voiceId)}/prompt_mel.f32`;

  const metaResp = await fetch(metaUrl);
  if (!metaResp.ok) {
    throw new Error(
      `prompt_mel_meta.json missing for voice ${voiceId}: ${metaResp.status}. ` +
        `Run backend/scripts/compute_prompt_mel.py --profile ${voiceId} in Voice Studio.`
    );
  }
  const meta: PromptMelMeta = await metaResp.json();

  const buf = await fetchF32Cached(dataUrl, meta.byte_size);
  // Wrap the ArrayBuffer as a Float32Array (zero-copy view).
  const data = new Float32Array(buf);
  if (data.length !== meta.num_frames * meta.n_mels) {
    throw new Error(
      `prompt_mel shape mismatch: ${data.length} floats, expected ` +
        `${meta.num_frames * meta.n_mels}`
    );
  }

  return {
    voiceId,
    data,
    numFrames: meta.num_frames,
    nMels: meta.n_mels,
    featScale: meta.feat_scale,
    hopLength: meta.hop_length,
    sampleRate: meta.sample_rate,
  };
}
