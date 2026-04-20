// JS port of `torch.istft(spec, n_fft, hop_length, win_length, window,
//                        center=True, normalized=False, onesided=True)`
//
// Vocos's ONNX (wetdog/vocos-mel-24khz-onnx) outputs three real tensors:
//   mag: [1, 513, T]   — magnitude spectrogram
//   x:   [1, 513, T]   — cos(phase)
//   y:   [1, 513, T]   — sin(phase)
//
// Because ONNX has no iSTFT operator, we reconstruct the complex
// spectrogram here (z = mag·x + i·mag·y) and run an overlap-add iSTFT
// to recover the 24 kHz waveform.
//
// Phase 1's backend/scripts/export_vocos.py verified that ONNX +
// torch.istft produces RMS 0.0 vs PyTorch Vocos. This function is the
// JS port of that torch.istft call — same `n_fft=1024, hop=256,
// win_length=1024, Hann window, center=True` configuration. The
// algorithm is standard COLA (constant overlap-add):
//
//   1. For each frame t (column of the spec), compute the inverse FFT
//      of the one-sided complex spectrum (513 bins → 1024 real
//      samples).
//   2. Multiply by the synthesis window.
//   3. Overlap-add into the output buffer at position t * hop.
//   4. Divide by the overlap-window-squared sum (normalize for
//      window gain).
//   5. If center=True, strip the n_fft/2 samples at each end that
//      correspond to the padding the STFT pass added.
//
// Implementation notes:
//
// - We use a small in-line DFT (size 1024). Not FFT. That's 1024²
//   = ~1M multiplies per frame. For a 200-frame sentence (0.5 s
//   audio) that's ~200M multiplies. On a modern CPU via JS that's
//   ~100 ms, which is fine for our latency budget — browser-native
//   inference is dominated by the fm_decoder ONNX anyway (see
//   Spike B numbers). A real FFT cuts this to ~5 ms. If the
//   benchmark shows it's a bottleneck, drop in a radix-2 FFT
//   library (e.g. `fft.js` from npm) without changing the
//   overlap-add logic.
// - The synthesis window used here is the DEFAULT torch.istft
//   behavior: synthesis_window = analysis_window / sum(analysis_window²
//   for overlapping frames). For a Hann window at 75% overlap
//   (1024/256 ratio) this normalization resolves to multiplying by
//   the analysis window (COLA-valid) and then dividing by the
//   overlap-weight vector at the end. We implement it that way.

/** Configuration matching Vocos's iSTFTHead + ZipVoice's sampling rate. */
export const VOCOS_ISTFT_CONFIG = {
  nFft: 1024,
  hopLength: 256,
  winLength: 1024,
  sampleRate: 24000,
} as const;

/** Size of the one-sided magnitude spectrum (n_fft / 2 + 1). */
export const VOCOS_FREQ_BINS = 513;

/** Build a periodic Hann window of length N. Matches
 *  torch.hann_window(N, periodic=True). */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  }
  return w;
}

/** Precomputed cosine / sine tables for DFT size N. Shared across calls
 *  so we don't rebuild them per-frame. Keyed by size. */
const TRIG_CACHE = new Map<number, { cos: Float32Array; sin: Float32Array }>();

function trig(n: number) {
  let t = TRIG_CACHE.get(n);
  if (!t) {
    const cos = new Float32Array(n * n);
    const sin = new Float32Array(n * n);
    const twoPiOverN = (2 * Math.PI) / n;
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < n; j++) {
        const ang = twoPiOverN * k * j;
        cos[k * n + j] = Math.cos(ang);
        sin[k * n + j] = Math.sin(ang);
      }
    }
    t = { cos, sin };
    TRIG_CACHE.set(n, t);
  }
  return t;
}

/** Inverse DFT of a one-sided spectrum [real(0..N/2), imag(0..N/2)]
 *  back to a real-valued signal of length N.
 *
 *  x[n] = sum over k of X[k] * exp(i·2π·k·n / N)
 *
 *  For a real input signal the DFT is conjugate-symmetric, so we only
 *  get half the bins from STFT. To invert without reconstructing the
 *  other half, we use:
 *
 *    x[n] = (1/N) · (X[0].real + (-1)^n · X[N/2].real
 *                    + 2·sum over k=1..N/2-1 of (re·cos - im·sin))
 *
 *  where re = X[k].real, im = X[k].imag, cos/sin are of 2π·k·n/N. */
