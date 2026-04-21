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
    prompt_text?: string;
    prompt_duration_s?: number;
    prompt_mel_frames?: number;
    [k: string]: unknown;
  };
  hasSample: boolean;
  /** True iff the server has a prompt_mel.f32 for this voice — gates
   *  whether browser-native inference can use it. */
  hasPromptMel: boolean;
  coverUrl?: string | null;
};
