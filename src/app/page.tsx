"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { DocumentSummary, Collection } from "@/types/document";
import { UploadModal, type UploadRequest } from "@/components/UploadModal";
import { DocumentCard } from "@/components/DocumentCard";
import { PendingUploadCard, type PendingUpload } from "@/components/PendingUploadCard";

type SortKey = "recent" | "title" | "type";

export default function LibraryPage() {
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [collections, setCollections] = useState<(Collection & { documentCount: number })[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [search, setSearch] = useState("");
  const [activeCollection, setActiveCollection] = useState<string | null>(null);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [newCollName, setNewCollName] = useState("");
  const [addingColl, setAddingColl] = useState(false);

  async function loadAll() {
    setLoading(true);
    const [d, c] = await Promise.all([
      fetch("/api/documents").then((r) => r.json()),
      fetch("/api/collections").then((r) => r.json()),
    ]);
    setDocs(d.documents ?? []);
    setCollections(c.collections ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function startUpload(req: UploadRequest) {
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const name =
      req.kind === "file"
        ? req.title || req.file.name
        : req.title || req.text.slice(0, 60).replace(/\s+/g, " ") + (req.text.length > 60 ? "…" : "");
    setPending((p) => [{ tempId, name, status: "uploading" }, ...p]);

    try {
      let res: Response;
      if (req.kind === "file") {
        const fd = new FormData();
        fd.append("file", req.file);
        if (req.title) fd.append("title", req.title);
        res = await fetch("/api/documents", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: req.text, title: req.title }),
        });
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Upload failed (${res.status})`);
      }
      await res.json();
      // Remove the pending entry and reload list
      setPending((p) => p.filter((x) => x.tempId !== tempId));
      loadAll();
    } catch (err) {
      setPending((p) =>
        p.map((x) =>
          x.tempId === tempId
            ? { ...x, status: "error", error: (err as Error).message }
            : x
        )
      );
    }
  }

  function dismissPending(tempId: string) {
    setPending((p) => p.filter((x) => x.tempId !== tempId));
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this document? This cannot be undone.")) return;
    await fetch(`/api/documents/${id}`, { method: "DELETE" });
    setDocs((d) => d.filter((x) => x.id !== id));
  }

  async function handleNewCollection() {
    const name = newCollName.trim();
    if (!name) return;
    const res = await fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      setNewCollName("");
      setAddingColl(false);
      loadAll();
    }
  }

  async function handleDeleteCollection(id: string) {
    if (!confirm("Delete this collection? (Documents are not deleted.)")) return;
    await fetch(`/api/collections/${id}`, { method: "DELETE" });
    if (activeCollection === id) setActiveCollection(null);
    loadAll();
  }

  const filtered = useMemo(() => {
    let list = docs;
    if (activeCollection) {
      list = list.filter((d) => d.collections.some((c) => c.id === activeCollection));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((d) => d.title.toLowerCase().includes(q));
    }
    const copy = [...list];
    if (sortKey === "title") copy.sort((a, b) => a.title.localeCompare(b.title));
    else if (sortKey === "type")
      copy.sort((a, b) => a.sourceType.localeCompare(b.sourceType));
    else copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return copy;
  }, [docs, search, activeCollection, sortKey]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 bg-[color:var(--background)]/85 backdrop-blur border-b border-[color:var(--border)]">
        <div className="flex items-center justify-between gap-3 px-5 py-3 max-w-[1400px] mx-auto">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-[color:var(--accent)] flex items-center justify-center text-white font-bold">
              R
            </div>
            <h1 className="text-lg font-bold">Reader</h1>
          </div>
          <div className="flex-1 max-w-md">
            <input
              className="input w-full"
              placeholder="Search library…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>
            + New
          </button>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto flex">
        <aside className="w-60 shrink-0 border-r border-[color:var(--border)] p-4 hidden md:block">
          <Link
            href="/voice-lab"
            className="w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm mb-4 hover:bg-[color:var(--surface)] border border-[color:var(--border)]"
          >
            <span className="voice-lab-dot" aria-hidden />
            Voice Lab
          </Link>
          <div className="text-xs uppercase tracking-wider text-[color:var(--muted)] mb-2">
            Library
          </div>
          <button
            onClick={() => setActiveCollection(null)}
            className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors mb-1 ${
              !activeCollection
                ? "bg-[color:var(--surface-2)] font-medium"
                : "hover:bg-[color:var(--surface)]"
            }`}
          >
            All files
            <span className="float-right text-[color:var(--muted)] text-xs">{docs.length}</span>
          </button>

          <div className="text-xs uppercase tracking-wider text-[color:var(--muted)] mt-5 mb-2 flex items-center justify-between">
            Collections
            <button
              onClick={() => setAddingColl((x) => !x)}
              className="text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
              title="New collection"
            >
              +
            </button>
          </div>

          {addingColl && (
            <div className="mb-2 flex gap-1">
              <input
                autoFocus
                className="input flex-1 text-sm py-1"
                placeholder="Name…"
                value={newCollName}
                onChange={(e) => setNewCollName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleNewCollection()}
              />
              <button className="btn btn-primary text-sm px-2 py-1" onClick={handleNewCollection}>
                ✓
              </button>
            </div>
          )}

          {collections.map((c) => (
            <div key={c.id} className="group flex items-center">
              <button
                onClick={() => setActiveCollection(c.id)}
                className={`flex-1 text-left rounded-md px-3 py-2 text-sm transition-colors truncate ${
                  activeCollection === c.id
                    ? "bg-[color:var(--surface-2)] font-medium"
                    : "hover:bg-[color:var(--surface)]"
                }`}
              >
                {c.name}
                <span className="float-right text-[color:var(--muted)] text-xs">
                  {c.documentCount}
                </span>
              </button>
              <button
                onClick={() => handleDeleteCollection(c.id)}
                className="opacity-0 group-hover:opacity-100 text-[color:var(--muted)] hover:text-red-500 px-2 text-xs"
                aria-label="Delete collection"
              >
                ✕
              </button>
            </div>
          ))}
          {collections.length === 0 && !addingColl && (
            <div className="text-xs text-[color:var(--muted)] mt-1">None yet.</div>
          )}
        </aside>

        <main className="flex-1 p-5 min-w-0">
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div className="text-[color:var(--muted)] text-sm">
              {filtered.length} {filtered.length === 1 ? "item" : "items"}
              {pending.length > 0 && (
                <span> · {pending.filter((p) => p.status === "uploading").length} uploading</span>
              )}
              {activeCollection && (
                <span> in {collections.find((c) => c.id === activeCollection)?.name}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <select
                className="select text-sm"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
              >
                <option value="recent">Recently updated</option>
                <option value="title">Title A–Z</option>
                <option value="type">Type</option>
              </select>
              <div className="inline-flex rounded-lg border border-[color:var(--border)] overflow-hidden">
                <button
                  onClick={() => setView("grid")}
                  className={`px-3 py-1 text-sm ${view === "grid" ? "bg-[color:var(--surface-2)]" : ""}`}
                >
                  ⊞
                </button>
                <button
                  onClick={() => setView("list")}
                  className={`px-3 py-1 text-sm border-l border-[color:var(--border)] ${
                    view === "list" ? "bg-[color:var(--surface-2)]" : ""
                  }`}
                >
                  ≡
                </button>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="text-[color:var(--muted)] text-sm py-16 text-center">Loading…</div>
          ) : filtered.length === 0 && pending.length === 0 ? (
            <div className="text-center py-20">
              <div className="text-5xl mb-3 opacity-50">📚</div>
              <div className="text-lg font-medium mb-1">No documents yet</div>
              <div className="text-sm text-[color:var(--muted)] mb-4">
                Upload a PDF, EPUB, or paste text to get started.
              </div>
              <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>
                Add your first document
              </button>
            </div>
          ) : view === "grid" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {pending.map((p) => (
                <PendingUploadCard key={p.tempId} upload={p} onDismiss={dismissPending} view="grid" />
              ))}
              {filtered.map((d) => (
                <DocumentCard key={d.id} doc={d} onDelete={handleDelete} view="grid" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {pending.map((p) => (
                <PendingUploadCard key={p.tempId} upload={p} onDismiss={dismissPending} view="list" />
              ))}
              {filtered.map((d) => (
                <DocumentCard key={d.id} doc={d} onDelete={handleDelete} view="list" />
              ))}
            </div>
          )}
        </main>
      </div>

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSubmit={startUpload}
      />
    </div>
  );
}
