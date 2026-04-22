// Device + browser capability detection for in-browser TTS.
//
// Browser inference spins up a ~660 MB voice bundle, a WebGPU
// context, and runs a 4-step flow sampler per sentence. That's a
// desktop-only experience by design (plan.md §Phase 3 Device gating).
//
// This module answers one question: "Can we run in-browser inference
// here, or should we fall through to the queued-audiobook /
// Web-Speech fallback?" Caller is <ReaderClient/>.
//
// We gate on two dimensions:
//   1. Device class (desktop vs mobile) — via UA + iPadOS masquerade
//      check. iOS Safari's WebGPU flag exists but we don't trust the
//      battery/thermal story on a phone, and iPad can run WebGPU but
//      the touch-only UX isn't built yet.
//   2. WebGPU availability — even on desktop, without WebGPU the
//      WASM fallback runs ~5-10x slower (Spike B numbers). Plan says
//      fall through in that case too, so the user gets a working
//      audiobook-queued experience instead of 90-second synth waits.
//
// When we block, we return a human-readable reason so the UI can
// explain WHY the voice won't load locally and point at the
// alternatives.

import { detectWebGpu, type WebGpuSupport } from "./browser-inference";

export type DeviceClass =
  | "desktop"
  | "mobile-ios"
  | "mobile-android"
  | "mobile-other";

export type InferenceCapability = {
  deviceClass: DeviceClass;
  webgpu: WebGpuSupport;
  /** True iff the user's browser/device can comfortably run the
   *  in-browser ZipVoice pipeline. When false the UI should fall
   *  through to the audiobook/Web-Speech path and surface `reason`. */
  canRun: boolean;
  /** Short phrase for a banner headline when canRun is false. */
  headline?: string;
  /** Longer, actionable explanation for the user. */
  recommendation?: string;
};

/** UA-based device class detection. Handles the iPadOS-13-and-up case
 *  where `navigator.userAgent` looks identical to desktop macOS Safari
 *  (iPad masquerades as Mac). The tell is `navigator.maxTouchPoints`:
 *  macs are 0, iPads are > 1. */
export function detectDeviceClass(): DeviceClass {
  if (typeof navigator === "undefined") return "desktop";

  const ua = navigator.userAgent || "";

  // iPadOS 13+ fakes MacIntel — disambiguate via touch support.
  const isIpadOsMasquerade =
    /Macintosh/.test(ua) &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1;

  if (/iPad|iPhone|iPod/.test(ua) || isIpadOsMasquerade) {
    return "mobile-ios";
  }
  if (/Android/i.test(ua)) return "mobile-android";
  if (/Mobile|Tablet/i.test(ua)) return "mobile-other";
  return "desktop";
}

/** Run both checks in sequence and return a single capability report.
 *  Safe to call from a useEffect — bails out gracefully with `canRun:
 *  false` if navigator APIs are missing (SSR bundle eval, exotic
 *  sandbox, etc). */
export async function detectInferenceCapability(): Promise<InferenceCapability> {
  const deviceClass = detectDeviceClass();

  if (deviceClass !== "desktop") {
    return {
      deviceClass,
      webgpu: { available: false, reason: "mobile device" },
      canRun: false,
      headline: "Desktop recommended",
      recommendation:
        "This voice runs locally in your browser. Open the reader on a desktop Chrome, Edge, or Safari for the full experience — mobile devices aren't supported yet. A pre-rendered audiobook or the system voice will be used here.",
    };
  }

  const webgpu = await detectWebGpu();
  if (!webgpu.available) {
    return {
      deviceClass,
      webgpu,
      canRun: false,
      headline: "WebGPU unavailable",
      recommendation: `Your browser can't use WebGPU (${
        webgpu.reason ?? "unknown reason"
      }). Upgrade to Chrome 113+, Edge 113+, or Safari 18+ to run this voice locally. Falling back to the queued audiobook or system voice.`,
    };
  }

  return { deviceClass, webgpu, canRun: true };
}
