"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as ort from "onnxruntime-web";
import {
  configureOrt,
  defaultSharedAssets,
  detectWebGpu,
  createSessions,
  scalarFloat,
  scalarInt64,
  type TtsSessions,
  type DownloadProgress,
} from "@/lib/tts/browser-inference";
import {
  VOCOS_ISTFT_CONFIG,
  VOCOS_FREQ_BINS,
  istftVocos,
  transposeForIstft,
} from "@/lib/tts/istft";
import { ZipVoiceTokenizer } from "@/lib/tts/tokenizer";
import { loadPromptMel, type PromptMel } from "@/lib/tts/prompt-mel";

// ---------- Config ----------

const N_MEL = 100;
// ZipVoice's infer_zipvoice_onnx.py hard-codes these per model variant
// (see `default_values` dict at the bottom of that file):
//   zipvoice          → num_step=16, guidance_scale=1.0
//   zipvoice_distill  → num_step=8,  guidance_scale=3.0
// The distill paper claims "competitive at 4 NFE" but ships the official
// CLI at 8 for quality headroom. We match the official defaults because
// when Dan A/B'd these against Spike D's Felix-GREEN output, 4 NFE +
// guidance=1.0 produced low-quality speech where 8 + 3.0 didn't.
const NFE_STEPS = 8;
const GUIDANCE_SCALE = 3.0;
const T_SHIFT = 0.5; // ZipVoice default, emphasizes low-SNR region

/** The one hardcoded voice for the dev harness until the UI supports
 *  picking from the Reader voice library. Symlinked into public/tts-assets/
 *  voices/<id>/ by the one-off compute_prompt_mel.py run. */
const DEFAULT_VOICE_ID = "0e97772fe314"; // Alex

const DEFAULT_TEXT = "The morning light filtered through the kitchen blinds.";
const DEFAULT_PROMPT_TEXT =
  "Hello, I can provide conversational narration in English with an authentic European French accent.";

/** Time-step schedule for the ODE solver. Port of
 *  zipvoice.models.modules.solver.get_time_steps. Returns an array of
 *  length N+1. t_shift < 1 biases toward smaller t (low-SNR region). */
function getTimeSteps(numStep: number, tShift = T_SHIFT): Float32Array {
  const out = new Float32Array(numStep + 1);
  for (let i = 0; i <= numStep; i++) {
    const t = i / numStep; // linear 0..1
    out[i] = (tShift * t) / (1 + (tShift - 1) * t);
  }
  return out;
}

