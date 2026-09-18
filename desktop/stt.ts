import { ipcMain, BrowserWindow } from 'electron';
import { pipeline, env } from '@huggingface/transformers';
import { sttCacheDir } from './modelStore.js';

// Whisper tiny.en q8 (~40 MB) — one-time download into <userData>/models/stt,
// then she listens fully offline. Input is 16 kHz mono Float32 from the
// renderer (MediaRecorder → decodeAudioData → OfflineAudioContext resample).
env.cacheDir = sttCacheDir();
env.allowLocalModels = false;

const MODEL_ID = 'Xenova/whisper-tiny.en';

type InitState = { state: 'not-downloaded' | 'downloading' | 'ready' | 'error'; progress?: number; error?: string };
let initState: InitState = { state: 'not-downloaded' };
let transcriber: ((audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string }>) | null = null;
let initPromise: Promise<void> | null = null;

function emit(e: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('stt:progress', e); } catch { /* gone */ }
  }
}

async function ensure(): Promise<void> {
  if (transcriber) return;
  if (!initPromise) {
    initPromise = (async () => {
      initState = { state: 'downloading', progress: 0 };
      emit(initState);
      try {
        transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
          dtype: 'q8',
          progress_callback: (p: any) => {
            if (p?.status === 'progress' && p.total) {
              initState = { state: 'downloading', progress: p.loaded / p.total };
              emit(initState);
            } else if (p?.status === 'ready' || p?.status === 'done') {
              initState = { state: 'ready' };
              emit(initState);
            }
          },
        } as any) as any;
        initState = { state: 'ready' };
        emit(initState);
      } catch (e: any) {
        initState = { state: 'error', error: String(e?.message || e).slice(0, 200) };
        emit(initState);
        initPromise = null;
        throw e;
      }
    })();
  }
  return initPromise;
}

export function registerSttIpc(): void {
  ipcMain.handle('stt:ensure', () => ensure().then(() => ({ ok: true, ...initState })).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 200) })));
  ipcMain.handle('stt:transcribe', async (_e, pcm: Float32Array) => {
    try {
      await ensure();
      const out = await transcriber!(pcm, { chunk_length_s: 30, stride_length_s: 5 });
      return { text: String(out?.text || '').trim() };
    } catch (e: any) {
      return { text: '', error: String(e?.message || e).slice(0, 200) };
    }
  });
}
