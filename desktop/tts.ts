import { ipcMain, BrowserWindow } from 'electron';
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import { ttsCacheDir } from './modelStore.js';

// Kokoro 82M q8 (~86 MB) runs on onnxruntime-node in this process, keeping the
// render loop free. First use downloads model + voice files into
// <userData>/models/tts (transformers cacheDir); after that she speaks offline.
env.cacheDir = ttsCacheDir();
env.allowLocalModels = false;

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// curated for her — female voices first, then the rest
export const VOICES = [
  'af_heart', 'af_bella', 'af_sky', 'af_nicole', 'af_jessica', 'af_nova', 'af_sarah', 'af_river',
  'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily',
  'am_michael', 'am_fenrir', 'am_puck', 'am_adam', 'bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel',
];

type InitState = { state: 'not-downloaded' | 'downloading' | 'ready' | 'error'; progress?: number; error?: string };
let initState: InitState = { state: 'not-downloaded' };
let tts: KokoroTTS | null = null;
let initPromise: Promise<KokoroTTS> | null = null;
// generation token so a new request supersedes an in-flight one
let genSeq = 0;

function emit(e: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('tts:event', e); } catch { /* gone */ }
  }
}

async function ensureTTS(): Promise<KokoroTTS> {
  if (tts) return tts;
  if (!initPromise) {
    initPromise = (async () => {
      initState = { state: 'downloading', progress: 0 };
      emit(initState);
      try {
        const model = await KokoroTTS.from_pretrained(MODEL_ID, {
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
        } as any);
        tts = model;
        initState = { state: 'ready' };
        emit(initState);
        return model;
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

// sentence-ish chunks so first audio starts fast on long replies
function chunkText(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 280) return clean ? [clean] : [];
  const parts = clean.split(/(?<=[.!?;:,])\s+/);
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + ' ' + p).length > 260 && cur) { out.push(cur.trim()); cur = p; }
    else cur = cur ? cur + ' ' + p : p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.slice(0, 8);
}

function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

async function synthesize(reqId: number, text: string, opts: { voice?: string; rate?: number }): Promise<{ ok: boolean; error?: string }> {
  const model = await ensureTTS();
  const voice = opts.voice || 'af_heart';
  const speed = Math.max(0.7, Math.min(1.3, opts.rate || 1));
  const chunks = chunkText(text);
  if (!chunks.length) return { ok: true };
  const my = ++genSeq;
  for (let i = 0; i < chunks.length; i++) {
    if (my !== genSeq) return { ok: true }; // superseded by a newer request
    const audio: any = await model.generate(chunks[i], { voice: voice as any, speed });
    const f: Float32Array = audio?.audio instanceof Float32Array ? audio.audio : audio?.audio?.audio;
    const rate: number = audio?.sampling_rate ?? audio?.samplingRate ?? 24000;
    if (!f) return { ok: false, error: 'no audio returned' };
    const pcm = floatToInt16(f);
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('tts:chunk', { reqId, pcm, rate, last: i === chunks.length - 1 || my !== genSeq }, [pcm.buffer]); } catch { /* gone */ }
    }
  }
  return { ok: true };
}

export function registerTtsIpc(): void {
  ipcMain.handle('tts:ready', () => ({ ready: initState.state === 'ready', ...initState }));
  ipcMain.handle('tts:voices', () => VOICES);
  ipcMain.handle('tts:synthesize', (_e, reqId: number, text: string, opts: { voice?: string; rate?: number }) => {
    genSeq++; // cancel any in-flight generation before this one starts
    return synthesize(reqId, text, opts || {}).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 200) }));
  });
}
