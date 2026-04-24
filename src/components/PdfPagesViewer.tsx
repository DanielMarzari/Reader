"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTTS } from "./tts/TTSContext";
import {
  assemblePage,
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
  localStart: number;
  localEnd: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type PageInfo = {
  pageNum: number;
  width: number; // CSS px
  height: number;
  items: ItemBox[] | null; // filled when the page is rendered
  rendered: boolean;
};

// Multiply two affine matrices [a,b,c,d,e,f] (pdfjs convention).
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

const MAX_LIVE_PAGES = 6;

export function PdfPagesViewer({
  docId,
  sourceType,
  pageRanges,
  highlightSentence,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const pageWrapRefs = useRef<HTMLDivElement[]>([]);
  const wordPillRefs = useRef<HTMLDivElement[]>([]);
  const sentenceOverlayRefs = useRef<HTMLDivElement[]>([]);
  /** Per-page hover-preview sentence layer. Drawn when the mouse is
   *  over that page; cleared on mouseleave. Used only when the
   *  "Highlight sentence" setting is on — matches the existing
   *  sentence-rect rendering's gate so we don't surprise users who
   *  intentionally dimmed sentence tinting. */
  const sentenceHoverOverlayRefs = useRef<HTMLDivElement[]>([]);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  // LRU tracking of rendered pages: most-recently-rendered at end.
  const renderedOrder = useRef<number[]>([]);
  const renderingSet = useRef<Set<number>>(new Set());

  const pagesRef = useRef<PageInfo[]>([]);
  const [pagesReady, setPagesReady] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  // Bumps whenever a page's canvas/items finish rendering, to trigger
  // the overlay-positioning effect.
  const [renderTick, setRenderTick] = useState(0);

  const {
    tokens,
    currentWordIdx,
    clickToListen,
    seekToCharOffset,
  } = useTTS();

  const currentWord = tokens.words[currentWordIdx];
  const currentCharOffset = currentWord?.start ?? 0;
  const currentSentence = currentWord
    ? tokens.sentences[currentWord.sentenceIndex]
    : null;

  // --- Page index from current char offset ------------------------------
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

  // --- Scroll current page into view ------------------------------------
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

  // --- LRU render/evict -------------------------------------------------
  const evictIfNeeded = useCallback(() => {
    while (renderedOrder.current.length > MAX_LIVE_PAGES) {
      // Evict the rendered page farthest from currentPage.
      let farIdx = -1;
      let farDist = -1;
      for (const i of renderedOrder.current) {
        if (i === currentPage) continue;
        const d = Math.abs(i - currentPage);
        if (d > farDist) {
          farDist = d;
          farIdx = i;
        }
      }
      if (farIdx < 0) break;
      const wrap = pageWrapRefs.current[farIdx];
      if (wrap) {
        const canvas = canvasRefs.current[farIdx];
        if (canvas && canvas.parentElement) canvas.parentElement.removeChild(canvas);
        canvasRefs.current[farIdx] = null;
      }
      const page = pagesRef.current[farIdx];
      if (page) page.rendered = false;
      renderedOrder.current = renderedOrder.current.filter((x) => x !== farIdx);
    }
  }, [currentPage]);

  const renderPage = useCallback(async (index: number) => {
    const pdf = pdfRef.current;
    const page = pagesRef.current[index];
    if (!pdf || !page) return;
    if (page.rendered || renderingSet.current.has(index)) return;
    renderingSet.current.add(index);
    try {
      const pdfjs = (await import("pdfjs-dist/build/pdf.mjs")) as unknown as PdfLibType;
      const pdfPage = await pdf.getPage(index + 1);
      const wrap = pageWrapRefs.current[index];
      if (!wrap) return;
      const containerWidth = wrap.clientWidth || page.width;
      const viewport1 = pdfPage.getViewport({ scale: 1 });
      const scale = containerWidth / viewport1.width;
      const viewport = pdfPage.getViewport({ scale });

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);

      // Insert canvas as the first child of the "stack" inside the wrap
      const stack = wrap.querySelector(".pdf-stack") as HTMLDivElement | null;
      if (!stack) return;
      stack.insertBefore(canvas, stack.firstChild);
      canvasRefs.current[index] = canvas;

      await pdfPage.render({ canvasContext: ctx, viewport }).promise;

      // Compute per-item char ranges + bboxes.
      const textContent = await pdfPage.getTextContent();
      const rawItems = textContent.items as PdfItem[];
      const { itemRanges } = assemblePage(rawItems);

      const itemBoxes: ItemBox[] = rawItems.map((item, i) => {
        const r: ItemRange = itemRanges[i];
        const tx = matMul(viewport.transform as number[], item.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]) || 12;
        // pdfjs's own TextLayer positions text at `tx[5] - 0.8 * fontHeight`
        // (font ascent ≈ 0.8 of the em box). Using full fontHeight drops
        // the overlay between lines.
        const fontAscent = fontHeight * 0.8;
        const widthPx = (item.width ?? 0) * scale;
        return {
          localStart: r.start,
          localEnd: r.end,
          x: tx[4],
          y: tx[5] - fontAscent,
          width: Math.max(widthPx, 2),
          height: fontHeight,
        };
      });
      page.items = itemBoxes;
      page.rendered = true;
      // Touch in LRU
      renderedOrder.current = renderedOrder.current.filter((x) => x !== index);
      renderedOrder.current.push(index);
      void pdfjs; // silence unused var lint
      setRenderTick((t) => t + 1);
      evictIfNeeded();
    } catch (err) {
      console.warn(`Failed to render PDF page ${index + 1}:`, err);
    } finally {
      renderingSet.current.delete(index);
    }
  }, [evictIfNeeded]);

  // --- Load PDF, measure all pages, set up placeholders & observer -----
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

    async function run() {
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
        pdfRef.current = pdf;

        const container = containerRef.current;
        if (!container) return;
        const containerWidth = Math.min(container.clientWidth - 32, 880);

        // Measure every page without rendering.
        const infos: PageInfo[] = new Array(pdf.numPages);
        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) return;
          const page = await pdf.getPage(i);
          const vp1 = page.getViewport({ scale: 1 });
          const scale = containerWidth / vp1.width;
          const vp = page.getViewport({ scale });
          infos[i - 1] = {
            pageNum: i,
            width: vp.width,
            height: vp.height,
            items: null,
            rendered: false,
          };
        }
        if (cancelled) return;

        pagesRef.current = infos;
        setPageCount(pdf.numPages);

        // Build placeholder DOM.
        container.innerHTML = "";
        pageWrapRefs.current = new Array(pdf.numPages);
        wordPillRefs.current = new Array(pdf.numPages);
        sentenceOverlayRefs.current = new Array(pdf.numPages);
        sentenceHoverOverlayRefs.current = new Array(pdf.numPages);
        canvasRefs.current = new Array(pdf.numPages).fill(null);

        for (let i = 0; i < infos.length; i++) {
          const info = infos[i];
          const wrap = document.createElement("div");
          wrap.className = "pdf-page-wrap";
          wrap.style.width = `${info.width}px`;
          wrap.dataset.pageIdx = String(i);

          // The stack itself acts as the placeholder (white bg + shadow)
          // until the canvas is rendered into it.
          const stack = document.createElement("div");
          stack.className = "pdf-stack pdf-page-placeholder";
          stack.style.width = `${info.width}px`;
          stack.style.height = `${info.height}px`;

          // Overlay: sentence rects + word pill.
          const overlay = document.createElement("div");
          overlay.className = "pdf-overlay";
          overlay.style.width = `${info.width}px`;
          overlay.style.height = `${info.height}px`;

          // Hover-preview sentence layer goes BELOW the active-sentence
          // layer so when the user hovers their current-read sentence
          // the active rect wins visually (already tinted darker).
          const sentenceHoverLayer = document.createElement("div");
          sentenceHoverLayer.className = "pdf-sentence-hover-layer";
          overlay.appendChild(sentenceHoverLayer);

          const sentenceLayer = document.createElement("div");
          sentenceLayer.className = "pdf-sentence-layer";
          overlay.appendChild(sentenceLayer);

          const wordPill = document.createElement("div");
          wordPill.className = "pdf-word-pill";
          wordPill.style.display = "none";
          overlay.appendChild(wordPill);

          stack.appendChild(overlay);

          // Click layer for hit-testing
          const clickLayer = document.createElement("div");
          clickLayer.className = "pdf-click-layer";
          clickLayer.style.width = `${info.width}px`;
          clickLayer.style.height = `${info.height}px`;
          clickLayer.dataset.pageIdx = String(i);
          stack.appendChild(clickLayer);

          const label = document.createElement("div");
          label.className = "pdf-page-label";
          label.textContent = `Page ${info.pageNum}`;

          wrap.appendChild(stack);
          wrap.appendChild(label);
          container.appendChild(wrap);

          pageWrapRefs.current[i] = wrap;
          wordPillRefs.current[i] = wordPill;
          sentenceOverlayRefs.current[i] = sentenceLayer;
          sentenceHoverOverlayRefs.current[i] = sentenceHoverLayer;
        }

        // IntersectionObserver: render pages that are near viewport
        const io = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                const idx = Number((entry.target as HTMLElement).dataset.pageIdx);
                if (!Number.isNaN(idx)) renderPage(idx);
              }
            }
          },
          { rootMargin: "600px 0px" }
        );
        for (const wrap of pageWrapRefs.current) io.observe(wrap);

        setPagesReady(true);
        setStatus("ready");

        // Kick off initial render of the current page + neighbours.
        const startIdx = Math.max(
          0,
          Math.min(pdf.numPages - 1, currentPage)
        );
        for (let d = 0; d <= 2 && !cancelled; d++) {
          const a = startIdx - d;
          const b = startIdx + d;
          if (a >= 0) renderPage(a);
          if (b !== a && b < pdf.numPages) renderPage(b);
        }

        return () => io.disconnect();
      } catch (err) {
        if (cancelled) return;
        console.error("PDF load failed:", err);
        setError((err as Error).message);
        setStatus("error");
      }
    }

    run();
    return () => {
      cancelled = true;
      renderedOrder.current = [];
      renderingSet.current.clear();
      pagesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, sourceType]);

  // --- Click + hover hit-testing on the click layer ---------------------
  // Click: seek playback to the clicked word.
  // Hover: when `highlightSentence` is on, paint a light sentence-shaped
  //   overlay on the hovered sentence so the user can preview exactly
  //   where clicking will jump to. Gated on `highlightSentence` to match
  //   the existing active-sentence-rect gate — users who dislike
  //   sentence tinting see no hover either.
  useEffect(() => {
    if (!pagesReady) return;
    if (!pageRanges) return;
    const handlers: Array<() => void> = [];

    /** Find the item (word-ish bbox) under (x, y). Try exact hit first,
     *  then fall back to the closest item on the nearest line. */
    const itemAt = (
      items: ItemBox[],
      x: number,
      y: number
    ): ItemBox | undefined => {
      let hit = items.find(
        (it) =>
          x >= it.x &&
          x < it.x + it.width &&
          y >= it.y &&
          y < it.y + it.height + 2
      );
      if (!hit) {
        const rowTol = 8;
        const inRow = items.filter(
          (it) => Math.abs(it.y - y) < it.height + rowTol
        );
        if (inRow.length) {
          hit = inRow.reduce((best, cur) => {
            const bd = Math.min(
              Math.abs(best.x - x),
              Math.abs(best.x + best.width - x)
            );
            const cd = Math.min(
              Math.abs(cur.x - x),
              Math.abs(cur.x + cur.width - x)
            );
            return cd < bd ? cur : best;
          });
        }
      }
      return hit;
    };

    for (let i = 0; i < pageWrapRefs.current.length; i++) {
      const wrap = pageWrapRefs.current[i];
      if (!wrap) continue;
      const click = wrap.querySelector(".pdf-click-layer") as HTMLDivElement | null;
      if (!click) continue;

      const clickHandler = (ev: MouseEvent) => {
        const page = pagesRef.current[i];
        if (!page || !page.items) return;
        const rect = click.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        const hit = itemAt(page.items, x, y);
        if (!hit) return;
        const globalOffset = pageRanges[i].charStart + hit.localStart;
        seekToCharOffset(globalOffset, clickToListen);
      };
      click.addEventListener("click", clickHandler);
      handlers.push(() => click.removeEventListener("click", clickHandler));

      // --- Hover preview (sentence-shaped highlight under the mouse) ---
      // Track the last-drawn sentence index so we only repaint when
      // crossing a sentence boundary — otherwise every pixel of mouse
      // movement would rebuild the overlay DOM.
      let lastHoverSentence = -1;
      const clearHover = () => {
        const overlay = sentenceHoverOverlayRefs.current[i];
        if (overlay) overlay.innerHTML = "";
        lastHoverSentence = -1;
      };

      const moveHandler = (ev: MouseEvent) => {
        if (!highlightSentence) return;
        const page = pagesRef.current[i];
        if (!page || !page.items) return;
        const overlay = sentenceHoverOverlayRefs.current[i];
        if (!overlay) return;
        const rect = click.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        const hit = itemAt(page.items, x, y);
        if (!hit) {
          clearHover();
          return;
        }
        const globalOffset = pageRanges[i].charStart + hit.localStart;
        // Find which sentence this char offset belongs to. Binary-search
        // would be marginal — docs with > 10k sentences are rare, linear
        // scan is <1ms.
        let sIdx = -1;
        for (let s = 0; s < tokens.sentences.length; s++) {
          const sent = tokens.sentences[s];
          if (globalOffset >= sent.start && globalOffset < sent.end) {
            sIdx = s;
            break;
          }
        }
        if (sIdx < 0 || sIdx === lastHoverSentence) return;
        lastHoverSentence = sIdx;

        // Render sentence rects on THIS page only. Cross-page sentence
        // spills are rare and don't need hover preview on the spillover
        // page (the mouse isn't there anyway).
        overlay.innerHTML = "";
        const sent = tokens.sentences[sIdx];
        const sentStart = sent.start - pageRanges[i].charStart;
        const sentEnd = sent.end - pageRanges[i].charStart;
        const rowItems = page.items.filter(
          (it) => it.localEnd > sentStart && it.localStart < sentEnd
        );
        if (!rowItems.length) return;
        const tol = 6;
        const rows: ItemBox[][] = [];
        for (const it of rowItems) {
          const row = rows.find((r) => Math.abs(r[0].y - it.y) <= tol);
          if (row) row.push(it);
          else rows.push([it]);
        }
        for (const row of rows) {
          const xMin = Math.min(...row.map((it) => it.x));
          const xMax = Math.max(...row.map((it) => it.x + it.width));
          const yMin = Math.min(...row.map((it) => it.y));
          const yMax = Math.max(...row.map((it) => it.y + it.height));
          const w = xMax - xMin + 4;
          const h = yMax - yMin + 2;
          if (w <= 1 || h <= 1) continue;
          const rectEl = document.createElement("div");
          rectEl.className = "pdf-sentence-hover-rect";
          rectEl.style.left = `${xMin - 2}px`;
          rectEl.style.top = `${yMin - 1}px`;
          rectEl.style.width = `${w}px`;
          rectEl.style.height = `${h}px`;
          overlay.appendChild(rectEl);
        }
      };
      click.addEventListener("mousemove", moveHandler);
      click.addEventListener("mouseleave", clearHover);
      handlers.push(() => {
        click.removeEventListener("mousemove", moveHandler);
        click.removeEventListener("mouseleave", clearHover);
        clearHover();
      });
    }
    return () => {
      for (const off of handlers) off();
    };
  }, [
    pagesReady,
    pageRanges,
    seekToCharOffset,
    clickToListen,
    highlightSentence,
    tokens.sentences,
  ]);

  // --- Position overlays on the active page ----------------------------
  useEffect(() => {
    if (status !== "ready") return;
    if (!pageRanges) return;

    pageWrapRefs.current.forEach((el, i) => {
      if (!el) return;
      if (i === currentPage) el.classList.add("pdf-page-current");
      else el.classList.remove("pdf-page-current");
    });

    // Hide all pills + clear sentence overlays.
    for (const pill of wordPillRefs.current) if (pill) pill.style.display = "none";
    for (const s of sentenceOverlayRefs.current) if (s) s.innerHTML = "";

    const idx = currentPage;
    const page = pagesRef.current[idx];
    const range = pageRanges[idx];
    if (!page || !page.items || !range) return;

    const localOffset = currentCharOffset - range.charStart;

    // Word pill: find the item containing localOffset. If none, try the
    // last item with localStart <= localOffset.
    let item = page.items.find(
      (it) => localOffset >= it.localStart && localOffset < it.localEnd
    );
    if (!item) {
      for (let i = page.items.length - 1; i >= 0; i--) {
        if (page.items[i].localStart <= localOffset) {
          item = page.items[i];
          break;
        }
      }
    }
    const pill = wordPillRefs.current[idx];
    if (item && pill) {
      pill.style.display = "block";
      pill.style.left = `${item.x}px`;
      pill.style.top = `${item.y}px`;
      pill.style.width = `${item.width}px`;
      pill.style.height = `${item.height}px`;
    }

    // Sentence rects
    if (highlightSentence && currentSentence) {
      const sentStart = currentSentence.start - range.charStart;
      const sentEnd = currentSentence.end - range.charStart;
      const items = page.items.filter(
        (it) => it.localEnd > sentStart && it.localStart < sentEnd
      );
      if (items.length) {
        const tol = 6;
        const rows: ItemBox[][] = [];
        for (const it of items) {
          const row = rows.find((r) => Math.abs(r[0].y - it.y) <= tol);
          if (row) row.push(it);
          else rows.push([it]);
        }
        const overlay = sentenceOverlayRefs.current[idx];
        if (overlay) {
          const addRect = (x: number, y: number, w: number, h: number) => {
            if (w <= 1 || h <= 1) return;
            const rect = document.createElement("div");
            rect.className = "pdf-sentence-rect";
            rect.style.left = `${x}px`;
            rect.style.top = `${y}px`;
            rect.style.width = `${w}px`;
            rect.style.height = `${h}px`;
            overlay.appendChild(rect);
          };

          for (const row of rows) {
            const xMin = Math.min(...row.map((it) => it.x));
            const xMax = Math.max(...row.map((it) => it.x + it.width));
            const yMin = Math.min(...row.map((it) => it.y));
            const yMax = Math.max(...row.map((it) => it.y + it.height));
            const rowH = yMax - yMin + 2;
            const rowY = yMin - 1;

            // If the current word pill lives in this row, split the
            // sentence rect around it so the two overlays don't stack
            // (stacked translucent rects darken the word too much).
            const pillInRow =
              item &&
              Math.abs(item.y - yMin) <= tol &&
              item.x + item.width > xMin &&
              item.x < xMax;

            if (pillInRow && item) {
              const leftEnd = Math.max(xMin - 2, item.x);
              const rightStart = Math.min(xMax + 2, item.x + item.width);
              addRect(xMin - 2, rowY, leftEnd - (xMin - 2), rowH);
              addRect(rightStart, rowY, (xMax + 2) - rightStart, rowH);
            } else {
              addRect(xMin - 2, rowY, xMax - xMin + 4, rowH);
            }
          }
        }
      }
    }
  }, [
    status,
    currentPage,
    currentCharOffset,
    currentSentence,
    highlightSentence,
    pageRanges,
    renderTick,
  ]);

  // --- Ensure the active page is always rendered ------------------------
  useEffect(() => {
    if (!pagesReady) return;
    renderPage(currentPage);
    renderPage(currentPage + 1);
    renderPage(currentPage - 1);
  }, [currentPage, pagesReady, renderPage]);

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
        <div className="text-sm text-[color:var(--muted)] py-8">Loading PDF…</div>
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
