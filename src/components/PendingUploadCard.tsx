"use client";

export type PendingUpload = {
  tempId: string;
  name: string;
  status: "uploading" | "error";
  error?: string;
};

export function PendingUploadCard({
  upload,
  onDismiss,
  view,
}: {
  upload: PendingUpload;
  onDismiss: (id: string) => void;
  view: "grid" | "list";
}) {
  const isError = upload.status === "error";
  const statusLabel = isError ? "Failed" : "Uploading…";

  if (view === "list") {
    return (
      <div
        className={`flex items-center gap-4 rounded-lg border p-3 ${
          isError
            ? "border-red-500/40 bg-red-500/5"
            : "border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5"
        }`}
      >
        <span
          className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-bold border ${
            isError
              ? "bg-red-500/15 text-red-500 border-red-500/30"
              : "bg-[color:var(--accent)]/15 text-[color:var(--accent)] border-[color:var(--accent)]/30"
          }`}
        >
          {statusLabel}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{upload.name}</div>
          {isError ? (
            <div className="text-xs text-red-500 truncate mt-0.5">{upload.error}</div>
          ) : (
            <div className="h-1 rounded-full bg-[color:var(--surface-2)] overflow-hidden mt-1.5">
              <div className="h-full bg-[color:var(--accent)] animate-pulse" style={{ width: "60%" }} />
            </div>
          )}
        </div>
        {isError && (
          <button
            onClick={() => onDismiss(upload.tempId)}
            className="text-[color:var(--muted)] hover:text-red-500 px-2 py-1 text-sm"
            aria-label="Dismiss"
          >
            ✕
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`relative rounded-xl border overflow-hidden p-4 ${
        isError
          ? "border-red-500/40 bg-red-500/5"
          : "border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5"
      }`}
    >
      <div
        className={`h-24 rounded-md border mb-3 flex items-center justify-center ${
          isError
            ? "border-red-500/30 bg-red-500/10"
            : "border-[color:var(--accent)]/30 bg-[color:var(--accent)]/10"
        }`}
      >
        <span className={`text-sm font-bold ${isError ? "text-red-500" : "text-[color:var(--accent)]"}`}>
          {statusLabel}
        </span>
      </div>
      <div className="font-medium line-clamp-2 mb-1">{upload.name}</div>
      {isError ? (
        <div className="text-xs text-red-500 line-clamp-2">{upload.error}</div>
      ) : (
        <div className="h-1 rounded-full bg-[color:var(--surface-2)] overflow-hidden mt-1">
          <div className="h-full bg-[color:var(--accent)] animate-pulse" style={{ width: "60%" }} />
        </div>
      )}
      {isError && (
        <button
          onClick={() => onDismiss(upload.tempId)}
          className="absolute top-2 right-2 rounded-md bg-[color:var(--surface-2)] hover:bg-red-500 hover:text-white px-2 py-1 text-xs"
          aria-label="Dismiss"
        >
          ✕
        </button>
      )}
    </div>
  );
}
