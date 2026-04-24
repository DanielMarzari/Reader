// synthesizeSentence: takes a loaded VoiceBundle + a sentence of text,
// returns a Float32 audio waveform at 24 kHz. This is the factored-out,
// React-independent version of TtsTestClient's runPipeline — used both
// by the /tts-test diagnostic page and (via the BrowserInferenceProvider)
// by the real /reader/[id] page.
//
// One call per sentence. Streaming / pipelining is a higher-level
// concern and happens in the provider.

// Resolved to the WebGPU bundle via next.config.ts's turbopack alias.
import * as ort from "onnxruntime-web";
import {
  VOCOS_FREQ_BINS,
  VOCOS_ISTFT_CONFIG,
  istftVocos,
  transposeForIstft,
} from "@/lib/tts/istft";
import { scalarFloat, scalarInt64 } from "@/lib/tts/browser-inference";
import type { VoiceBundle } from "@/lib/tts/voice-bundle";

// ---------- Per-session serialization ----------
//
// ORT-Web's WebGPU backend is NOT safe against concurrent session.run()
// calls on the same InferenceSession — two overlapping runs corrupt
// each other's output buffers and produce errors like
//
//   "Can't access output tensor data on index 2. ERROR_CODE: 9,
//    ERROR_MESSAGE: Reading data from non-tensor typed value is not
//    supported."
//
// (seen on vocos when prefetch-next fires a second vocos.run() while
// the current one is still in flight).
//
// Fix: serialize calls per session via a promise-chain mutex. Per-
// session means different sessions (text_encoder vs fm_decoder vs
// vocos) can still run in parallel — that's safe, the sessions are
// independent. Only multiple calls to the SAME session queue.
//
// The mutex lives at module scope so prefetch + current-sentence
// synth, which run in separate async contexts, share the same lock
// per session instance.

const _sessionLocks = new WeakMap<ort.InferenceSession, Promise<unknown>>();

async function runSerialized(
  session: ort.InferenceSession,
  feeds: Record<string, ort.Tensor>
): Promise<ort.InferenceSession.OnnxValueMapType> {
  const prev = _sessionLocks.get(session) ?? Promise.resolve();
  const current = prev.then(() => session.run(feeds));
  // Swallow errors in the lock's promise chain so a failed run
  // doesn't poison all subsequent calls on this session.
  _sessionLocks.set(session, current.catch(() => {}));
  return current;
}

// --- ZipVoice-Distill inference constants (matched to
// zipvoice/bin/infer_zipvoice_onnx.py's default_values) ---
const N_MEL = 100;
export const NFE_STEPS = 8;
export const GUIDANCE_SCALE = 3.0;
const T_SHIFT = 0.5;

export type SynthTimings = {
  tokenizeMs: number;
  textEncoderMs: number;
  fmDecoderMs: number;
  fmDecoderStepsMs: number[];
  vocosMs: number;
  istftMs: number;
  totalMs: number;
  /** Duration of the resulting audio in seconds (numSamples / 24 kHz). */
  audioSec: number;
  /** audioSec / (totalMs / 1000) — >1 is faster than real-time. */
  realTimeFactor: number;
};

export type SynthResult = {
  /** Float32 mono waveform at 24 kHz. */
  samples: Float32Array;
  timings: SynthTimings;
  /** Phoneme string the tokenizer produced for the target text.
   *  Useful for debugging; Reader UI doesn't surface it. */
  phonemes: string;
  skippedChars: string[];
};

/** Time-step schedule matching ZipVoice's get_time_steps(t_shift=0.5).
 *  Returns N+1 floats from 0 to 1, biased toward small t. */
function getTimeSteps(numStep: number, tShift = T_SHIFT): Float32Array {
  const out = new Float32Array(numStep + 1);
  for (let i = 0; i <= numStep; i++) {
    const t = i / numStep;
    out[i] = (tShift * t) / (1 + (tShift - 1) * t);
  }
  return out;
}

