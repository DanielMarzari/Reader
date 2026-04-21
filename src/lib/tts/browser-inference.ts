// Browser-native inference orchestration for ZipVoice-Distill.
//
// Three ONNX sessions cooperate to turn text + a voice prompt into audio:
//
//   text_encoder  (tokens, prompt_tokens, prompt_features_len, speed)
//     -> text_condition [N, T, 100]
//
//   fm_decoder (called 4 times — ZipVoice-Distill uses 4 NFE)
//     (t, x, text_condition, speech_condition, guidance_scale)
//     -> velocity [N, T, 100]
//
//   vocos  (mel from the flow sampler)
//     -> (mag, cos(phase), sin(phase)) [N, 513, T]
//     Followed by JS iSTFT in ./istft.ts -> audio waveform
//
// This module handles session creation, model loading (with Cache Storage
// so the ~150 MB blob downloads once per browser), WebGPU/WASM provider
// selection, and progress reporting. It does NOT run the flow sampler or
// assemble the full pipeline — that's flow-sampler.ts's job. Keeping the
// concerns split so we can unit-test session loading independently.
//
// Spike B findings baked in:
//   - WebGPU has an ORT-Web kernel bug on Zipformer conv_module out_proj
//     MatMul (both FP32 and INT8). We try WebGPU first and fall back to
//     WASM silently on failure.
//   - Multi-threaded WASM (COOP/COEP set in next.config.ts) should give
//     ~2x real-time for a sentence.
//   - INT8 is what we ship: 124 MB fm_decoder vs 455 MB FP32, ~4x smaller
//     download with equivalent speed on CPU/WASM. (FP32 is ~2x faster on
//     NVIDIA GPUs via WebGPU, but our bug-workaround path is WASM.)

// Plain `onnxruntime-web` import — but next.config.ts's
// turbopack.resolveAlias redirects it to
// `onnxruntime-web/dist/ort.webgpu.bundle.min.mjs` (the WebGPU bundle,
// which actually registers the JSEP backend). The default entry
// doesn't. Turbopack can't resolve the `./webgpu` subpath from the
// package's exports map, hence the alias workaround.
import * as ort from "onnxruntime-web";

// ---------- Config ----------

/** Base URL where the shared (voice-independent) ONNX + configs live.
 *  In dev we serve them from the Voice Studio's local cache via a
 *  symlink or proxy; in prod they live at /shared/ on Oracle. */
export const SHARED_ASSET_BASE =
  process.env.NEXT_PUBLIC_TTS_SHARED_BASE ?? "/tts-assets/shared";

/** Base URL where per-voice models live.  */
export const VOICE_ASSET_BASE =
  process.env.NEXT_PUBLIC_TTS_VOICE_BASE ?? "/tts-assets/voices";

/** Cache Storage name for TTS blobs. Bumping this key invalidates
 *  every cached model — use for big version jumps. v2 adds FP32 as
 *  the default precision. */
const CACHE_NAME = "reader-tts-v2";

/** Where ORT-Web loads its own WASM backend + threaded worker from.
 *
 *  Was jsdelivr, but under COEP: require-corp the browser rejected one
 *  of ORT's own cross-origin fetches (the threaded worker proxy, which
 *  loads the .wasm via a dynamic fetch inside the worker context that
 *  doesn't inherit the main document's COEP trust). Hosting these few
 *  files same-origin from /ort/ sidesteps every cross-origin-isolation
 *  edge case. npm scripts in package.json copy the files from
 *  node_modules/onnxruntime-web/dist/ to public/ort/ on dev/build. */
const ORT_DIST_BASE = "/ort/";

// ---------- ORT environment init ----------

let _ortConfigured = false;

/** Configure ORT-Web's runtime once per page load. Must run before
 *  creating the first InferenceSession. */
export function configureOrt() {
  if (_ortConfigured) return;

  // ORT's graph-loader logs warnings like "Some nodes were not
  // assigned to the preferred execution providers" whenever any op
  // falls back from WebGPU/JSEP to CPU — which is NORMAL and
  // intentional (shape ops prefer CPU). Next.js dev mode surfaces
  // every ORT warning as a full-screen modal error overlay, which
  // is both confusing and screen-blocking. Silence ORT below the
  // error level.
  ort.env.logLevel = "error";

  // String prefix form: ORT appends the right filename for whichever
  // backend it's loading — `ort-wasm-simd-threaded.jsep.{mjs,wasm}` for
  // WebGPU (JSEP), `ort-wasm-simd-threaded.{mjs,wasm}` for plain WASM.
  //
  // We tried the object form earlier (keys `mjs` + `wasm`) to dodge
  // a Turbopack resolution issue, but that binds ORT to ONE set of
  // files — so when WebGPU was requested, ORT loaded the non-JSEP
  // backend and silently fell back to WASM. Back to the prefix form
  // now that `proxy = false` dodges the worker-creation path that
  // originally caused the Turbopack issue.
  ort.env.wasm.wasmPaths = ORT_DIST_BASE;

  // Single-threaded on main thread. Known-good config; we pay the
  // Spike-B pessimistic WASM numbers (~0.6× RT) in exchange for dodging
  // the Turbopack + worker-proxy + `import.meta.url` fight that costs
  // us an entire day of plumbing otherwise. Revisit threading after
  // the full pipeline is proven end-to-end.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;

  _ortConfigured = true;
}

