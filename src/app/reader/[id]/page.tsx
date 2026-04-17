import Link from "next/link";
import { notFound } from "next/navigation";
import { getDocument } from "@/lib/documents";
import { TTSPlayer } from "@/components/TTSPlayer";

export const dynamic = "force-dynamic";

export default async function ReaderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const doc = getDocument(id);
  if (!doc) notFound();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 bg-[color:var(--background)]/85 backdrop-blur border-b border-[color:var(--border)]">
        <div className="flex items-center gap-3 px-5 py-3 max-w-[1400px] mx-auto">
          <Link href="/" className="btn">
            ← Library
          </Link>
          <div className="flex-1 min-w-0">
            <div className="truncate font-medium">{doc.title}</div>
            <div className="text-xs text-[color:var(--muted)]">
              {doc.sourceType.toUpperCase()} · {doc.wordCount.toLocaleString()} words
              {doc.progressPercent > 0 ? ` · ${doc.progressPercent}% read` : ""}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto">
        <TTSPlayer
          docId={doc.id}
          content={doc.content}
          initialCharIndex={doc.position?.charIndex ?? 0}
          initialRate={doc.position?.rate ?? 1}
          initialVoiceName={doc.position?.voiceName ?? null}
        />
      </main>
    </div>
  );
}
