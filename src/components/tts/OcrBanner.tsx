"use client";

// Auto-OCR banner that replaces the static "scanned PDF — re-upload
// with OCR" hint.
//
// When the current document has no extractable text (`hasText` from
// useTTS() is false), we POST /api/documents/:id/ocr once on mount to
// trigger server-side ocrmypdf, then poll GET /api/documents/:id/ocr
// every 2s until the job transitions out of "running". On "done", the
// client hard-reloads so the Pages viewer re-fetches the (now
// text-bearing) stored PDF and the tokenizer sees real words.
//
// Non-PDFs with no text: we show a plain "no readable text" message
// since OCR doesn't apply to EPUBs or plain text uploads.

import { useEffect, useRef, useState } from "react";
import { useTTS } from "./TTSContext";

type OcrStatus =
  | { status: "idle" }
  | { status: "running"; startedAt: number }
  | { status: "done"; completedAt: number; wordCount: number }
  | { status: "failed"; completedAt: number; error: string }
  | { status: "unavailable"; reason: string };

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

export function OcrBanner({
  docId,
  sourceType,
}: {
  docId: string;
  sourceType: "pdf" | "epub" | "text";
}) {
  const { hasText } = useTTS();
  const [status, setStatus] = useState<OcrStatus | null>(null);
  const [tick, setTick] = useState(0); // re-render every second while "running" so the elapsed timer ticks
  const triggeredRef = useRef(false);

  // Drive the elapsed-time readout.
  useEffect(() => {
    if (status?.status !== "running") return;
    const h = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(h);
  }, [status?.status]);

  useEffect(() => {
    if (hasText) return;
    if (sourceType !== "pdf") return;
    if (triggeredRef.current) return;
    triggeredRef.current = true;

    let cancelled = false;
    let pollHandle: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(`/api/documents/${docId}/ocr`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = (await res.json()) as OcrStatus;
        if (cancelled) return;
        setStatus(next);
        if (next.status === "done") {
          console.log(
            `[OCR] ${docId}: complete (${next.wordCount} words) — reloading`
          );
          if (pollHandle) clearInterval(pollHandle);
          // Hard reload so the Pages viewer re-fetches the (now
          // text-bearing) stored PDF. router.refresh() would update the
          // server component but leave PdfPagesViewer's cached PDF in
          // place, since its effect deps ([docId, sourceType]) don't
          // change across refreshes.
          window.location.reload();
        } else if (
          next.status === "failed" ||
          next.status === "unavailable"
        ) {
          if (pollHandle) clearInterval(pollHandle);
        }
      } catch (err) {
        console.warn("[OCR] status poll failed:", err);
      }
    };

    (async () => {
      try {
        console.log(`[OCR] ${docId}: triggering auto-OCR`);
        const res = await fetch(`/api/documents/${docId}/ocr`, {
          method: "POST",
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const first = (await res.json()) as OcrStatus;
        if (cancelled) return;
        setStatus(first);
        console.log(`[OCR] ${docId}: trigger returned`, first);

        if (first.status === "running") {
          pollHandle = setInterval(poll, 2000);
        } else if (first.status === "done") {
          window.location.reload();
        }
      } catch (err) {
        if (cancelled) return;
        console.warn("[OCR] trigger failed:", err);
        setStatus({
          status: "failed",
          completedAt: Date.now(),
          error: String((err as Error).message ?? err),
        });
      }
    })();

    return () => {
      cancelled = true;
      if (pollHandle) clearInterval(pollHandle);
    };
  }, [docId, sourceType, hasText]);

  // Document already has text — nothing to show.
  if (hasText) return null;

  // Non-PDF with no text: static notice. OCR doesn't apply.
  if (sourceType !== "pdf") {
    return (
      <Banner tone="amber" icon="info">
        No readable text in this document.
      </Banner>
    );
  }

  // PDF path: status-driven UI.
  if (!status || status.status === "idle") {
    return <Banner tone="blue" icon="spinner">Preparing OCR…</Banner>;
  }

  if (status.status === "running") {
    void tick; // re-run on tick to refresh elapsed display
    const elapsed = Date.now() - status.startedAt;
    return (
      <Banner tone="blue" icon="spinner">
        Running OCR on scanned PDF… {formatElapsed(elapsed)}
      </Banner>
    );
  }

  if (status.status === "unavailable") {
    return (
      <Banner tone="amber" icon="info">
        OCR isn&rsquo;t available for this document
        {status.reason ? ` (${status.reason})` : ""}.
      </Banner>
    );
  }

  if (status.status === "failed") {
    return (
      <Banner tone="red" icon="alert">
        OCR failed: {status.error || "unknown error"}
      </Banner>
    );
  }

  // status === "done" but hasText is still false — brief flash before
  // the window reload hides everything. Show a neutral "finalizing"
  // state rather than nothing.
  return <Banner tone="blue" icon="spinner">Finalizing OCR…</Banner>;
}

type Tone = "amber" | "blue" | "red";
type Icon = "info" | "spinner" | "alert";

function Banner({
  tone,
  icon,
  children,
}: {
  tone: Tone;
  icon: Icon;
  children: React.ReactNode;
}) {
  const toneClasses: Record<Tone, string> = {
    amber:
      "border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-500/40 text-amber-900 dark:text-amber-200",
    blue: "border-blue-300/60 bg-blue-50 dark:bg-blue-950/40 dark:border-blue-500/40 text-blue-900 dark:text-blue-200",
    red: "border-red-300/60 bg-red-50 dark:bg-red-950/40 dark:border-red-500/40 text-red-900 dark:text-red-200",
  };
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-2 rounded-lg border px-3 py-2 text-[11px] flex items-start gap-2 ${toneClasses[tone]}`}
    >
      <span className="shrink-0 mt-[1px]" aria-hidden="true">
        {icon === "info" && (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        )}
        {icon === "spinner" && (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="animate-spin"
          >
            <circle cx="12" cy="12" r="9" opacity="0.25" />
            <path d="M12 3 A9 9 0 0 1 21 12" strokeLinecap="round" />
          </svg>
        )}
        {icon === "alert" && (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
        )}
      </span>
      <span className="flex-1">{children}</span>
    </div>
  );
}