// ---------- Capability detection ----------

export type WebGpuSupport = {
  available: boolean;
  /** Human-readable adapter info when available. */
  adapterInfo?: string;
  /** Reason WebGPU is unusable, if unavailable. */
  reason?: string;
};

// Minimal WebGPU type fragment so we don't need @webgpu/types as a hard
// dep. Covers only the adapter-info surface we actually use.
type MinimalGpuAdapterInfo = {
  description?: string;
  vendor?: string;
  architecture?: string;
};
type MinimalGpuAdapter = { info?: MinimalGpuAdapterInfo };
type MinimalGpu = { requestAdapter: () => Promise<MinimalGpuAdapter | null> };

export async function detectWebGpu(): Promise<WebGpuSupport> {
  if (typeof navigator === "undefined" || !("gpu" in navigator)) {
    return { available: false, reason: "navigator.gpu missing" };
  }
  try {
    const gpu = (navigator as unknown as { gpu: MinimalGpu }).gpu;
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return { available: false, reason: "requestAdapter returned null" };
    }
    const info = adapter.info ?? {};
    const label =
      info.description || info.vendor || info.architecture || "(unknown)";
    return { available: true, adapterInfo: String(label) };
  } catch (e) {
    return { available: false, reason: (e as Error).message };
  }
}

// ---------- Cached blob download with progress ----------

export type DownloadProgress = {
  url: string;
  bytesReceived: number;
  bytesTotal: number | null;
  /** 0–1, or null if total unknown. */
  fraction: number | null;
};

type OnProgress = (p: DownloadProgress) => void;

/** Fetch a URL with Cache Storage lookup + progress callbacks.
 *  Returns the resource as an ArrayBuffer. Large blobs (hundreds of MB)
 *  land here, so we reuse the ArrayBuffer directly when creating the
 *  ORT session instead of re-reading from the cache. */
