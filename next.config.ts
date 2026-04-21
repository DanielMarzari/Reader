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
  // ONNX Runtime Web ships multiple bundle variants; the `./webgpu`
  // subpath registers the WebGPU (JSEP) backend, the default doesn't.
  // Turbopack (Next 16) can't resolve conditional-exports subpaths
  // and refuses direct file-path imports into node_modules. The alias
  // below redirects the default `onnxruntime-web` import to the
  // WebGPU bundle file so `import * as ort from "onnxruntime-web"`
  // in our code Just Works and gives us WebGPU backend support.
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
