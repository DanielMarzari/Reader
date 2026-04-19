// Client-side shape of a Voice Lab voice profile (subset of what
// /api/voices returns — enough for the reader's voice picker).
export type ReaderVoice = {
  id: string;
  name: string;
  kind: string;
  engine: string;
  createdAt: string;
  design: {
    description?: string;
    colors?: string[];
    [k: string]: unknown;
  };
  hasSample: boolean;
  coverUrl?: string | null;
};
