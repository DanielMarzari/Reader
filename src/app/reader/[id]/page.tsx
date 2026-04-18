import { notFound } from "next/navigation";
import { getDocument } from "@/lib/documents";
import { ReaderClient } from "./ReaderClient";

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
    <ReaderClient
      docId={doc.id}
      title={doc.title}
      sourceType={doc.sourceType}
      wordCount={doc.wordCount}
      content={doc.content}
      initialCharIndex={doc.position?.charIndex ?? 0}
      initialRate={doc.position?.rate ?? 1}
      initialVoiceName={doc.position?.voiceName ?? null}
    />
  );
}
