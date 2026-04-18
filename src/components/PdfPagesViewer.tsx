"use client";

import { useEffect, useRef, useState } from "react";
import { useTTS } from "./tts/TTSContext";
import {
  assemblePage,
  safeNormalize,
  type ItemRange,
  type PdfItem,
} from "@/lib/pdfAssembly";

type Props = {
  docId: string;
  sourceType: "pdf" | "epub" | "text";
  pageRanges: Array<{ charStart: number; charEnd: number }> | null;
  highlightSentence: boolean;
};

type PdfLibType = typeof import("pdfjs-dist");

type ItemBox = {
  localStart: number; // char offset within page.text
  localEnd: number;
  x: number; // CSS px relative to the canvas top-left
  y: number;
  width: number;
  height: number;
};

type PageData = {
  text: string; // same text the server stored (post-safeNormalize)
  items: ItemBox[];
};

// Multiply two 3×3 affine matrices flattened as [a,b,c,d,e,f]
// (pdfjs convention: [a b; c d; e f]).
function matMul(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function PdfPagesViewer({ docId, sourceType, pageRanges, highlightSentence }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageWrapRefs = useRef<(HTMLElement | null)[]>([]);
  const overlayRefs = useRef<(HTMLDivElement | null)[]>([]);
  const wordPillRefs = useRef<(HTMLDivElement | null)[]>([]);
  const sentenceOverlayRefs = useRef<(HTMLDivElement | null)[]>([]);

  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [pagesData, setPagesData] = useState<PageData[]>([]);

  const { tokens, currentWordIdx } = useTTS();
  const currentWord = tokens.words[currentWordIdx];
  const currentCharOffset = currentWord?.start ?? 0;
  const currentSentence = currentWord
    ? tokens.sentences[currentWord.sentenceIndex]
    : null;

  // Find page index covering currentCharOffset.
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

  // Scroll current page into view when it changes.
  const lastScrolledRef = useRef<number>(-1);
  useEffect(() => {
    if (status !== "ready") return;
    if (currentPage === lastScrolledRef.current) return;
    const el = pageWrapRefs.current[currentPage];
    if (el) {
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      lastScrolledRef.current = currentPage;
    }
  }, [currentPage, status]);

  // Position the word pill + sentence rects whenever the current
  // word/sentence or page data changes.
  useEffect(() => {
    if (status !== "ready") return;
    if (!pageRanges) return;

    pageWrapRefs.current.forEach((el, i) => {
      if (!el) return;
      if (i === currentPage) el.classList.add("pdf-page-current");
      else el.classList.remove("pdf-page-current");
    });

    // Hide all overlays, then draw on the active page only.
    wordPillRefs.current.forEach((el) => {
      if (el) el.style.display = "none";
    });
    sentenceOverlayRefs.current.forEach((el) => {
      if (el) el.innerHTML = "";
    });

    const pageIdx = currentPage;
    const data = pagesData[pageIdx];
    const range = pageRanges[pageIdx];
    if (!data || !range) return;

    // Word pill: find item covering local offset.
    const localOffset = currentCharOffset - range.charStart;
    const item = data.items.find(
      (it) => localOffset >= it.localStart && localOffset < it.localEnd
    );
    const pill = wordPillRefs.current[pageIdx];
    if (item && pill) {
      pill.style.display = "block";
      pill.style.left = `${item.x}px`;
      pill.style.top = `${item.y}px`;
      pill.style.width = `${item.width}px`;
      pill.style.height = `${item.height}px`;
    }

    // Sentence overlay: union of items intersecting the sentence's
    // local range, grouped by row (y band) to render one rect per line.
    if (highlightSentence && currentSentence) {
      const sentStart = currentSentence.start - range.charStart;
      const sentEnd = currentSentence.end - range.charStart;
      const items = data.items.filter(
        (it) => it.localEnd > sentStart && it.localStart < sentEnd
      );
      if (items.length) {
        // Group by y-row (cluster by top within a tolerance).
        const tol = 6;
        const rows: ItemBox[][] = [];
        for (const it of items) {
          const row = rows.find((r) => Math.abs(r[0].y - it.y) <= tol);
          if (row) row.push(it);
          else rows.push([it]);
        }
        const overlay = sentenceOverlayRefs.current[pageIdx];
        if (overlay) {
          for (const row of rows) {
            const xMin = Math.min(...row.map((it) => it.x));
            const xMax = Math.max(...row.map((it) => it.x + it.width));
            const yMin = Math.min(...row.map((it) => it.y));
            const yMax = Math.max(...row.map((it) => it.y + it.height));
            const rect = document.createElement("div");
            rect.className = "pdf-sentence-rect";
            rect.style.left = `${xMin - 2}px`;
            rect.style.top = `${yMin - 1}px`;
            rect.style.width = `${xMax - xMin + 4}px`;
            rect.style.height = `${yMax - yMin + 2}px`;
            overlay.appendChild(rect);
          }
        }
      }
    }
  }, [
    status,
    currentPage,
    currentCharOffset,
    currentSentence,
    pagesData,
    pageRanges,
    highlightSentence,
  ]);

  // Load PDF and render pages.
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
        pageWrapRefs.current = new Array(pdf.numPages).fill(null);
        overlayRefs.current = new Array(pdf.numPages).fill(null);
        wordPillRefs.current = new Array(pdf.numPages).fill(null);
        sentenceOverlayRefs.current = new Array(pdf.numPages).fill(null);

        const container = containerRef.current;
        if (!container) return;
        container.innerHTML = "";

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const collected: PageData[] = new Array(pdf.numPages);

        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) return;
          const page = await pdf.getPage(i);
          const containerWidth = Math.min(container.clientWidth - 32, 880);
          const viewport1 = page.getViewport({ scale: 1 });
          const scale = containerWidth / viewport1.width;
          const viewport = page.getViewport({ scale });

          const wrap = document.createElement("div");
          wrap.className = "pdf-page-wrap";
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

          const overlay = document.createElement("div");
          overlay.className = "pdf-overlay";
          overlay.style.width = `${viewport.width}px`;
          overlay.style.height = `${viewport.height}px`;

          const sentenceLayer = document.createElement("div");
          sentenceLayer.className = "pdf-sentence-layer";
          overlay.appendChild(sentenceLayer);

          const wordPill = document.createElement("div");
          wordPill.className = "pdf-word-pill";
          wordPill.style.display = "none";
          overlay.appendChild(wordPill);

          const stack = document.createElement("div");
          stack.className = "pdf-stack";
          stack.appendChild(canvas);
          stack.appendChild(overlay);

          const label = document.createElement("div");
          label.className = "pdf-page-label";
          label.textContent = `Page ${i}`;

          wrap.appendChild(stack);
          wrap.appendChild(label);
          container.appendChild(wrap);

          pageWrapRefs.current[i - 1] = wrap;
          overlayRefs.current[i - 1] = overlay;
          sentenceOverlayRefs.current[i - 1] = sentenceLayer;
          wordPillRefs.current[i - 1] = wordPill;

          await page.render({ canvasContext: ctx, viewport }).promise;

          // Compute per-item char ranges (local) and bounding boxes.
          const textContent = await page.getTextContent();
          const items = textContent.items as PdfItem[];
          const { text, itemRanges } = assemblePage(items);
          const safeText = safeNormalize(text); // same as server-side

          const itemBoxes: ItemBox[] = items.map((item: PdfItem, idx: number) => {
            const range: ItemRange = itemRanges[idx];
            const tx = matMul(viewport.transform as number[], item.transform);
            const fontHeight = Math.hypot(tx[2], tx[3]) || 12;
            const widthPx = (item.width ?? 0) * scale;
            return {
              localStart: range.start,
              localEnd: range.end,
              x: tx[4],
              y: tx[5] - fontHeight,
              width: Math.max(widthPx, 2),
              height: fontHeight,
            };
          });

          collected[i - 1] = { text: safeText, items: itemBoxes };
        }

        if (!cancelled) {
          setPagesData(collected);
          setStatus("ready");
        }
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
          Page {currentPage + 1} of {pageCount}
        </div>
      )}
    </div>
  );
}