export async function fetchCachedWithProgress(
  url: string,
  onProgress?: OnProgress
): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) {
    // Cached — report a single "100%" event then return bytes.
    const buf = await cached.arrayBuffer();
    onProgress?.({
      url,
      bytesReceived: buf.byteLength,
      bytesTotal: buf.byteLength,
      fraction: 1,
    });
    return buf;
  }

  // Not cached: stream the download, mirror into Cache Storage.
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Fetch ${url} failed: ${resp.status} ${resp.statusText}`);
  }
  const total = Number(resp.headers.get("Content-Length")) || null;
  const reader = resp.body?.getReader();
  if (!reader) {
    // No streaming reader (very old browser): fall back to full buffer.
    const buf = await resp.arrayBuffer();
    await cache.put(url, new Response(buf));
    onProgress?.({
      url,
      bytesReceived: buf.byteLength,
      bytesTotal: total,
      fraction: total ? buf.byteLength / total : 1,
    });
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.({
      url,
      bytesReceived: received,
      bytesTotal: total,
      fraction: total ? received / total : null,
    });
  }

  // Concatenate chunks into a single ArrayBuffer
  const merged = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) {
    merged.set(c, pos);
    pos += c.byteLength;
  }

  // Store a copy in Cache Storage. Use a fresh Response so the body
  // isn't already consumed.
  await cache.put(url, new Response(merged.buffer));

  return merged.buffer;
}

// ---------- Voice + shared asset manifest ----------

export type VoiceAssets = {
  voiceId: string;
  /** Text the voice-prompt clip says (from the Voice Studio Clone tab's
   *  Whisper auto-transcript). Passed into text_encoder as prompt_tokens. */
  promptText: string;
  /** Ref-clip mel spectrogram as raw Float32 samples in shape [T, 100].
   *  TBD: we haven't computed this server-side yet. Phase 3's next step
   *  is to ship a `prompt_mel.f32` or similar alongside each voice. For
   *  now, browser code can fall back to zero-init (poor quality but
   *  proves the pipeline). */
  promptMelUrl?: string;
};

export type SharedAssets = {
  fmDecoderUrl: string;
  textEncoderUrl: string;
  vocosUrl: string;
  tokensUrl: string;
  modelJsonUrl: string;
};

/** Which precision variant of each model to ship. INT8 is ~4× smaller
 *  download (119 MB vs 455 MB for fm_decoder) but noticeably degrades
 *  zero-shot voice quality — Dan A/B'd FP32 against Spike D's Felix-
 *  GREEN reference and INT8 lost detail / clarity. We default to FP32
 *  for quality; revisit INT8 once we have threading + WebGPU kernel
 *  wins closing the speed gap (INT8 would save ~5-10 seconds on first
 *  load but nothing on subsequent Cache Storage hits).
 *
 *  Vocos stays FP16 — parity vs PyTorch FP32 is 6.5e-5 RMS, audibly
 *  indistinguishable (see backend/data/models/vocos_meta.json in the
 *  Voice repo). */
export type PrecisionVariant = "fp32" | "int8";
export const DEFAULT_PRECISION: PrecisionVariant = "fp32";

export function defaultSharedAssets(
  precision: PrecisionVariant = DEFAULT_PRECISION
): SharedAssets {
  const suffix = precision === "int8" ? "_int8" : "";
  return {
    fmDecoderUrl: `${SHARED_ASSET_BASE}/fm_decoder${suffix}.onnx`,
    textEncoderUrl: `${SHARED_ASSET_BASE}/text_encoder${suffix}.onnx`,
    vocosUrl: `${SHARED_ASSET_BASE}/vocos_fp16.onnx`,
    tokensUrl: `${SHARED_ASSET_BASE}/tokens.txt`,
    modelJsonUrl: `${SHARED_ASSET_BASE}/model.json`,
  };
}

// ---------- Session bundle ----------

export type TtsSessions = {
  textEncoder: ort.InferenceSession;
  fmDecoder: ort.InferenceSession;
  vocos: ort.InferenceSession;
  /** The execution provider that actually succeeded, for debugging. */
  provider: "webgpu" | "wasm";
};

/** Load all three ONNX sessions. Tries WebGPU first on all three; if
 *  ANY of them fail to create or we hit the known Zipformer kernel bug,
 *  we rebuild the whole set on WASM. */
export async function createSessions(
  shared: SharedAssets,
  onProgress?: OnProgress
): Promise<TtsSessions> {
  configureOrt();

  // Fetch all three ONNX blobs in parallel.
  const [textEncoderBuf, fmDecoderBuf, vocosBuf] = await Promise.all([
    fetchCachedWithProgress(shared.textEncoderUrl, onProgress),
    fetchCachedWithProgress(shared.fmDecoderUrl, onProgress),
    fetchCachedWithProgress(shared.vocosUrl, onProgress),
  ]);

  const tryProviders = async (
    providers: Array<"webgpu" | "wasm">
  ): Promise<TtsSessions> => {
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: providers,
      graphOptimizationLevel: "all",
    };
    const [textEncoder, fmDecoder, vocos] = await Promise.all([
      ort.InferenceSession.create(textEncoderBuf, opts),
      ort.InferenceSession.create(fmDecoderBuf, opts),
      ort.InferenceSession.create(vocosBuf, opts),
    ]);
    return { textEncoder, fmDecoder, vocos, provider: providers[0] };
  };

  // Try WebGPU first, fall back to WASM if session creation fails
  // (no WebGPU adapter, known Zipformer kernel bug, or anything
  // else). On ORT-Web 1.23.2 — picked as a middle-ground above
  // 1.19.2 (where the kernel bug bit) and below 1.24.3 (which
  // fails at module load under Turbopack). If 1.23's op coverage
  // has advanced past the 1.19 Zipformer MatMul bug, WebGPU will
  // load and run end-to-end. Otherwise we silently WASM-fallback
  // and stay at the B9 baseline.
  try {
    return await tryProviders(["webgpu", "wasm"]);
  } catch (e) {
    console.warn(
      "[tts] WebGPU session creation failed, falling back to WASM-only:",
      e
    );
    return await tryProviders(["wasm"]);
  }
}

// ---------- Tensor helpers ----------

export function scalarFloat(value: number): ort.Tensor {
  return new ort.Tensor("float32", new Float32Array([value]), []);
}

export function scalarInt64(value: bigint | number): ort.Tensor {
  const v = typeof value === "bigint" ? value : BigInt(Math.floor(value));
  return new ort.Tensor("int64", new BigInt64Array([v]), []);
}