/** Box-Muller gaussian. */
function gauss(): number {
  const u = Math.max(1e-10, Math.random());
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function fillGaussian(out: Float32Array) {
  for (let i = 0; i < out.length; i++) out[i] = gauss();
}

/** fm_decoder outputs mel as [1, T, 100]; Vocos wants [1, 100, T]. */
function transposeMelForVocos(x: Float32Array, t: number): Float32Array {
  const out = new Float32Array(N_MEL * t);
  for (let i = 0; i < t; i++) {
    for (let c = 0; c < N_MEL; c++) out[c * t + i] = x[i * N_MEL + c];
  }
  return out;
}

export async function synthesizeSentence(
  bundle: VoiceBundle,
  text: string
): Promise<SynthResult> {
  const t0 = performance.now();

  // --- Tokenize target (prompt already pre-tokenized in the bundle) ---
  const tokStart = performance.now();
  const target = await bundle.tokenizer.textToTokenIds(text, "en-us");
  const tokenizeMs = performance.now() - tokStart;

  // --- text_encoder ---
  const promptFeaturesLen = bundle.promptMel.numFrames;
  const teFeeds = {
    tokens: new ort.Tensor("int64", target.ids, [1, target.ids.length]),
    prompt_tokens: new ort.Tensor("int64", bundle.promptTokens, [
      1,
      bundle.promptTokens.length,
    ]),
    prompt_features_len: scalarInt64(promptFeaturesLen),
    speed: scalarFloat(1.0),
  };

  const teStart = performance.now();
  const teOut = await runSerialized(bundle.sessions.textEncoder, teFeeds);
  const textCondition = teOut.text_condition ?? teOut[Object.keys(teOut)[0]];
  const textEncoderMs = performance.now() - teStart;

  const [, numFrames, featDim] = textCondition.dims as [number, number, number];
  if (featDim !== N_MEL) {
    throw new Error(
      `text_encoder output feat_dim=${featDim}, expected ${N_MEL}`
    );
  }
  const targetFrames = numFrames - promptFeaturesLen;
  if (targetFrames <= 0) {
    throw new Error(
      `text_encoder produced only ${numFrames} frames, prompt alone needs ` +
        `${promptFeaturesLen}. Target text may be too short relative to prompt.`
    );
  }

  // --- Build x (noise) + speech_condition (scaled prompt + zeros) ---
  const totalLen = 1 * numFrames * N_MEL;
  let xData = new Float32Array(totalLen);
  fillGaussian(xData);

  const speechData = new Float32Array(totalLen);
  // Copy the pre-scaled prompt mel into the first promptFeaturesLen
  // frames. Remainder stays zeros.
  const promptLen = Math.min(promptFeaturesLen, bundle.promptMel.numFrames);
  speechData.set(
    bundle.scaledPromptMel.subarray(0, promptLen * N_MEL),
    0
  );
  const speechCondTensor = new ort.Tensor(
    "float32",
    speechData,
    [1, numFrames, N_MEL]
  );

  // --- fm_decoder × NFE_STEPS with t_shift schedule ---
  const timesteps = getTimeSteps(NFE_STEPS, T_SHIFT);
  const fmStart = performance.now();
  const fmDecoderStepsMs: number[] = [];
  for (let step = 0; step < NFE_STEPS; step++) {
    const xTensor = new ort.Tensor("float32", xData, [
      1,
      numFrames,
      N_MEL,
    ]);
    const fmFeeds = {
      t: scalarFloat(timesteps[step]),
      x: xTensor,
      text_condition: textCondition,
      speech_condition: speechCondTensor,
      guidance_scale: scalarFloat(GUIDANCE_SCALE),
    };
    const stepT0 = performance.now();
    const fmOut = await runSerialized(bundle.sessions.fmDecoder, fmFeeds);
    const v = fmOut.v ?? fmOut[Object.keys(fmOut)[0]];
    fmDecoderStepsMs.push(performance.now() - stepT0);

    const dt = timesteps[step + 1] - timesteps[step];
    const vData = v.data as Float32Array;
    const newX = new Float32Array(xData.length);
    for (let i = 0; i < xData.length; i++) newX[i] = xData[i] + dt * vData[i];
    xData = newX;
  }
  const fmDecoderMs = performance.now() - fmStart;

  // --- Slice off prompt frames, un-scale feat_scale ---
  const scale = bundle.promptMel.featScale;
  const genMel = new Float32Array(targetFrames * N_MEL);
  for (let i = 0; i < targetFrames; i++) {
    const srcRow = (promptFeaturesLen + i) * N_MEL;
    const dstRow = i * N_MEL;
    for (let c = 0; c < N_MEL; c++) {
      genMel[dstRow + c] = xData[srcRow + c] / scale;
    }
  }

  // --- Vocos: mel → (mag, cos(phase), sin(phase)) ---
  const melForVocos = transposeMelForVocos(genMel, targetFrames);
  const vocosFeeds = {
    mels: new ort.Tensor("float32", melForVocos, [1, N_MEL, targetFrames]),
  };
  const vocosStart = performance.now();
  const vocosOut = await runSerialized(bundle.sessions.vocos, vocosFeeds);
  const vocosMs = performance.now() - vocosStart;

  const mag = vocosOut.mag ?? vocosOut[Object.keys(vocosOut)[0]];
  const cx = vocosOut.x ?? vocosOut[Object.keys(vocosOut)[1]];
  const sy = vocosOut.y ?? vocosOut[Object.keys(vocosOut)[2]];

  const magData = transposeForIstft(
    mag.data as Float32Array,
    VOCOS_FREQ_BINS,
    targetFrames
  );
  const cosData = transposeForIstft(
    cx.data as Float32Array,
    VOCOS_FREQ_BINS,
    targetFrames
  );
  const sinData = transposeForIstft(
    sy.data as Float32Array,
    VOCOS_FREQ_BINS,
    targetFrames
  );

  // --- iSTFT (JS) ---
  const istftStart = performance.now();
  const samples = istftVocos({
    mag: magData,
    cosPhase: cosData,
    sinPhase: sinData,
    numFrames: targetFrames,
  });
  const istftMs = performance.now() - istftStart;

  const totalMs = performance.now() - t0;
  const audioSec = samples.length / VOCOS_ISTFT_CONFIG.sampleRate;

  return {
    samples,
    phonemes: target.phonemes,
    skippedChars: target.skippedChars,
    timings: {
      tokenizeMs,
      textEncoderMs,
      fmDecoderMs,
      fmDecoderStepsMs,
      vocosMs,
      istftMs,
      totalMs,
      audioSec,
      realTimeFactor: audioSec / (totalMs / 1000),
    },
  };
}
