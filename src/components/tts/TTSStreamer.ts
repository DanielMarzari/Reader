// Chunked streaming TTS orchestrator.
//
// Responsibilities:
//   - Accept an ordered list of text Chunks from `ttsChunker.ts`.
//   - Prefetch a rolling 2-chunk window (current + next).
//   - Append MP3 bytes to a single MediaSource SourceBuffer so playback is
//     gapless across chunk boundaries.
//   - Emit onTick(chunkIndex, progress) events so TTSContext can map
//     playback position → word index for the per-word highlight.
//
// Fallback: if MSE is unavailable, we fall back to sequential blob-URL
// swaps (a tiny audible gap per swap). Most modern browsers support
// MSE with audio/mpeg; Safari desktop does, Safari iOS supports it on
// iOS 17.1+. Users on older Safari get the fallback path.

import {
  type Chunk,
  forwardContext,
  previousContext,
} from "@/lib/ttsChunker";

export type StreamerStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export type StreamerOptions = {
  content: string;
  chunks: Chunk[];
  voiceId?: string;
  modelId?: string;
  rate: number;
  startChunkIndex?: number;
  onStatusChange?: (status: StreamerStatus, error?: string) => void;
  onTick?: (chunkIndex: number, progress: number) => void;
  onChunkStart?: (chunkIndex: number) => void;
  onEnded?: () => void;
};

type ChunkState = {
  index: number;
  blob: Blob | null;
  buffer: ArrayBuffer | null;
  bytes: number;
  fetching: boolean;
  appended: boolean;
  /** Absolute MediaSource timestamp at which this chunk begins playing. */
  startTime: number | null;
  /** Best known duration (seconds) once the chunk has been decoded. */
  duration: number | null;
};

const MSE_MIME_MP3 = 'audio/mpeg';

/** Returns true if MediaSource Extensions can accept MP3 in this browser. */
function canUseMseForMp3(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.MediaSource === "undefined") return false;
  try {
    return window.MediaSource.isTypeSupported(MSE_MIME_MP3);
  } catch {
    return false;
  }
}

export class TTSStreamer {
  private readonly opts: StreamerOptions;
  private readonly audio: HTMLAudioElement;
  private readonly chunkStates: Map<number, ChunkState> = new Map();
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private readonly appendQueue: number[] = [];
  private readonly useMse: boolean;
  private currentChunkIdx = 0;
  private tickHandle: number | null = null;
  private disposed = false;
  private status: StreamerStatus = "idle";
  private abortControllers: Map<number, AbortController> = new Map();
  private mediaSourceUrl: string | null = null;
  private endedSignaled = false;
  // Fallback-only: index of the currently playing blob.
  private fallbackIdx = 0;

  constructor(opts: StreamerOptions) {
    this.opts = opts;
    this.useMse = canUseMseForMp3();
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.crossOrigin = "anonymous";
    this.audio.playbackRate = opts.rate;
    this.currentChunkIdx = Math.max(0, opts.startChunkIndex ?? 0);
    for (const c of opts.chunks) {
      this.chunkStates.set(c.index, {
        index: c.index,
        blob: null,
        buffer: null,
        bytes: 0,
        fetching: false,
        appended: false,
        startTime: null,
        duration: null,
      });
    }
  }

  /** Reflect the currently-playing chunk and its progress (0..1). */
  get current(): { chunkIndex: number; progress: number } {
    const state = this.chunkStates.get(this.currentChunkIdx);
    const now = this.audio.currentTime;
    let progress = 0;
    if (state && state.startTime != null && state.duration && state.duration > 0) {
      progress = (now - state.startTime) / state.duration;
    }
    return {
      chunkIndex: this.currentChunkIdx,
      progress: Math.max(0, Math.min(1, progress)),
    };
  }

