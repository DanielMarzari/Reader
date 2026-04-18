"use client";

import { useEffect, useRef, useState } from "react";

// Client-side rendering of the original PDF using pdfjs-dist.
// Loads the file from /api/documents/[id]/file and renders each page
// into a <canvas>. Worker ships from /pdf.worker.mjs (copied via prebuild).

type Props = {
  docId: string;
  sourceType: "pdf" | "epub" | "text";
};

type PdfLibType = typeof import("pdfjs-dist");

export function PdfPagesViewer({ docId, sourceType }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    if (sourceType !== "pdf") {
      setStatus("error");
      setError(
        sourceType === "epub"
          ? "Page view for EPUBs is coming soon. Use the Text tab for now."
          : "Pasted text doesn't have a page view. Use the Text tab."
      );
      return;
    }

    async function render() {
      setStatus("loading");
      setError(null);
      try {
        const pdfjs = (await import("pdfjs-dist/build/pdf.mjs")) as unknown as PdfLibType;
        // Worker is served from /pdf.worker.mjs (see prebuild script).
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";

        const res = await fetch(`/api/documents/${docId}/file`);
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? "Original PDF wasn't stored for this document."
              : `Failed to load PDF (${res.status}).`
          );
        }
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
        if (cancelled) return;
        setPageCount(pdf.numPages);

        const container = containerRef.current;
        if (!container) return;
        container.innerHTML = "";

        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) return;
          const page = await pdf.getPage(i);
          // Fit to container width; cap at ~880px.
          const containerWidth = Math.min(container.clientWidth - 32, 880);
          const viewport1 = page.getViewport({ scale: 1 });
          const scale = containerWidth / viewport1.width;
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement("canvas");
          canvas.className = "pdf-page";
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ctx.scale(dpr, dpr);

          const label = document.createElement("div");
          label.className = "text-xs text-[color:var(--muted)] mt-1";
          label.textContent = `Page ${i}`;

          container.appendChild(canvas);
          container.appendChild(label);

          await page.render({ canvasContext: ctx, viewport }).promise;
        }

        if (!cancelled) setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        console.error("PDF render failed:", err);
        setError((err as Error).message);
        setStatus("error");
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [docId, sourceType]);

  if (status === "error") {
    return (
      <div className="pages-canvas">
        <div className="text-center text-sm text-[color:var(--muted)] max-w-md px-6 py-12">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="pages-canvas">
      {status === "loading" && (
        <div className="text-sm text-[color:var(--muted)] py-8">Rendering PDF…</div>
      )}
      <div ref={containerRef} className="w-full flex flex-col items-center gap-4" />
      {status === "ready" && (
        <div className="text-xs text-[color:var(--muted)] mt-4">
          {pageCount} page{pageCount === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}
