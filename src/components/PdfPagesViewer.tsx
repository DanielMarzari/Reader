"use client";

import { useEffect, useRef, useState } from "react";
import { useTTS } from "./tts/TTSContext";

type Props = {
  docId: string;
  sourceType: "pdf" | "epub" | "text";
  pageRanges: Array<{ charStart: number; charEnd: number }> | null;
};

type PdfLibType = typeof import("pdfjs-dist");

export function PdfPagesViewer({ docId, sourceType, pageRanges }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLElement | null)[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);

  const { tokens, currentWordIdx } = useTTS();

  // Global char offset of the current word (index into `content` string).
  const currentCharOffset =
    tokens.words[currentWordIdx]?.start ?? 0;

  // Map current char offset → page index (0-based).
  useEffect(() => {
    if (!pageRanges || pageRanges.length === 0) return;
    let next = 0;
    for (let i = 0; i < pageRanges.length; i++) {
      if (currentCharOffset < pageRanges[i].charEnd) {
        next = i;
        break;
      }
      next = i;
    }
    setCurrentPage((prev) => (prev === next ? prev : next));
  }, [currentCharOffset, pageRanges]);

  // Scroll the current page into view (debounced; smooth).
  const lastScrolledRef = useRef<number>(-1);
  useEffect(() => {
    if (status !== "ready") return;
    if (currentPage === lastScrolledRef.current) return;
    const el = pageRefs.current[currentPage];
    if (el) {
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      lastScrolledRef.current = currentPage;
    }
  }, [currentPage, status]);

  // Render the PDF.
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
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";

        const res = await fetch(`/api/documents/${docId}/file`);
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? "Original PDF wasn't stored for this document. Re-upload it to enable the Pages view."
              : `Failed to load PDF (${res.status}).`
          );
        }
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
        if (cancelled) return;
        setPageCount(pdf.numPages);
        pageRefs.current = new Array(pdf.numPages).fill(null);

        const container = containerRef.current;
        if (!container) return;
        container.innerHTML = "";

        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) return;
          const page = await pdf.getPage(i);
          const containerWidth = Math.min(container.clientWidth - 32, 880);
          const viewport1 = page.getViewport({ scale: 1 });
          const scale = containerWidth / viewport1.width;
          const viewport = page.getViewport({ scale });

          const wrap = document.createElement("div");
          wrap.className = "pdf-page-wrap";
          wrap.dataset.page = String(i - 1);
          wrap.style.width = `${viewport.width}px`;

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
          label.className = "pdf-page-label";
          label.textContent = `Page ${i}`;

          wrap.appendChild(canvas);
          wrap.appendChild(label);
          container.appendChild(wrap);
          pageRefs.current[i - 1] = wrap;

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

  // Apply highlight class to the active page wrapper.
  useEffect(() => {
    pageRefs.current.forEach((el, i) => {
      if (!el) return;
      if (i === currentPage) el.classList.add("pdf-page-current");
      else el.classList.remove("pdf-page-current");
    });
  }, [currentPage, pageCount]);

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
          Page {currentPage + 1} of {pageCount}
        </div>
      )}
    </div>
  );
}