  getAudioElement(): HTMLAudioElement {
    return this.audio;
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    this.setStatus("loading");

    if (this.useMse) {
      this.attachMediaSource();
    }

    // Kick off first + second chunk fetches in parallel.
    void this.ensureFetched(this.currentChunkIdx);
    void this.ensureFetched(this.currentChunkIdx + 1);

    this.startTickLoop();
    this.audio.addEventListener("ended", this.handleEnded);
    this.audio.addEventListener("play", this.handlePlay);
    this.audio.addEventListener("pause", this.handlePause);
    this.audio.addEventListener("error", this.handleAudioError);

    // Once the first chunk is available, kick off playback.
    await this.waitForChunkReady(this.currentChunkIdx);
    if (this.disposed) return;

    if (!this.useMse) {
      // Fallback: play the first chunk as an object URL.
      const state = this.chunkStates.get(this.currentChunkIdx);
      if (state?.blob) {
        this.playBlobFallback(state.blob);
      }
    }

    try {
      await this.audio.play();
      this.setStatus("playing");
    } catch (err) {
      this.setStatus("error", err instanceof Error ? err.message : "play failed");
    }
  }

  pause(): void {
    this.audio.pause();
    this.setStatus("paused");
  }

  resume(): void {
    void this.audio.play().then(() => {
      if (!this.disposed) this.setStatus("playing");
    });
  }

  setRate(rate: number): void {
    this.audio.playbackRate = rate;
  }

