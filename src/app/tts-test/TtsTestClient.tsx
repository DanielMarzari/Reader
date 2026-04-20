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

// ---------- Config ----------

const N_MEL = 100;
const NFE_STEPS = 4; // ZipVoice-Distill default
const SEQ_LEN_FRAMES = 50; // ~0.5 s of audio at hop=256, sr=24000
const PROMPT_FEATURES_LEN = 25; // must be < SEQ_LEN_FRAMES
const TOKEN_VOCAB_SIZE = 99; // matches ZipVoice tokens.txt (safe range 1..99)

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
    append("Downloading ONNX models (cached after first load)…");
    try {
      const shared = defaultSharedAssets();
      const s = await createSessions(shared, (p) => {
        setDlProgress((prev) => ({ ...prev, [p.url]: p }));
      });
      setSessions(s);
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
    } catch (e) {
      append(`Load failed: ${(e as Error).message}`, "err");
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [sessions, loading, append]);

  // ---------- Run end-to-end pipeline ----------

  const runPipeline = useCallback(async () => {
    if (!sessions || loading) return;
    setLoading("run");
    setAudioUrl(null);
    append(
      `Running pipeline: ${SEQ_LEN_FRAMES} frames, ${NFE_STEPS} NFE steps, ` +
        `prompt_features_len=${PROMPT_FEATURES_LEN}`
    );

    try {
      const t0 = performance.now();

      // --- 1. text_encoder with fake tokens ---
      const tokens = new BigInt64Array(SEQ_LEN_FRAMES);
      const promptTokens = new BigInt64Array(SEQ_LEN_FRAMES);
      for (let i = 0; i < SEQ_LEN_FRAMES; i++) {
        tokens[i] = BigInt(1 + Math.floor(Math.random() * TOKEN_VOCAB_SIZE));
        promptTokens[i] = BigInt(
          1 + Math.floor(Math.random() * TOKEN_VOCAB_SIZE)
        );
      }
      const teFeeds = {
        tokens: new ort.Tensor("int64", tokens, [1, SEQ_LEN_FRAMES]),
        prompt_tokens: new ort.Tensor(
          "int64",
          promptTokens,
          [1, SEQ_LEN_FRAMES]
        ),
        prompt_features_len: scalarInt64(PROMPT_FEATURES_LEN),
        speed: scalarFloat(1.0),
      };

      const tTextStart = performance.now();
      const teOut = await sessions.textEncoder.run(teFeeds);
      const textCondition = teOut.text_condition ?? teOut[Object.keys(teOut)[0]];
      append(
        `  text_encoder: ${(performance.now() - tTextStart).toFixed(0)} ms · ` +
          `output shape [${textCondition.dims.join(", ")}]`
      );

      // Coerce text_encoder output (N, T, concat_dim) down to (N, T, 100)
      // so fm_decoder's channel dim matches. Real ZipVoice does a length-
      // regulation step we're not reproducing here — for a
      // feasibility/pipeline test this linear truncation suffices.
      const coercedCond = coerceCondToMel(
        textCondition.data as Float32Array,
        textCondition.dims as number[],
        SEQ_LEN_FRAMES
      );

      // --- 2. fm_decoder × NFE_STEPS with Euler integration ---
      let xData = new Float32Array(1 * SEQ_LEN_FRAMES * N_MEL);
      // Initialize as Gaussian-ish noise; zero is valid too for timing.
      for (let i = 0; i < xData.length; i++) xData[i] = (Math.random() - 0.5);
      const speechData = new Float32Array(1 * SEQ_LEN_FRAMES * N_MEL);
      const speechCondTensor = new ort.Tensor(
        "float32",
        speechData,
        [1, SEQ_LEN_FRAMES, N_MEL]
      );

      let totalFmMs = 0;
      for (let s = 0; s < NFE_STEPS; s++) {
        const tFlow = s / NFE_STEPS;
        const xTensor = new ort.Tensor("float32", xData, [
          1,
          SEQ_LEN_FRAMES,
          N_MEL,
        ]);
        const fmFeeds = {
          t: scalarFloat(tFlow),
          x: xTensor,
          text_condition: coercedCond,
          speech_condition: speechCondTensor,
          guidance_scale: scalarFloat(1.0),
        };
        const tFmStart = performance.now();
        const fmOut = await sessions.fmDecoder.run(fmFeeds);
        const v = fmOut.v ?? fmOut[Object.keys(fmOut)[0]];
        const stepMs = performance.now() - tFmStart;
        totalFmMs += stepMs;
        append(`  fm_decoder step ${s + 1}/${NFE_STEPS}: ${stepMs.toFixed(0)} ms`);

        // Euler update: x_{t+dt} = x_t + dt * v
        const dt = 1 / NFE_STEPS;
        const vData = v.data as Float32Array;
        const newX = new Float32Array(xData.length);
        for (let i = 0; i < xData.length; i++) newX[i] = xData[i] + dt * vData[i];
        xData = newX;
      }

      // --- 3. Vocos: mel → (mag, cos, sin) ---
      // fm_decoder outputs mel as [1, T, 100]. Vocos wants [1, 100, T].
      const melForVocos = transposeMelForVocos(xData, SEQ_LEN_FRAMES, N_MEL);
      const vocosFeeds = {
        mels: new ort.Tensor("float32", melForVocos, [1, N_MEL, SEQ_LEN_FRAMES]),
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
        SEQ_LEN_FRAMES
      );
      const cosData = transposeForIstft(
        cx.data as Float32Array,
        VOCOS_FREQ_BINS,
        SEQ_LEN_FRAMES
      );
      const sinData = transposeForIstft(
        sy.data as Float32Array,
        VOCOS_FREQ_BINS,
        SEQ_LEN_FRAMES
      );

      // --- 4. iSTFT (JS) ---
      const tIstftStart = performance.now();
      const audioSamples = istftVocos({
        mag: magData,
        cosPhase: cosData,
        sinPhase: sinData,
        numFrames: SEQ_LEN_FRAMES,
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

      // Also play it directly
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext({
          sampleRate: VOCOS_ISTFT_CONFIG.sampleRate,
        });
      }
      const ctx = audioCtxRef.current;
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
          disabled={!sessions || loading !== false}
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

/** text_encoder outputs [N, T, concat_dim] where concat_dim ≠ 100.
 *  fm_decoder expects text_condition at [N, T, 100]. For the feasibility
 *  test we slice the first 100 channels. Phase 3 proper will replace
 *  this with ZipVoice's length-regulation / pooling step. */
function coerceCondToMel(
  data: Float32Array,
  dims: number[],
  targetFrames: number
): ort.Tensor {
  const [, t, inDim] = dims;
  const frames = Math.min(t, targetFrames);
  const out = new Float32Array(1 * frames * N_MEL);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < N_MEL; c++) {
      if (c < inDim) out[i * N_MEL + c] = data[i * inDim + c];
    }
  }
  return new ort.Tensor("float32", out, [1, frames, N_MEL]);
}

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
