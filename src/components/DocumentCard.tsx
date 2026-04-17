"use client";

import Link from "next/link";
import type { DocumentSummary } from "@/types/document";

function formatDate(iso: string): string {
  const d = new Date(iso + (iso.endsWith("Z") ? "" : "Z"));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function humanWords(n: number) {
  if (n < 1000) return `${n} words`;
  return `${(n / 1000).toFixed(1)}k words`;
}

const TYPE_BADGE: Record<string, string> = {
  pdf: "PDF",
  epub: "EPUB",
  text: "TEXT",
};

export function DocumentCard({
  doc,
  onDelete,
  view,
}: {
  doc: DocumentSummary;
  onDelete: (id: string) => void;
  view: "grid" | "list";
}) {
  if (view === "list") {
    return (
      <div className="flex items-center gap-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-3 hover:bg-[color:var(--surface-2)] transition-colors">
        <Link href={`/reader/${doc.id}`} className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <span className="inline-block rounded-md px-2 py-0.5 text-[10px] font-bold bg-[color:var(--accent)]/15 text-[color:var(--accent)] border border-[color:var(--accent)]/30">
              {TYPE_BADGE[doc.sourceType] ?? doc.sourceType.toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{doc.title}</div>
              <div className="flex gap-3 text-xs text-[color:var(--muted)] mt-0.5">
                <span>{humanWords(doc.wordCount)}</span>
                <span>Added {formatDate(doc.createdAt)}</span>
                <span className="text-[color:var(--accent)]">{doc.progressPercent}%</span>
              </div>
            </div>
          </div>
        </Link>
        <button
          onClick={() => onDelete(doc.id)}
          className="text-[color:var(--muted)] hover:text-red-500 px-2 py-1 text-sm"
          aria-label="Delete"
          title="Delete"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="group relative rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] overflow-hidden hover:border-[color:var(--accent)]/50 transition-colors">
      <Link href={`/reader/${doc.id}`} className="block p-4 pr-10">
        <div className="h-24 rounded-md bg-gradient-to-br from-[color:var(--surface-2)] to-[color:var(--surface)] border border-[color:var(--border)] mb-3 flex items-center justify-center">
          <span className="text-2xl font-bold text-[color:var(--muted)]">
            {TYPE_BADGE[doc.sourceType] ?? doc.sourceType.toUpperCase()}
          </span>
        </div>
        <div className="font-medium line-clamp-2 mb-1">{doc.title}</div>
        <div className="text-xs text-[color:var(--muted)] mb-2">
          {humanWords(doc.wordCount)} · {formatDate(doc.createdAt)}
        </div>
        <div className="h-1 rounded-full bg-[color:var(--surface-2)] overflow-hidden">
          <div
            className="h-full bg-[color:var(--accent)]"
            style={{ width: `${doc.progressPercent}%` }}
          />
        </div>
      </Link>
      <button
        onClick={() => onDelete(doc.id)}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity rounded-md bg-[color:var(--surface-2)] hover:bg-red-500 hover:text-white px-2 py-1 text-xs"
        aria-label="Delete"
      >
        ✕
      </button>
    </div>
  );
}