/** Box-Muller: 2 uniform → 1 unit-Gaussian sample.  */
function gauss(): number {
  const u = Math.max(1e-10, Math.random());
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Fill a buffer with gaussian noise in-place. */
function fillGaussian(out: Float32Array) {
  for (let i = 0; i < out.length; i++) out[i] = gauss();
}

type LogLine = { text: string; ts: number; kind: "info" | "ok" | "err" };

// ---------- Component ----------

export function TtsTestClient() {
  const [caps, setCaps] = useState<{
    webgpu: boolean;
    adapter?: string;
    sab: boolean;
    coop: boolean;
  } | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState<false | "download" | "session" | "run">(
    false
  );
  const [sessions, setSessions] = useState<TtsSessions | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [dlProgress, setDlProgress] = useState<Record<string, DownloadProgress>>(
    {}
  );
  const [text, setText] = useState(DEFAULT_TEXT);
  const [promptText, setPromptText] = useState(DEFAULT_PROMPT_TEXT);
  const [tokenizer, setTokenizer] = useState<ZipVoiceTokenizer | null>(null);
  const [promptMel, setPromptMel] = useState<PromptMel | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);

  const append = useCallback(
    (text: string, kind: LogLine["kind"] = "info") => {
      setLog((ls) => [...ls, { text, ts: Date.now(), kind }]);
    },
    []
  );

  // Detect environment capabilities once
  useEffect(() => {
    (async () => {
      const g = await detectWebGpu();
      const sab = typeof SharedArrayBuffer !== "undefined";
      const coop =
        typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : false;
      setCaps({
        webgpu: g.available,
        adapter: g.adapterInfo,
        sab,
        coop,
      });
      append(
        `WebGPU: ${g.available ? "✓ " + g.adapterInfo : "✗ " + (g.reason ?? "")}`,
        g.available ? "ok" : "info"
      );
      append(
        `SharedArrayBuffer: ${sab ? "✓" : "✗"} · crossOriginIsolated: ${
          coop ? "✓" : "✗"
        }`,
        sab && coop ? "ok" : "info"
      );
      configureOrt();
    })();
  }, [append]);

  // ---------- Load models ----------

  const loadModels = useCallback(async () => {
    if (sessions || loading) return;
    setLoading("download");
    append("Downloading ONNX models + tokenizer vocab + voice prompt_mel…");
    try {
      const shared = defaultSharedAssets();
      const [s, tok, pmel] = await Promise.all([
        createSessions(shared, (p) => {
          setDlProgress((prev) => ({ ...prev, [p.url]: p }));
        }),
        (async () => {
          const t = new ZipVoiceTokenizer();
          await t.loadVocab(shared.tokensUrl);
          return t;
        })(),
        loadPromptMel(DEFAULT_VOICE_ID),
      ]);
      setSessions(s);
      setTokenizer(tok);
      setPromptMel(pmel);
      append(
        `Sessions ready on ${s.provider} EP · text_encoder: ${s.textEncoder.inputNames.join(
          ", "
        )}`,
        "ok"
      );
      append(
        `fm_decoder inputs: ${s.fmDecoder.inputNames.join(", ")}`,
        "ok"
      );
      append(`vocos inputs: ${s.vocos.inputNames.join(", ")}`, "ok");
      append(`tokenizer vocab: ${tok.vocabSize()} entries`, "ok");
      append(
        `prompt_mel for ${pmel.voiceId}: ${pmel.numFrames} frames × ` +
          `${pmel.nMels} mels (${
            (pmel.numFrames * pmel.hopLength) / pmel.sampleRate
          }s prompt audio, feat_scale=${pmel.featScale})`,
        "ok"
      );
    } catch (e) {
      append(`Load failed: ${(e as Error).message}`, "err");
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [sessions, loading, append]);

  // ---------- Run end-to-end pipeline ----------

  const runPipeline = useCallback(async () => {
    if (!sessions || !tokenizer || !promptMel || loading) return;
    setLoading("run");
    setAudioUrl(null);

    try {
      const t0 = performance.now();

      // --- 0. Tokenize text + prompt text ---
      const tTokStart = performance.now();
      const [target, prompt] = await Promise.all([
        tokenizer.textToTokenIds(text, "en-us"),
        tokenizer.textToTokenIds(promptText, "en-us"),
      ]);
      const tokMs = performance.now() - tTokStart;
      append(
        `  tokenize (${tokMs.toFixed(0)} ms) · phonemes: "${target.phonemes}"`,
        "ok"
      );
      append(`    prompt phonemes: "${prompt.phonemes}"`);
      append(
        `    target=${target.ids.length} tokens · prompt=${prompt.ids.length} tokens`
      );
      if (target.skippedChars.length + prompt.skippedChars.length > 0) {
        append(
          `    ⚠ ${target.skippedChars.length + prompt.skippedChars.length} ` +
            `unknown char(s) skipped: ${JSON.stringify([
              ...new Set([...target.skippedChars, ...prompt.skippedChars]),
            ])}`,
          "info"
        );
      }

      // --- 1. text_encoder ---
      // Real prompt_features_len comes from the loaded prompt_mel asset.
      // Output num_frames is decided by the model based on prompt_features_len
      // + tokens + speed — we don't pick it, we read it from the output.
      const promptFeaturesLen = promptMel.numFrames;
      const teFeeds = {
        tokens: new ort.Tensor("int64", target.ids, [1, target.ids.length]),
        prompt_tokens: new ort.Tensor("int64", prompt.ids, [
          1,
          prompt.ids.length,
        ]),
        prompt_features_len: scalarInt64(promptFeaturesLen),
        speed: scalarFloat(1.0),
      };

      const tTextStart = performance.now();
      const teOut = await sessions.textEncoder.run(teFeeds);
      const textCondition = teOut.text_condition ?? teOut[Object.keys(teOut)[0]];
      const [, numFrames, featDim] = textCondition.dims as [number, number, number];
      append(
        `  text_encoder: ${(performance.now() - tTextStart).toFixed(0)} ms · ` +
          `output [1, ${numFrames}, ${featDim}]`
      );
      if (featDim !== N_MEL) {
        append(
          `  ⚠ text_encoder output feat_dim=${featDim}, expected ${N_MEL}`,
          "info"
        );
      }
      const targetFrames = numFrames - promptFeaturesLen;
      if (targetFrames <= 0) {
        throw new Error(
          `text_encoder produced ${numFrames} frames, but prompt_features_len ` +
            `is ${promptFeaturesLen} — no target frames left. Is the prompt ` +
            `audio way too long relative to the target text?`
        );
      }
      append(
        `    prompt=${promptFeaturesLen} frames · target=${targetFrames} frames · total=${numFrames}`
      );

      // --- 2. Build x (gaussian noise) + speech_condition ([prompt_mel*scale, zeros]) ---
      const totalLen = 1 * numFrames * N_MEL;
      let xData = new Float32Array(totalLen);
      fillGaussian(xData);

      const speechData = new Float32Array(totalLen);
      // First promptFeaturesLen frames = prompt mel × feat_scale.
      // Remaining targetFrames × N_MEL = already zeros.
      const scale = promptMel.featScale;
      const promptLen = Math.min(promptFeaturesLen, promptMel.numFrames);
      for (let i = 0; i < promptLen; i++) {
        for (let c = 0; c < N_MEL; c++) {
          speechData[i * N_MEL + c] =
            promptMel.data[i * N_MEL + c] * scale;
        }
      }
      const speechCondTensor = new ort.Tensor(
        "float32",
        speechData,
        [1, numFrames, N_MEL]
      );

      // --- 3. fm_decoder × NFE_STEPS with Euler + t_shift schedule ---
      const timesteps = getTimeSteps(NFE_STEPS, T_SHIFT);
      append(
        `  timesteps (t_shift=${T_SHIFT}): ${Array.from(timesteps)
          .map((t) => t.toFixed(3))
          .join(", ")}`
      );
      let totalFmMs = 0;
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
        const tFmStart = performance.now();
        const fmOut = await sessions.fmDecoder.run(fmFeeds);
        const v = fmOut.v ?? fmOut[Object.keys(fmOut)[0]];
        const stepMs = performance.now() - tFmStart;
        totalFmMs += stepMs;
        append(
          `  fm_decoder step ${step + 1}/${NFE_STEPS} (t=${timesteps[step].toFixed(3)}): ${stepMs.toFixed(0)} ms`
        );

        const dtFlow = timesteps[step + 1] - timesteps[step];
        const vData = v.data as Float32Array;
        const newX = new Float32Array(xData.length);
        for (let i = 0; i < xData.length; i++) newX[i] = xData[i] + dtFlow * vData[i];
        xData = newX;
      }

      // --- 4. Slice off prompt frames, un-scale feat_scale, feed to vocos ---
      // xData is row-major [numFrames, N_MEL]. Slice out frames
      // [promptFeaturesLen, numFrames).
      const genMel = new Float32Array(targetFrames * N_MEL);
      for (let i = 0; i < targetFrames; i++) {
        const srcRow = (promptFeaturesLen + i) * N_MEL;
        const dstRow = i * N_MEL;
        for (let c = 0; c < N_MEL; c++) {
          genMel[dstRow + c] = xData[srcRow + c] / scale; // un-scale
        }
      }

      // --- 5. Vocos: mel → (mag, cos, sin). Vocos wants [1, 100, T]. ---
      const melForVocos = transposeMelForVocos(genMel, targetFrames, N_MEL);
      const vocosFeeds = {
        mels: new ort.Tensor("float32", melForVocos, [1, N_MEL, targetFrames]),
      };
      const tVocosStart = performance.now();
      const vocosOut = await sessions.vocos.run(vocosFeeds);
      append(`  vocos: ${(performance.now() - tVocosStart).toFixed(0)} ms`);

      // Outputs are shaped [1, 513, T] in frequency-major order.
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

      // --- 6. iSTFT (JS) ---
      const tIstftStart = performance.now();
      const audioSamples = istftVocos({
        mag: magData,
        cosPhase: cosData,
        sinPhase: sinData,
        numFrames: targetFrames,
      });
      append(
        `  iSTFT (JS): ${(performance.now() - tIstftStart).toFixed(0)} ms · ` +
          `${audioSamples.length} samples`
      );

      // --- 5. Play via Web Audio + expose a download link ---
      const totalMs = performance.now() - t0;
      const audioSec = audioSamples.length / VOCOS_ISTFT_CONFIG.sampleRate;
      const rtFactor = audioSec / (totalMs / 1000);
      append(
        `✓ Total: ${totalMs.toFixed(0)} ms · ~${audioSec.toFixed(2)}s audio · ` +
          `${rtFactor.toFixed(2)}× real-time on ${sessions.provider}`,
        "ok"
      );

      const wavBytes = encodeWav(
        audioSamples,
        VOCOS_ISTFT_CONFIG.sampleRate
      );
      const blob = new Blob([wavBytes], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);

      // Also play it directly. Chrome suspends AudioContexts that weren't
      // created in direct response to a user gesture; even though the
      // "Run" button click IS a gesture, by the time we get here we're
      // several await ticks past it and Chrome may have already put the
      // context to sleep. Explicit resume() is cheap and safe.
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext({
          sampleRate: VOCOS_ISTFT_CONFIG.sampleRate,
        });
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      const buf = ctx.createBuffer(1, audioSamples.length, ctx.sampleRate);
      // copyToChannel's signature in recent TS lib.dom.d.ts pins the typed-
      // array backing store to ArrayBuffer (not SharedArrayBuffer). Float32
      // samples we built above might be inferred with a broader
      // ArrayBufferLike. Cast through Float32Array<ArrayBuffer> to satisfy
      // the strict overload; at runtime the bytes are identical.
      buf.copyToChannel(
        audioSamples as unknown as Float32Array<ArrayBuffer>,
        0
      );
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
      append(`  audio: ${ctx.state} · playing ${audioSec.toFixed(2)}s`, "ok");
    } catch (e) {
      append(`Run failed: ${(e as Error).message}`, "err");
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [sessions, loading, append]);

  // ---------- Render ----------

  return (
    <div className="space-y-4">
      <CapsPanel caps={caps} />

      <div className="space-y-2">
        <label className="block text-xs text-slate-400">
          Voice-prompt text (what the reference clip says — for now, used to
          shape phoneme-to-frame ratio; real prompt_mel comes in the next
          milestone)
          <textarea
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            rows={2}
            disabled={loading !== false}
            className="mt-1 w-full rounded bg-slate-900 border border-slate-700 p-2 text-sm text-slate-100 disabled:opacity-50 font-mono"
          />
        </label>
        <label className="block text-xs text-slate-400">
          Text to synthesize
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            disabled={loading !== false}
            className="mt-1 w-full rounded bg-slate-900 border border-slate-700 p-2 text-sm text-slate-100 disabled:opacity-50 font-mono"
          />
        </label>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={loadModels}
          disabled={!!sessions || loading !== false}
          className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium"
        >
          {sessions
            ? "1. Loaded ✓"
            : loading === "download"
            ? "Loading…"
            : "1. Load ONNX sessions (~150 MB first time)"}
        </button>
        <button
          onClick={runPipeline}
          disabled={!sessions || loading !== false || !text.trim()}
          className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium"
        >
          {loading === "run" ? "Running…" : "2. Run end-to-end"}
        </button>
        {audioUrl && (
          <a
            href={audioUrl}
            download="tts-test.wav"
            className="text-xs text-indigo-300 underline"
          >
            Download WAV
          </a>
        )}
      </div>

      {Object.keys(dlProgress).length > 0 && !sessions && (
        <DownloadProgressList items={Object.values(dlProgress)} />
      )}

      <LogPanel lines={log} />
    </div>
  );
}

// ---------- Sub-components ----------

function CapsPanel({
  caps,
}: {
  caps: {
    webgpu: boolean;
    adapter?: string;
    sab: boolean;
    coop: boolean;
  } | null;
}) {
  if (!caps) return null;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3 text-xs">
      <div>
        <span className="text-slate-400">WebGPU:</span>{" "}
        {caps.webgpu ? (
          <span className="text-green-400">✓ {caps.adapter}</span>
        ) : (
          <span className="text-amber-400">✗ — will use WASM fallback</span>
        )}
      </div>
      <div>
        <span className="text-slate-400">SharedArrayBuffer:</span>{" "}
        {caps.sab ? (
          <span className="text-green-400">✓ (multi-threaded WASM enabled)</span>
        ) : (
          <span className="text-red-400">
            ✗ — check COOP/COEP in next.config.ts
          </span>
        )}
      </div>
      <div>
        <span className="text-slate-400">crossOriginIsolated:</span>{" "}
        {caps.coop ? (
          <span className="text-green-400">✓</span>
        ) : (
          <span className="text-red-400">✗</span>
        )}
      </div>
    </div>
  );
}

function DownloadProgressList({ items }: { items: DownloadProgress[] }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3 text-xs space-y-1">
      {items.map((p) => {
        const pct = p.fraction != null ? Math.floor(p.fraction * 100) : null;
        const mb = (p.bytesReceived / 1024 / 1024).toFixed(1);
        const file = p.url.split("/").pop();
        return (
          <div key={p.url}>
            <span className="text-slate-400">{file}</span>: {mb} MB
            {pct != null && ` · ${pct}%`}
          </div>
        );
      })}
    </div>
  );
}

function LogPanel({ lines }: { lines: LogLine[] }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-3 font-mono text-xs max-h-[60vh] overflow-y-auto">
      {lines.length === 0 && (
        <div className="text-slate-500">No events yet.</div>
      )}
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            l.kind === "err"
              ? "text-red-400"
              : l.kind === "ok"
              ? "text-green-400"
              : "text-slate-300"
          }
        >
          <span className="text-slate-600">
            {new Date(l.ts).toISOString().slice(11, 23)}
          </span>{" "}
          {l.text}
        </div>
      ))}
    </div>
  );
}

// ---------- Helpers ----------

/** fm_decoder outputs mel as [1, T, 100]; Vocos wants [1, 100, T]. */
function transposeMelForVocos(
  x: Float32Array,
  t: number,
  nMel: number
): Float32Array {
  const out = new Float32Array(nMel * t);
  for (let i = 0; i < t; i++) {
    for (let c = 0; c < nMel; c++) {
      out[c * t + i] = x[i * nMel + c];
    }
  }
  return out;
}

/** Minimal 16-bit PCM WAV encoder. Single channel, Float32 input in
 *  [-1, 1], clipped. 44-byte header + samples. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, n * 2, true);
  let offset = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s * 0x7fff, true);
    offset += 2;
  }
  return buf;
}
