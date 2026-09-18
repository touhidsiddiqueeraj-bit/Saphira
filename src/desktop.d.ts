// Desktop bridge ambient declarations — populated by desktop/preload.cts when
// running inside Electron. In a plain browser (or the future Capacitor APK)
// `window.saphiraDesktop` is undefined and the app behaves like the web lite.

export type LlmModelState = 'not-downloaded' | 'downloading' | 'loading' | 'ready' | 'error';
export type LlmCatalogEntry = {
  id: string;
  label: string;
  file: string;          // GGUF filename in userData/models/llm
  url: string;           // HuggingFace resolve URL
  bytes: number;         // approx download size
  recommended?: boolean;
};
export type LlmStatus = {
  models: (LlmCatalogEntry & { state: LlmModelState; progress?: number })[];
  activeId: string | null;
  error?: string;
};
export type BrainChatPayload = {
  mode: 'cloud' | 'local';
  baseUrl?: string;      // cloud: OpenAI-compatible base (…/v1)
  apiKey?: string;       // cloud
  model?: string;        // cloud model id / local is the active GGUF
  system: string;        // persona + JSON contract
  history: { role: 'user' | 'assistant'; content: string }[];
  user: string;
  images?: string[]; // data URLs for vision turns
};
export type TtsOpts = { voice: string; rate: number };

export type SaphiraDesktopApi = {
  isDesktop: true;
  appVersion(): Promise<string>;
  // ---- brain ----
  brainChat(payload: BrainChatPayload): Promise<{ text: string }>;
  llmCatalog(): Promise<LlmCatalogEntry[]>;
  llmStatus(): Promise<LlmStatus>;
  llmDownload(modelId: string): Promise<{ ok: boolean; error?: string }>;
  llmSelect(modelId: string): Promise<{ ok: boolean; error?: string }>;
  llmGetDirs(): Promise<string[]>;
  llmBrowseDir(): Promise<{ ok: boolean; dirs?: string[] }>;
  onLlmEvent(cb: (e: { type: 'progress' | 'state'; modelId: string; progress?: number; state?: LlmModelState; error?: string }) => void): () => void;
  // ---- kokoro tts ----
  ttsSynthesize(reqId: number, text: string, opts: TtsOpts): Promise<{ ok: boolean; error?: string }>;
  onTtsChunk(cb: (c: { reqId: number; pcm: Int16Array; rate: number; last: boolean }) => void): () => void;
  ttsVoices(): Promise<string[]>;
  onTtsEvent(cb: (e: { state: string; progress?: number; error?: string }) => void): () => void;
  ttsReady(): Promise<{ ready: boolean; progress?: number; error?: string }>;
  // ---- whisper stt ----
  sttEnsure(): Promise<{ ok: boolean; progress?: number; error?: string }>;
  sttTranscribe(pcm16k: Float32Array): Promise<{ text: string }>;
  onSttProgress(cb: (p: { progress?: number; state: string; error?: string }) => void): () => void;
};

declare global {
  const __SAPHIRA_DESKTOP__: boolean;
  interface Window {
    saphiraDesktop?: SaphiraDesktopApi;
  }
}
