"use client";

import { useEffect, useRef, useState } from "react";

export type UploadRequest =
  | { kind: "file"; file: File; title?: string }
  | { kind: "text"; text: string; title?: string };

const ACCEPTED_EXTS = [".pdf", ".epub", ".txt", ".md"];
const ACCEPTED_MIME = ["application/pdf", "application/epub+zip", "text/plain"];

function extractTitleFromFilename(name: string): string {
  return name.replace(/\.(pdf|epub|txt|md)$/i, "").replace(/[_-]+/g, " ").trim();
}

function isAccepted(file: File): boolean {
  const lower = file.name.toLowerCase();
  if (ACCEPTED_EXTS.some((ext) => lower.endsWith(ext))) return true;
  if (ACCEPTED_MIME.includes(file.type)) return true;
  if (file.type.startsWith("text/")) return true;
  return false;
}

export function UploadModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (req: UploadRequest) => void;
}) {
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setFile(null);
      setText("");
      setTitle("");
      setTitleTouched(false);
      setError(null);
      setDragging(false);
    }
  }, [open]);

  if (!open) return null;

  function pickFile(f: File | null) {
    setError(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (!isAccepted(f)) {
      setError(`Unsupported file type: ${f.name}. Use PDF, EPUB, TXT, or MD.`);
      setFile(null);
      return;
    }
    setFile(f);
    if (!titleTouched) setTitle(extractTitleFromFilename(f.name));
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) pickFile(f);
  }

  function submit() {
    setError(null);
    if (mode === "file") {
      if (!file) {
        setError("Choose or drop a PDF, EPUB, or text file.");
        return;
      }
      onSubmit({ kind: "file", file, title: title.trim() || undefined });
    } else {
      if (!text.trim()) {
        setError("Paste some text.");
        return;
      }
      onSubmit({ kind: "text", text, title: title.trim() || undefined });
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold">Add to library</h2>
          <button
            onClick={onClose}
            className="text-[color:var(--muted)] hover:text-[color:var(--foreground)] text-2xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex gap-2 mb-4">
          <button
            className={`btn flex-1 ${mode === "file" ? "btn-primary" : ""}`}
            onClick={() => setMode("file")}
          >
            Upload file
          </button>
          <button
            className={`btn flex-1 ${mode === "paste" ? "btn-primary" : ""}`}
            onClick={() => setMode("paste")}
          >
            Paste text
          </button>
        </div>

        {mode === "file" ? (
          <div>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!dragging) setDragging(true);
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setDragging(false);
              }}
              onDrop={onDrop}
              onClick={() => fileInput.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") fileInput.current?.click();
              }}
              className={`cursor-pointer rounded-xl border-2 border-dashed transition-colors text-center py-9 px-4 ${
                dragging
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/10"
                  : "border-[color:var(--border)] bg-[color:var(--surface-2)]/40 hover:bg-[color:var(--surface-2)]"
              }`}
            >
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                accept=".pdf,.epub,.txt,.md,application/pdf,application/epub+zip,text/plain"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
              <svg
                className="mx-auto mb-2 text-[color:var(--muted)]"
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M17 8 L12 3 L7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              {file ? (
                <>
                  <div className="font-medium text-sm truncate">{file.name}</div>
                  <div className="text-xs text-[color:var(--muted)] mt-1">
                    {(file.size / 1024).toFixed(0)} KB · click to replace
                  </div>
                </>
              ) : (
                <>
                  <div className="font-medium text-sm">
                    {dragging ? "Drop to upload" : "Drag & drop or click to choose"}
                  </div>
                  <div className="text-xs text-[color:var(--muted)] mt-1">
                    PDF · EPUB · TXT · MD
                  </div>
                </>
              )}
            </div>

            <label className="block text-sm mt-4 mb-1 text-[color:var(--muted)]">
              Document name
            </label>
            <input
              className="input w-full"
              placeholder={file ? "" : "Choose a file first"}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleTouched(true);
              }}
            />
          </div>
        ) : (
          <div>
            <label className="block text-sm mb-1 text-[color:var(--muted)]">
              Document name
            </label>
            <input
              className="input w-full mb-3"
              placeholder="Enter a title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleTouched(true);
              }}
            />
            <label className="block text-sm mb-1 text-[color:var(--muted)]">Text</label>
            <textarea
              className="input w-full h-48 font-sans"
              placeholder="Paste your text here…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        )}

        {error && <div className="mt-3 text-sm text-red-500">{error}</div>}

        <div className="flex gap-2 justify-end mt-6">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={mode === "file" ? !file : !text.trim()}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
