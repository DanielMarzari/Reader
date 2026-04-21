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
  // ONNX Runtime Web — we use the DEFAULT bundle (WASM only; no
  // WebGPU). An earlier turbopack.resolveAlias redirected to the
  // WebGPU bundle, but that surfaced the known ORT-Web kernel bug
  // from Spike B (conv_module1/out_proj/MatMul "shared dimension
  // does not match") on ZipVoice's Zipformer. WASM backend has
  // working kernels for the same graph.
  //
  // Spike B (phase-0-spikes branch, commit 3f05684) already measured
  // this WASM path: single-threaded 0.57× real-time, known-good.
  // Multi-threaded WASM (would need proxy + SharedArrayBuffer) is
  // a separate Workstream C optimization.
  //
  // Revisit: ORT-Web 1.22+ (we're on 1.19.2) may have the kernel
  // fix; retest WebGPU then. Until then, WASM is the contract.
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
