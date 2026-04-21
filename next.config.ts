import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "pdfjs-dist"],
  typescript: { ignoreBuildErrors: true },
  // pdfjs-dist loads its worker via a runtime dynamic import, which Next's
  // tracer can't see. Force the files into the standalone output.
  outputFileTracingIncludes: {
    "/api/documents": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.js",
    ],
  },
  // ONNX Runtime Web — the `./webgpu` subpath ships the JSEP bundle
  // that registers the WebGPU backend. The default entry does NOT,
  // and Turbopack 16 can't resolve conditional-exports subpaths, so
  // we alias the bare `onnxruntime-web` specifier to the WebGPU
  // bundle file directly.
  //
  // On 1.23.2 (B12). 1.24.3 had the same alias but failed at module
  // load under Turbopack — its bundle self-locates via a top-level
  // `new URL(..., import.meta.url)` that Turbopack can't resolve.
  // 1.23.2 predates that change, so this alias should load cleanly.
  //
  // If WebGPU still fails at runtime (same Zipformer MatMul shape
  // bug Spike B hit on 1.19.2), WASM remains as fallback — see
  // `createSessions` in src/lib/tts/browser-inference.ts.
  turbopack: {
    resolveAlias: {
      "onnxruntime-web":
        "./node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs",
    },
  },
  // Cross-Origin Isolation headers. Required by onnxruntime-web's WASM
  // backend to enable SharedArrayBuffer, which unlocks multi-threaded
  // inference (~3–4× faster than single-threaded per Spike B's findings).
  //
  // Trade-off: browsers treat a cross-origin-isolated page as a tighter
  // sandbox. Any third-party iframe/resource that doesn't set
  // `Cross-Origin-Resource-Policy: cross-origin` OR a matching CORP
  // header won't load. For Reader that's fine — we don't embed third-
  // party widgets. If we ever do, CORP on each resource is the fix.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