  /**
   * Seek to a word offset inside a specific chunk.
   * If the chunk is already buffered, we seek inside the audio element.
   * Otherwise we flush and restart from that chunk.
   */
  async seekToChunk(chunkIndex: number, progressInChunk = 0): Promise<void> {
    const state = this.chunkStates.get(chunkIndex);
    if (!state) return;

    // Fast path: chunk already appended and has a known startTime.
    if (state.appended && state.startTime != null && state.duration != null) {
      const target = state.startTime + progressInChunk * state.duration;
      try {
        this.audio.currentTime = target;
        this.currentChunkIdx = chunkIndex;
        void this.ensureFetched(chunkIndex + 1);
        return;
      } catch {
        // fallthrough to restart
      }
    }

    // Restart: tear down MSE and rebuild starting at chunkIndex.
    this.teardownMediaSource();
    for (const s of this.chunkStates.values()) {
      s.appended = false;
      s.startTime = null;
      s.duration = null;
    }
    this.appendQueue.length = 0;
    this.currentChunkIdx = chunkIndex;
    if (this.useMse) this.attachMediaSource();
    void this.ensureFetched(chunkIndex);
    void this.ensureFetched(chunkIndex + 1);
    await this.waitForChunkReady(chunkIndex);
    if (!this.useMse) {
      const s2 = this.chunkStates.get(chunkIndex);
      if (s2?.blob) this.playBlobFallback(s2.blob);
    }
    try {
      await this.audio.play();
      this.setStatus("playing");
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTickLoop();
    this.audio.removeEventListener("ended", this.handleEnded);
    this.audio.removeEventListener("play", this.handlePlay);
    this.audio.removeEventListener("pause", this.handlePause);
    this.audio.removeEventListener("error", this.handleAudioError);
    this.audio.pause();
    for (const ac of this.abortControllers.values()) ac.abort();
    this.abortControllers.clear();
    this.teardownMediaSource();
    this.audio.removeAttribute("src");
    try {
      this.audio.load();
    } catch {
      /* ignore */
    }
  }

  // -------- internals --------

  private setStatus(next: StreamerStatus, error?: string): void {
    if (this.disposed) return;
    this.status = next;
    this.opts.onStatusChange?.(next, error);
  }

  private attachMediaSource(): void {
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.mediaSourceUrl = URL.createObjectURL(ms);
    this.audio.src = this.mediaSourceUrl;
    ms.addEventListener("sourceopen", this.handleSourceOpen, { once: true });
  }

  private teardownMediaSource(): void {
    try {
      if (this.sourceBuffer && this.mediaSource?.readyState === "open") {
        if (!this.sourceBuffer.updating) {
          try { this.sourceBuffer.abort(); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    try {
      if (this.mediaSource?.readyState === "open" && !this.endedSignaled) {
        // Don't call endOfStream here — the element may already be paused /
        // torn down. We simply drop references and let GC handle it.
      }
    } catch { /* ignore */ }
    if (this.mediaSourceUrl) {
      URL.revokeObjectURL(this.mediaSourceUrl);
      this.mediaSourceUrl = null;
    }
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.endedSignaled = false;
  }

  private handleSourceOpen = (): void => {
    if (this.disposed || !this.mediaSource) return;
    if (this.mediaSource.readyState !== "open") return;
    try {
      const sb = this.mediaSource.addSourceBuffer(MSE_MIME_MP3);
      sb.mode = "sequence";
      sb.addEventListener("updateend", this.handleUpdateEnd);
      this.sourceBuffer = sb;
      this.pumpAppendQueue();
    } catch (err) {
      this.setStatus("error", err instanceof Error ? err.message : "sourcebuffer failed");
    }
  };

  private handleUpdateEnd = (): void => {
    if (this.disposed) return;
    // Record the startTime / duration for the chunk we just appended.
    const justAppendedIdx = this.appendQueue.shift();
    if (justAppendedIdx !== undefined) {
      const state = this.chunkStates.get(justAppendedIdx);
      if (state && state.startTime == null && this.sourceBuffer) {
        try {
          const buffered = this.sourceBuffer.buffered;
          if (buffered.length > 0) {
            const end = buffered.end(buffered.length - 1);
            // startTime = end of buffered region before this append
            // (approximation: we use previous chunk's end, else 0).
            const prev = this.findPrevAppended(justAppendedIdx);
            const prevEnd = prev && prev.startTime != null && prev.duration != null
              ? prev.startTime + prev.duration
              : 0;
            state.startTime = prevEnd;
            state.duration = Math.max(0, end - prevEnd);
            state.appended = true;
          }
        } catch { /* ignore */ }
      }
    }
    this.pumpAppendQueue();
    this.maybeEndOfStream();
  };

  private findPrevAppended(idx: number): ChunkState | null {
    for (let i = idx - 1; i >= 0; i--) {
      const s = this.chunkStates.get(i);
      if (s && s.appended) return s;
    }
    return null;
  }

  private pumpAppendQueue(): void {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;
    // Find the next in-order chunk that's fetched and not yet appended.
    for (const chunk of this.opts.chunks) {
      const state = this.chunkStates.get(chunk.index);
      if (!state) continue;
      if (state.appended) continue;
      if (state.index < this.currentChunkIdx) continue; // skip past
      if (!state.buffer) {
        // Missing — can't skip ahead or we'd lose ordering.
        return;
      }
      try {
        this.appendQueue.push(state.index);
        this.sourceBuffer.appendBuffer(state.buffer);
        // Mark buffer consumed so we don't re-append.
        state.buffer = null;
      } catch (err) {
        // QuotaExceededError: evict old data, but for now we just flag.
        this.setStatus("error", err instanceof Error ? err.message : "append failed");
      }
      return;
    }
  }

  private maybeEndOfStream(): void {
    if (!this.mediaSource || this.mediaSource.readyState !== "open") return;
    if (this.endedSignaled) return;
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;
    // All chunks fetched + appended?
    for (const c of this.opts.chunks) {
      const s = this.chunkStates.get(c.index);
      if (!s || !s.appended) return;
      if (s.buffer) return;
    }
    try {
      this.mediaSource.endOfStream();
      this.endedSignaled = true;
    } catch { /* ignore */ }
  }

  private async ensureFetched(chunkIndex: number): Promise<void> {
    if (this.disposed) return;
    const chunk = this.opts.chunks[chunkIndex];
    if (!chunk) return;
    const state = this.chunkStates.get(chunkIndex);
    if (!state) return;
    if (state.fetching || state.blob || state.buffer || state.appended) return;
    state.fetching = true;

    const ac = new AbortController();
    this.abortControllers.set(chunkIndex, ac);

    try {
      const resp = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          text: chunk.speakText,
          previousText: previousContext(this.opts.content, chunk),
          nextText: forwardContext(this.opts.chunks, chunkIndex),
          voiceId: this.opts.voiceId,
          modelId: this.opts.modelId,
        }),
      });

      if (!resp.ok) {
        const msg = await resp.text().catch(() => resp.statusText);
        this.setStatus(
          "error",
          `/api/tts ${resp.status}: ${msg.slice(0, 200)}`
        );
        return;
      }

      const buffer = await resp.arrayBuffer();
      if (this.disposed) return;
      state.buffer = buffer;
      state.bytes = buffer.byteLength;
      // Keep a Blob reference too for the fallback path.
      state.blob = new Blob([buffer], { type: "audio/mpeg" });

      // Drive the append pump for MSE.
      if (this.useMse) this.pumpAppendQueue();

      // Prefetch one more ahead now that this one landed.
      void this.ensureFetched(chunkIndex + 1);
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return;
      this.setStatus(
        "error",
        err instanceof Error ? err.message : "chunk fetch failed"
      );
    } finally {
      state.fetching = false;
      this.abortControllers.delete(chunkIndex);
    }
  }

  /** Resolve when the chunk has bytes ready for playback. */
  private waitForChunkReady(chunkIndex: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.disposed) return resolve();
        const s = this.chunkStates.get(chunkIndex);
        if (s && (s.appended || s.blob)) return resolve();
        setTimeout(check, 50);
      };
      check();
    });
  }

  private startTickLoop(): void {
    if (this.tickHandle != null) return;
    const tick = () => {
      if (this.disposed) return;
      this.advanceCurrentChunkIfNeeded();
      const { chunkIndex, progress } = this.current;
      this.opts.onTick?.(chunkIndex, progress);
      this.tickHandle = window.requestAnimationFrame(tick);
    };
    this.tickHandle = window.requestAnimationFrame(tick);
  }

  private stopTickLoop(): void {
    if (this.tickHandle != null) {
      window.cancelAnimationFrame(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private advanceCurrentChunkIfNeeded(): void {
    const now = this.audio.currentTime;
    // Advance currentChunkIdx while the next chunk's startTime <= now.
    while (true) {
      const next = this.chunkStates.get(this.currentChunkIdx + 1);
      if (!next || next.startTime == null) break;
      if (now < next.startTime) break;
      this.currentChunkIdx += 1;
      this.opts.onChunkStart?.(this.currentChunkIdx);
      // Prefetch two chunks ahead of whatever is playing.
      void this.ensureFetched(this.currentChunkIdx + 1);
      void this.ensureFetched(this.currentChunkIdx + 2);
    }
  }

  private handleEnded = (): void => {
    if (this.disposed) return;
    this.setStatus("ended");
    this.opts.onEnded?.();
  };

  private handlePlay = (): void => {
    if (this.disposed) return;
    if (this.status !== "playing") this.setStatus("playing");
  };

  private handlePause = (): void => {
    if (this.disposed) return;
    // Don't overwrite "ended" with "paused".
    if (this.status === "ended" || this.status === "error") return;
    this.setStatus("paused");
  };

  private handleAudioError = (): void => {
    if (this.disposed) return;
    const err = this.audio.error;
    this.setStatus("error", err ? `audio error ${err.code}` : "audio error");
  };

  /** Fallback path: swap audio.src to the next blob on `ended`. */
  private playBlobFallback(blob: Blob): void {
    this.fallbackIdx = this.currentChunkIdx;
    const url = URL.createObjectURL(blob);
    this.audio.src = url;
    this.audio.addEventListener(
      "ended",
      () => {
        URL.revokeObjectURL(url);
        const nextIdx = this.fallbackIdx + 1;
        const nextState = this.chunkStates.get(nextIdx);
        if (!nextState || !nextState.blob) {
          // Wait for it briefly, then stop.
          const retry = () => {
            const s = this.chunkStates.get(nextIdx);
            if (s?.blob) {
              this.currentChunkIdx = nextIdx;
              this.playBlobFallback(s.blob);
              void this.audio.play().catch(() => undefined);
            } else if (!this.disposed) {
              setTimeout(retry, 100);
            }
          };
          retry();
          return;
        }
        this.currentChunkIdx = nextIdx;
        this.playBlobFallback(nextState.blob);
        void this.audio.play().catch(() => undefined);
      },
      { once: true }
    );
  }
}