function irfft(
  re: Float32Array,
  im: Float32Array,
  n: number,
  out: Float32Array,
  outOffset: number
) {
  const { cos, sin } = trig(n);
  const nyquist = n >> 1;
  const invN = 1 / n;
  for (let j = 0; j < n; j++) {
    let acc = re[0] + (j & 1 ? -re[nyquist] : re[nyquist]);
    for (let k = 1; k < nyquist; k++) {
      const cosKj = cos[k * n + j];
      const sinKj = sin[k * n + j];
      acc += 2 * (re[k] * cosKj - im[k] * sinKj);
    }
    out[outOffset + j] = acc * invN;
  }
}

export type IstftInput = {
  /** Magnitude [T × 513], row-major (time-major for easy iteration). */
  mag: Float32Array;
  /** cos(phase) [T × 513], row-major. */
  cosPhase: Float32Array;
  /** sin(phase) [T × 513], row-major. */
  sinPhase: Float32Array;
  /** Number of time frames. */
  numFrames: number;
};

/** Reconstruct a real-valued audio waveform from Vocos's (mag, cos, sin)
 *  ONNX outputs. Returns Float32 samples at 24 kHz.
 *
 *  Input shapes are time-major flat arrays so the caller can feed them
 *  directly from ort.Tensor.data after a transpose (ORT outputs
 *  [1, 513, T]; the caller must transpose to [T, 513]).
 *
 *  Matches torch.istft(..., center=True). The output length is
 *  `numFrames * hop_length` after stripping the n_fft/2 centerpad on
 *  each side.
 */
export function istftVocos(input: IstftInput): Float32Array {
  const { mag, cosPhase, sinPhase, numFrames } = input;
  const { nFft, hopLength, winLength } = VOCOS_ISTFT_CONFIG;
  const nBins = VOCOS_FREQ_BINS;

  if (mag.length !== numFrames * nBins)
    throw new Error(
      `mag length ${mag.length} != numFrames*nBins ${numFrames * nBins}`
    );
  if (winLength !== nFft)
    throw new Error("winLength must equal nFft for this implementation");

  const window = hannWindow(winLength);

  // Reusable per-frame full-length spectrum buffers
  const re = new Float32Array(nBins);
  const im = new Float32Array(nBins);
  const timeDomainFrame = new Float32Array(nFft);

  // Total signal length before center-crop. With center=True, the STFT
  // pads n_fft/2 on each side; the iSTFT output is the overlap-add
  // length, which for numFrames frames and hop=hopLength is:
  //   (numFrames - 1) * hop + n_fft
  const rawLength = (numFrames - 1) * hopLength + nFft;
  const sumSignal = new Float32Array(rawLength);
  const sumWindow = new Float32Array(rawLength);

  for (let t = 0; t < numFrames; t++) {
    // Reconstruct complex spec: z[k] = mag[t,k] * (cos[t,k] + i·sin[t,k])
    const base = t * nBins;
    for (let k = 0; k < nBins; k++) {
      const m = mag[base + k];
      re[k] = m * cosPhase[base + k];
      im[k] = m * sinPhase[base + k];
    }

    // Inverse DFT → real signal frame of length n_fft
    irfft(re, im, nFft, timeDomainFrame, 0);

    // Apply synthesis window + overlap-add at hop * t
    const offset = t * hopLength;
    for (let j = 0; j < nFft; j++) {
      const w = window[j];
      sumSignal[offset + j] += timeDomainFrame[j] * w;
      sumWindow[offset + j] += w * w; // for normalization
    }
  }

  // Normalize by accumulated window² (COLA renormalization)
  const out = new Float32Array(rawLength);
  for (let i = 0; i < rawLength; i++) {
    // Avoid divide-by-zero at the edges where the window sum is tiny.
    // torch.istft clamps implicitly via `normalized` flag; we use a
    // small epsilon consistent with their floor.
    const denom = sumWindow[i] > 1e-11 ? sumWindow[i] : 1e-11;
    out[i] = sumSignal[i] / denom;
  }

  // Strip the center-padding (n_fft/2 on each side)
  const centerPad = nFft >> 1;
  return out.slice(centerPad, rawLength - centerPad);
}

/** Transpose a [1, F, T] ORT tensor flat buffer into a [T, F] flat
 *  buffer (time-major). Called once per inference output; O(T·F) copy. */
export function transposeForIstft(
  data: Float32Array,
  freq: number,
  time: number
): Float32Array {
  const out = new Float32Array(time * freq);
  for (let f = 0; f < freq; f++) {
    const rowIn = f * time;
    for (let t = 0; t < time; t++) {
      out[t * freq + f] = data[rowIn + t];
    }
  }
  return out;
}
