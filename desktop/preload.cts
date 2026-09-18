import { contextBridge, ipcRenderer } from 'electron';

// Sandboxed preload — CJS. Exposes the desktop-only IPC surface the renderer
// feature-detects via window.saphiraDesktop.
const on = (channel: string) => (cb: (data: any) => void) => {
  const listener = (_e: unknown, data: any) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('saphiraDesktop', {
  isDesktop: true,
  appVersion: () => ipcRenderer.invoke('app:version'),

  // ---- brain ----
  brainChat: (payload: unknown) => ipcRenderer.invoke('brain:chat', payload),
  llmCatalog: () => ipcRenderer.invoke('llm:catalog'),
  llmStatus: () => ipcRenderer.invoke('llm:status'),
  llmDownload: (modelId: string) => ipcRenderer.invoke('llm:download', modelId),
  llmSelect: (modelId: string) => ipcRenderer.invoke('llm:select', modelId),
  llmGetDirs: () => ipcRenderer.invoke('llm:getDirs'),
  llmBrowseDir: () => ipcRenderer.invoke('llm:browseDir'),
  onLlmEvent: on('llm:event'),

  // ---- kokoro tts ----
  ttsReady: () => ipcRenderer.invoke('tts:ready'),
  ttsVoices: () => ipcRenderer.invoke('tts:voices'),
  ttsSynthesize: (reqId: number, text: string, opts: unknown) => ipcRenderer.invoke('tts:synthesize', reqId, text, opts),
  onTtsChunk: on('tts:chunk'),
  onTtsEvent: on('tts:event'),

  // ---- whisper stt ----
  sttEnsure: () => ipcRenderer.invoke('stt:ensure'),
  sttTranscribe: (pcm16k: Float32Array) => ipcRenderer.invoke('stt:transcribe', pcm16k),
  onSttProgress: on('stt:progress'),
});
