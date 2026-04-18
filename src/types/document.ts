export type DocumentSummary = {
  id: string;
  title: string;
  sourceType: "pdf" | "epub" | "text";
  originalFilename: string | null;
  wordCount: number;
  charCount: number;
  createdAt: string;
  updatedAt: string;
  collections: Collection[];
  position?: PositionInfo | null;
  progressPercent: number;
};

export type DocumentDetail = DocumentSummary & {
  content: string;
  pageRanges: Array<{ charStart: number; charEnd: number }> | null;
};

export type PositionInfo = {
  charIndex: number;
  rate: number;
  voiceName: string | null;
  updatedAt: string;
};

export type Collection = {
  id: string;
  name: string;
  createdAt?: string;
  documentCount?: number;
};
