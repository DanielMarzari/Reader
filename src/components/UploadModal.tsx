"use client";

import { useRef, useState } from "react";

export function UploadModal({
  open,
  onClose,
  onUploaded,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: (id: string) => void;
}) {
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  if (!open) return null;

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      let res: Response;
      if (mode === "file") {
        if (!file) {
          setError("Choose a PDF, EPUB, or text file.");
          setBusy(false);
          return;
        }
        const fd = new FormData();
        fd.append("file", file);
        if (title.trim()) fd.append("title", title.trim());
        res = await fetch("/api/documents", { method: "POST", body: fd });
      } else {
        if (!text.trim()) {
          setError("Paste some text.");
          setBusy(false);
          return;
        }
        res = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, title: title.trim() || undefined }),
        });
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Upload failed (${res.status})`);
      }
      const j = await res.json();
      onUploaded(j.id);
      setFile(null);
      setText("");
      setTitle("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
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

        <label className="block text-sm mb-1 text-[color:var(--muted)]">
          Title (optional)
        </label>
        <input
          className="input w-full mb-4"
          placeholder={mode === "file" ? "Auto-detected from file" : "Enter a title"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        {mode === "file" ? (
          <div>
            <label className="block text-sm mb-1 text-[color:var(--muted)]">File</label>
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.epub,.txt,.md,application/pdf,application/epub+zip,text/plain"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-[color:var(--border)] file:bg-[color:var(--surface-2)] file:px-3 file:py-2 file:text-sm file:cursor-pointer"
            />
            <p className="text-xs text-[color:var(--muted)] mt-2">
              Supported: PDF, EPUB, TXT, MD
            </p>
          </div>
        ) : (
          <div>
            <label className="block text-sm mb-1 text-[color:var(--muted)]">
              Text
            </label>
            <textarea
              className="input w-full h-48 font-sans"
              placeholder="Paste your text here…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        )}

        {error && (
          <div className="mt-3 text-sm text-red-500">{error}</div>
        )}

        <div className="flex gap-2 justify-end mt-6">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "Uploading…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
