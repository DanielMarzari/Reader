// Type shim for the direct-path import of onnxruntime-web's WebGPU
// bundle. The package exports this file via `./webgpu` in its
// exports map, but Next.js 16 / Turbopack can't resolve the subpath
// (known Turbopack limitation with conditional exports). We import
// the file directly by its absolute dist path; this declaration
// tells TypeScript it has the same surface as the default entry.

declare module "onnxruntime-web/dist/ort.webgpu.bundle.min.mjs" {
  export * from "onnxruntime-web";
}
